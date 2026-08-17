import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	loadConfig,
	saveConfig,
} from "../extensions/open-tui/config.ts";
import {
	DEFAULT_SPINNER_VERBS,
	MAX_CUSTOM_SPINNER_VERBS,
	normalizeCustomSpinnerVerbs,
	resolveSpinnerVerbs,
} from "../extensions/open-tui/spinner-verbs.ts";

function withAgentDir(run: (agentDir: string) => void): void {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-spinner-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("ships the complete unique default verb set without ellipses", () => {
	assert.equal(DEFAULT_SPINNER_VERBS.length, 187);
	assert.equal(new Set(DEFAULT_SPINNER_VERBS).size, 187);
	assert.equal(DEFAULT_SPINNER_VERBS[0], "Accomplishing");
	assert.equal(DEFAULT_SPINNER_VERBS.at(-1), "Zigzagging");
	assert.ok(DEFAULT_SPINNER_VERBS.includes("Flambéing"));
	assert.ok(DEFAULT_SPINNER_VERBS.includes("Sautéing"));
	assert.ok(DEFAULT_SPINNER_VERBS.every((verb) => !verb.endsWith("...") && !verb.endsWith("…")));
});

test("normalizes custom verbs by value, safety, length, and count", () => {
	const values: unknown[] = [
		" Inspecting ",
		"Inspecting",
		"",
		"line\nbreak",
		"escape\x1b[31m",
		"x".repeat(65),
		42,
		...Array.from({ length: 300 }, (_, index) => `Verb ${index}`),
	];
	const normalized = normalizeCustomSpinnerVerbs(values);
	assert.equal(normalized[0], "Inspecting");
	assert.equal(normalized.length, MAX_CUSTOM_SPINNER_VERBS);
	assert.ok(!normalized.includes("line\nbreak"));
	assert.ok(!normalized.includes("x".repeat(65)));
	assert.equal(normalizeCustomSpinnerVerbs("Inspecting").length, 0);
});

test("resolves append, replace, deduplication, and empty replace fallback", () => {
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.verbs.values = ["Working", "Inspecting"];
	assert.equal(resolveSpinnerVerbs(config).length, 188);
	assert.equal(resolveSpinnerVerbs(config).at(-1), "Inspecting");

	config.verbs.mode = "replace";
	assert.deepEqual(resolveSpinnerVerbs(config), ["Working", "Inspecting"]);
	config.verbs.values = [];
	assert.deepEqual(resolveSpinnerVerbs(config), DEFAULT_SPINNER_VERBS);
});

test("loads Phase 2 defaults into older config files", () => {
	withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
			spinner: { enabled: true },
			footerSegments: { cwd: false },
		}), "utf8");
		const config = loadConfig();
		assert.deepEqual(config.spinner, { ...DEFAULT_CONFIG.spinner, enabled: true });
		assert.equal(config.footerSegments.timer, true);
		assert.equal(config.footerSegments.cwd, false);
	});
});

test("validates Phase 2 fields independently and normalizes verbs in memory", () => {
	withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
			spinner: {
				enabled: true,
				verbose: "yes",
				reducedMotion: false,
				showThinking: 1,
				showTimer: false,
				showTokens: null,
				showStall: false,
				showSuffix: "yes",
				effortDisplay: "claude",
				taskIntegration: "auto",
				suppressFooterWorkingTimer: "yes",
				verbs: {
					mode: "merge",
					values: [" Inspecting ", "Inspecting", "bad\nverb"],
				},
			},
			footerSegments: { timer: "yes" },
		}), "utf8");
		const config = loadConfig();
		assert.deepEqual(config.spinner, {
			...DEFAULT_CONFIG.spinner,
			enabled: true,
			showTimer: false,
			showStall: false,
			verbs: { mode: "append", values: ["Inspecting"] },
		});
		assert.equal(config.footerSegments.timer, true);
	});
});

test("preserves all Phase 2 settings through save and load", () => {
	withAgentDir(() => {
		const config = structuredClone(DEFAULT_CONFIG);
		Object.assign(config.spinner, {
			enabled: true,
			verbose: true,
			reducedMotion: true,
			showThinking: false,
			showTimer: false,
			showTokens: false,
			showStall: false,
			showSuffix: false,
			effortDisplay: "off" as const,
			taskIntegration: "off" as const,
			suppressFooterWorkingTimer: false,
			verbs: { mode: "replace" as const, values: ["Inspecting"] },
		});
		config.footerSegments.timer = false;
		saveConfig(config);
		assert.deepEqual(loadConfig(), config);
	});
});
