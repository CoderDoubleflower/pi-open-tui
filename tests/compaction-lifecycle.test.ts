import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { settleCompactionFailure } from "../extensions/open-tui/compaction-lifecycle.ts";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { SpinnerController } from "../extensions/open-tui/spinner.ts";

const events = {
	emit() {},
	on() {
		return () => {};
	},
} as unknown as ExtensionAPI["events"];

test("terminal compaction failure settles an active working duration", () => {
	const state = { workingSince: 1_000, lastDoneIn: undefined as number | undefined };
	assert.equal(settleCompactionFailure(state, false, 4_500), true);
	assert.equal(state.workingSince, undefined);
	assert.equal(state.lastDoneIn, 3_500);
});

test("overflow recovery preserves working state for the retry", () => {
	const state = { workingSince: 1_000, lastDoneIn: undefined as number | undefined };
	assert.equal(settleCompactionFailure(state, true, 4_500), false);
	assert.equal(state.workingSince, 1_000);
	assert.equal(state.lastDoneIn, undefined);
});

test("idle compaction failure does not synthesize a completion duration", () => {
	const state = { workingSince: undefined, lastDoneIn: 800 };
	assert.equal(settleCompactionFailure(state, false, 4_500), false);
	assert.equal(state.workingSince, undefined);
	assert.equal(state.lastDoneIn, 800);
});

test("successful compaction resumes the active spinner without another agent_start", () => {
	let now = 1_000;
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	const controller = new SpinnerController(events, () => config, {
		clock: { now: () => now },
		random: {
			pick<T>(items: readonly T[]): T {
				return items[0]!;
			},
		},
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	});

	controller.agentStart(null, false);
	controller.messageUpdate(
		{ type: "text_delta", delta: "partial response" },
		{ input: 120, output: 30 },
	);
	const startedAt = controller.state.agentStartedAtMs;
	const compaction = {};
	controller.nativeStatusStart(compaction, {
		kind: "compaction",
		style: "system-requesting",
		message: "Compacting conversation…",
	});
	controller.beforeCompact();
	assert.equal(controller.state.phase, "hidden");
	assert.equal(controller.getWidgetSnapshot().visualMode, "system-requesting");

	now = 4_000;
	assert.equal(controller.afterCompact(true), true);
	assert.equal(controller.getWidgetSnapshot().visualMode, "system-requesting");
	controller.nativeStatusEnd(compaction);

	const resumed = controller.getWidgetSnapshot();
	assert.equal(resumed.phase, "running");
	assert.equal(resumed.active, true);
	assert.match(resumed.message ?? "", /Working/);
	assert.equal(controller.state.agentStartedAtMs, startedAt);
	assert.equal(controller.state.inputTokens, 120);
	assert.equal(controller.state.outputTokens, 30);
	assert.equal(controller.state.lastResponseAtMs, now);
	controller.dispose();
});
