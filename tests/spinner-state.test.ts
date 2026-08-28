import assert from "node:assert/strict";
import test from "node:test";
import {
	MIN_THINKING_VISIBLE_MS,
	SpinnerStateMachine,
	shouldShowSpinnerMetrics,
	thoughtDurationSeconds,
	type SpinnerClock,
	type SpinnerRandom,
} from "../extensions/open-tui/spinner-state.ts";

class FakeClock implements SpinnerClock {
	value = 0;

	now(): number {
		return this.value;
	}

	advance(ms: number): void {
		this.value += ms;
	}
}

class SequenceRandom implements SpinnerRandom {
	picks = 0;

	pick<T>(items: readonly T[]): T {
		return items[this.picks++ % items.length]!;
	}
}

function setup() {
	const clock = new FakeClock();
	const random = new SequenceRandom();
	const machine = new SpinnerStateMachine({
		clock,
		random,
		getVerbs: () => ["Working", "Checking"],
	});
	return { clock, random, machine };
}

test("agent start initializes the run and picks one stable verb", () => {
	const { clock, random, machine } = setup();
	clock.value = 100;
	machine.agentStart("high");

	assert.equal(machine.state.active, true);
	assert.equal(machine.state.mode, "requesting");
	assert.equal(machine.state.agentStartedAtMs, 100);
	assert.equal(machine.state.lastResponseAtMs, 100);
	assert.equal(machine.state.randomVerb, "Working");
	assert.equal(machine.state.effectiveEffort, "high");
	assert.equal(machine.state.inputTokens, 0);
	assert.equal(machine.state.outputTokens, 0);
	assert.deepEqual([...machine.state.activeToolIds], []);

	machine.turnStart();
	machine.messageUpdate({ type: "thinking_start" });
	machine.messageUpdate({ type: "text_start" });
	assert.equal(machine.state.randomVerb, "Working");
	assert.equal(random.picks, 1);

	machine.agentEnd();
	machine.agentStart();
	assert.equal(machine.state.randomVerb, "Checking");
	assert.equal(random.picks, 2);
});

test("stream start and delta events select all response modes", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.turnStart();
	assert.equal(machine.state.mode, "requesting");

	machine.messageUpdate({ type: "thinking_start" });
	assert.equal(machine.state.mode, "thinking");
	machine.messageUpdate({ type: "text_start" });
	assert.equal(machine.state.mode, "responding");
	machine.messageUpdate({ type: "toolcall_start" });
	assert.equal(machine.state.mode, "tool-input");
	machine.toolExecutionStart("tool-1");
	assert.equal(machine.state.mode, "tool-use");
	machine.toolExecutionEnd("tool-1");
	assert.equal(machine.state.mode, "tool-use");
	machine.turnStart();
	assert.equal(machine.state.mode, "requesting");

	machine.messageUpdate({ type: "thinking_delta", delta: "a" });
	assert.equal(machine.state.mode, "thinking");
	machine.messageUpdate({ type: "text_delta", delta: "b" });
	assert.equal(machine.state.mode, "responding");
	machine.messageUpdate({ type: "toolcall_delta", delta: "c" });
	assert.equal(machine.state.mode, "tool-input");
});

test("first non-empty thinking delta initializes missing thinking start", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	clock.advance(250);
	machine.messageUpdate({ type: "thinking_delta", delta: "reason" });
	assert.equal(machine.state.thinkingStartedAtMs, 250);
	assert.equal(machine.state.thinkingPhase, "thinking");
	assert.equal(machine.state.outputTokens, 0);
});

test("short thinking holds for two seconds then shows thought for two seconds", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	machine.messageUpdate({ type: "thinking_start" });
	clock.advance(500);
	machine.messageUpdate({ type: "thinking_end" });

	assert.equal(machine.state.thinkingPhase, "holding-thinking");
	assert.equal(machine.state.thinkingActualDurationMs, 500);
	assert.equal(machine.state.thinkingPhaseUntilMs, MIN_THINKING_VISIBLE_MS);
	assert.equal(thoughtDurationSeconds(machine.state), 1);

	machine.messageUpdate({ type: "text_start" });
	assert.equal(machine.state.mode, "responding");
	assert.equal(machine.state.thinkingPhase, "holding-thinking");

	clock.value = 1_999;
	machine.tick();
	assert.equal(machine.state.thinkingPhase, "holding-thinking");
	clock.value = 2_000;
	machine.tick();
	assert.equal(machine.state.thinkingPhase, "thought");
	clock.value = 3_999;
	machine.tick();
	assert.equal(machine.state.thinkingPhase, "thought");
	clock.value = 4_000;
	machine.tick();
	assert.equal(machine.state.thinkingPhase, "none");
});

test("thinking duration excludes hold time and new thinking replaces thought", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	machine.messageUpdate({ type: "thinking_start" });
	clock.advance(2_400);
	machine.messageUpdate({ type: "thinking_end" });
	assert.equal(machine.state.thinkingActualDurationMs, 2_400);
	assert.equal(machine.state.thinkingPhase, "thought");

	clock.advance(500);
	machine.messageUpdate({ type: "thinking_start" });
	assert.equal(machine.state.thinkingStartedAtMs, 2_900);
	assert.equal(machine.state.thinkingActualDurationMs, null);
	assert.equal(machine.state.thinkingPhase, "thinking");
});

