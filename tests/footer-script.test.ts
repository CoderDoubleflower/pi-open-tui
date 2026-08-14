import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
	buildFooterScriptInput,
	executeFooterScript,
	FooterScriptRunner,
	sanitizeFooterScriptOutput,
	type FooterScriptInputV1,
} from "../extensions/open-tui/footer-script.ts";
import { emptyGitStatus } from "../extensions/open-tui/git.ts";
import type { FooterState } from "../extensions/open-tui/state.ts";

function baseInput(overrides: Partial<FooterScriptInputV1> = {}): FooterScriptInputV1 {
	return {
		version: 1,
		terminal: { width: 80 },
		time: { nowMs: 1_000, nowIso: new Date(1_000).toISOString() },
		session: { cwd: process.cwd(), name: null, startedAtMs: 100 },
		model: {
			id: "gpt-5",
			name: "GPT-5",
			provider: "openai",
			reasoning: true,
			thinkingLevel: "high",
			contextWindow: 200_000,
		},
		context: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
		usage: {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			cost: 0.5,
			latestCacheHitRate: 37.5,
		},
		git: { ...emptyGitStatus(), branch: null },
		runtime: { name: "nodejs", version: "24.6.0" },
		timer: {
			working: false,
			workingSinceMs: null,
			workingElapsedMs: null,
			lastDoneInMs: 250,
		},
		extensionStatuses: {},
		...overrides,
	};
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("builds the complete versioned footer script input", () => {
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main", modified: 2 },
		runtime: { name: "nodejs", version: "24.6.0" },
		sessionStartEpoch: 100,
		workingSince: 900,
		lastDoneIn: undefined,
	};
	const ctx = {
		model: {
			id: "gpt-5",
			name: "GPT-5",
			provider: "openai",
			reasoning: true,
			contextWindow: 200_000,
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getSessionName: () => "session-name",
			getEntries: () => [],
		},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
	} as unknown as ExtensionContext;
	const footerData = {
		getExtensionStatuses: () => new Map([["z-last", "z"], ["a-first", "a"]]),
	} as unknown as ReadonlyFooterDataProvider;

	const input = buildFooterScriptInput(
		ctx,
		state,
		{ provider: "OpenAI", model: "GPT-5", effort: "high" },
		footerData,
		120,
		1_000,
	);

	assert.equal(input.version, 1);
	assert.deepEqual(input.terminal, { width: 120 });
	assert.equal(input.session.cwd, "/work/project");
	assert.equal(input.model.thinkingLevel, "high");
	assert.equal(input.git.modified, 2);
	assert.deepEqual(input.timer, {
		working: true,
		workingSinceMs: 900,
		workingElapsedMs: 100,
		lastDoneInMs: null,
	});
	assert.deepEqual(Object.keys(input.extensionStatuses), ["a-first", "z-last"]);
});

test("executes an absolute executable directly and writes JSON to stdin", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-open-tui-script-"));
	const script = join(dir, "footer.sh");
	const slowScript = join(dir, "slow-footer.sh");
	try {
		writeFileSync(script, "#!/bin/sh\ncat\n", "utf8");
		chmodSync(script, 0o755);
		writeFileSync(slowScript, "#!/bin/sh\nexec sleep 1\n", "utf8");
		chmodSync(slowScript, 0o755);
		const input = baseInput();
		const stdout = await executeFooterScript(script, input);
		assert.deepEqual(JSON.parse(stdout), input);
		await assert.rejects(
			executeFooterScript("relative-footer.sh", input),
			/footerScript must be an absolute path/,
		);
		await assert.rejects(executeFooterScript(slowScript, input, 20), /timed out after 20ms/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preserves SGR colors and removes other terminal controls", () => {
	const output = [
		"\x1b[31mred\x1b[0m\ttext",
		"\x1b]0;title\x07second\x1b[2J",
		"",
	].join("\n");
	assert.deepEqual(sanitizeFooterScriptOutput(output), [
		"\x1b[31mred\x1b[0m    text\x1b[0m",
		"second",
	]);
	assert.deepEqual(sanitizeFooterScriptOutput("\x1b[31munclosed"), ["\x1b[31munclosed\x1b[0m"]);
	assert.deepEqual(sanitizeFooterScriptOutput("\n\n"), []);
});

test("caches output, refreshes changed state, and warns once per failure streak", async () => {
	let call = 0;
	let renders = 0;
	const warnings: string[] = [];
	const runner = new FooterScriptRunner({
		execute: async () => {
			call++;
			if (call === 1) return "first";
			throw new Error("failed");
		},
		notifyWarning: (message) => warnings.push(message),
		requestRender: () => renders++,
	});

	const first = baseInput();
	assert.equal(runner.render("/footer", first, 80), undefined);
	await flushPromises();
	assert.deepEqual(runner.render("/footer", first, 80), ["first"]);
	assert.equal(renders, 1);

	const changed = baseInput({ terminal: { width: 81 } });
	assert.deepEqual(runner.render("/footer", changed, 80), ["first"]);
	await flushPromises();
	assert.deepEqual(runner.render("/footer", changed, 80), ["first"]);
	assert.equal(warnings.length, 1);

	const changedAgain = baseInput({ terminal: { width: 82 } });
	runner.render("/footer", changedAgain, 80);
	await flushPromises();
	assert.equal(warnings.length, 1);
	runner.dispose();
});

test("refreshes a working footer no more than once per second", async () => {
	let now = 0;
	let calls = 0;
	const runner = new FooterScriptRunner({
		execute: async () => `${++calls}`,
		notifyWarning() {},
		requestRender() {},
		now: () => now,
	});
	const input = baseInput({
		timer: {
			working: true,
			workingSinceMs: 0,
			workingElapsedMs: 0,
			lastDoneInMs: null,
		},
	});

	runner.render("/footer", input, 80);
	await flushPromises();
	now = 999;
	runner.render("/footer", { ...input, time: { nowMs: now, nowIso: new Date(now).toISOString() } }, 80);
	await flushPromises();
	assert.equal(calls, 1);
	now = 1_000;
	runner.render("/footer", { ...input, time: { nowMs: now, nowIso: new Date(now).toISOString() } }, 80);
	await flushPromises();
	assert.equal(calls, 2);
	runner.dispose();
});

test("treats successful empty output as a hidden footer", async () => {
	const runner = new FooterScriptRunner({
		execute: async () => "\n",
		notifyWarning() {},
		requestRender() {},
	});
	const input = baseInput();
	assert.equal(runner.render("/footer", input, 80), undefined);
	await flushPromises();
	assert.deepEqual(runner.render("/footer", input, 80), []);
	runner.dispose();
});