test("message end converges open thinking and agent end clears it immediately", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	machine.messageUpdate({ type: "thinking_start" });
	clock.advance(300);
	machine.messageEnd();
	assert.equal(machine.state.thinkingPhase, "holding-thinking");

	machine.agentEnd();
	assert.equal(machine.state.active, false);
	assert.equal(machine.state.thinkingPhase, "none");
	assert.equal(machine.state.thinkingStartedAtMs, null);
	machine.agentEnd();
});

test("timer and token metadata use the strict 30 second gate", () => {
	const { machine } = setup();
	machine.agentStart();
	for (const [now, expected] of [[29_999, false], [30_000, false], [30_001, true]] as const) {
		assert.equal(shouldShowSpinnerMetrics(machine.state, now, false), expected);
	}
	assert.equal(shouldShowSpinnerMetrics(machine.state, 1, true), true);
});

test("stream deltas exclude cache usage from input tokens without waiting for a tick", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(400) },
		{ input: 80, output: 12, cacheRead: 900, cacheWrite: 20 },
	);
	assert.equal(machine.state.inputTokens, 80);
	assert.equal(machine.state.outputTokens, 12);
	machine.tick();
	assert.equal(machine.state.inputTokens, 80);
	assert.equal(machine.state.outputTokens, 12);
});

test("stream text never fabricates tokens when provider usage is unavailable", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.messageUpdate({ type: "text_delta", delta: "x".repeat(400) });
	machine.messageUpdate({ type: "thinking_delta", delta: "验证令牌" });
	machine.messageUpdate({ type: "toolcall_delta", delta: "{\"path\":\"file\"}" });
	assert.equal(machine.state.inputTokens, 0);
	assert.equal(machine.state.outputTokens, 0);
});

test("provider usage accumulates real prompt and output totals across turns", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.turnStart();
	machine.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(400) },
		{ input: 80, output: 0, cacheRead: 20, cacheWrite: 5 },
	);
	assert.equal(machine.state.inputTokens, 80);
	assert.equal(machine.state.outputTokens, 0);

	const firstUsage = { input: 80, output: 90, cacheRead: 20, cacheWrite: 5 };
	machine.messageUpdate({ type: "done" }, firstUsage);
	assert.equal(machine.state.outputTokens, 90);
	machine.messageEnd(firstUsage);
	assert.equal(machine.state.completedInputTokens, 80);
	assert.equal(machine.state.completedOutputTokens, 90);

	machine.turnStart();
	assert.equal(machine.state.inputTokens, 80);
	assert.equal(machine.state.outputTokens, 90);
	machine.messageUpdate({ type: "thinking_delta", delta: "验证" });
	assert.equal(machine.state.outputTokens, 90);
	machine.messageEnd({ input: 100, output: 5, cacheRead: 50, cacheWrite: 0 });
	assert.equal(machine.state.inputTokens, 180);
	assert.equal(machine.state.outputTokens, 95);
});

test("invalid or unavailable provider usage leaves token counts unchanged", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.turnStart();
	machine.messageUpdate({ type: "text_delta", delta: "x".repeat(40) });
	machine.messageUpdate(
		{ type: "done" },
		{ input: Number.NaN, output: -5, cacheRead: -1, cacheWrite: Number.NaN },
	);
	assert.equal(machine.state.inputTokens, 0);
	assert.equal(machine.state.outputTokens, 0);
	machine.messageEnd();
	assert.equal(machine.state.completedInputTokens, 0);
	assert.equal(machine.state.completedOutputTokens, 0);
});

test("empty deltas change mode without accumulating output tokens", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
		clock.advance(100);
		machine.messageUpdate({ type, delta: "" });
	}
	assert.equal(machine.state.outputTokens, 0);
	assert.equal(machine.state.lastResponseAtMs, 0);
});

test("parallel tools suppress stall until the final tool ends", () => {
	const { clock, machine } = setup();
	machine.agentStart();
	clock.advance(4_000);
	machine.toolExecutionStart("a");
	machine.toolExecutionStart("b");
	machine.tick();
	assert.equal(machine.state.stalledIntensity, 0);
	assert.deepEqual([...machine.state.activeToolIds], ["a", "b"]);

	machine.toolExecutionEnd("a");
	clock.advance(10_000);
	machine.tick();
	assert.equal(machine.state.stalledIntensity, 0);
	machine.toolExecutionEnd("b");
	assert.equal(machine.state.lastResponseAtMs, 14_000);
	assert.equal(machine.state.activeToolIds.size, 0);

	clock.advance(2_999);
	machine.tick();
	assert.equal(machine.state.stalledIntensity, 0);
	clock.advance(1_001);
	machine.tick();
	assert.equal(machine.state.stalledIntensity, 0.5);
	clock.advance(1_000);
	machine.tick();
	assert.equal(machine.state.stalledIntensity, 1);
});

test("unknown tool ids, duplicate ends, and repeated abort cleanup are no-ops", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.toolExecutionStart("known");
	machine.toolExecutionEnd("unknown");
	assert.equal(machine.state.activeToolIds.size, 1);
	machine.toolExecutionEnd("known");
	machine.toolExecutionEnd("known");
	machine.agentEnd();
	machine.agentEnd();
	assert.equal(machine.state.active, false);
});

test("effective effort excludes off and non-reasoning models", () => {
	const { machine } = setup();
	machine.agentStart();
	machine.setEffectiveEffort("xhigh", true);
	assert.equal(machine.state.effectiveEffort, "xhigh");
	machine.setEffectiveEffort("off", true);
	assert.equal(machine.state.effectiveEffort, null);
	machine.setEffectiveEffort("high", false);
	assert.equal(machine.state.effectiveEffort, null);
});
