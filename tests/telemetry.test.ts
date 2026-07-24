import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageUpdateEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import openTui from "../extensions/open-tui/index.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "../extensions/open-tui/telemetry.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

function makeMessage(output = 20, input = 50): AssistantMessage {
	const totalTokens = input + output;
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens * 0.000004 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function update(
	message: AssistantMessage,
	assistantMessageEvent: MessageUpdateEvent["assistantMessageEvent"] = {
		type: "text_delta",
		contentIndex: 0,
		delta: "x",
		partial: message,
	},
): MessageUpdateEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent,
	};
}

function clock(...times: number[]): () => number {
	let index = 0;
	return () => times[Math.min(index++, times.length - 1)]!;
}

function startTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0): void {
	tracker.handle({ type: "turn_start", turnIndex, timestamp: Date.now() });
	tracker.handle({ type: "message_start", message });
}

function endTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0) {
	tracker.handle({ type: "message_end", message });
	return tracker.handle({ type: "turn_end", turnIndex, message, toolResults: [] });
}

test("tracks reliable TPS, TTFT, tokens, total time, and list-price rate", () => {
	const tracker = new TurnTelemetryTracker(clock(0, 100, 200, 300, 400, 500, 600, 700, 800, 900));
	const message = makeMessage();
	startTurn(tracker, message);
	for (let i = 0; i < 6; i++) tracker.handle(update(message));
	const telemetry = endTurn(tracker, message);

	assert.deepEqual(telemetry, {
		tps: 50,
		ttftMs: 200,
		totalMs: 900,
		inputTokens: 50,
		outputTokens: 20,
		stallMs: 0,
		stallCount: 0,
		rateUsdPerMTokens: 4,
		generationMs: 700,
		totalTokens: 70,
		costUsd: 0.00028,
		measurementMs: 400,
	});
	assert.equal(
		formatTurnTelemetry(telemetry!, theme, DEFAULT_CONFIG.telemetry, "ascii"),
		"> TPS 50.0 tok/s | ~ TTFT 0.2s | + 0.9s | ↑ 50 | ↓ 20 | $ $4.00/M",
	);
});

test("uses footer semantics and respects telemetry segment settings", () => {
	const colors: string[] = [];
	const styledTheme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
	} as Theme;
	const telemetry = {
		tps: 50,
		ttftMs: 200,
		totalMs: 900,
		inputTokens: 50,
		outputTokens: 20,
		stallMs: 800,
		stallCount: 1,
		rateUsdPerMTokens: 4,
		generationMs: 700,
		totalTokens: 70,
		costUsd: 0.00028,
		measurementMs: 400,
	};

	assert.match(
		formatTurnTelemetry(telemetry, styledTheme, DEFAULT_CONFIG.telemetry, "ascii"),
		/^> TPS 50\.0 tok\/s \| ~ TTFT 0\.2s.*! stall 1x \/ 0\.8s \| \$ \$4\.00\/M$/,
	);
	assert.deepEqual(colors, ["accent", "text", "success", "accent", "success", "warning", "warning", "dim"]);

	const hidden: typeof DEFAULT_CONFIG.telemetry = {
		enabled: false,
		tps: false,
		ttft: false,
		duration: false,
		tokens: false,
		stalls: false,
		cost: false,
	};
	assert.equal(formatTurnTelemetry(telemetry, theme, hidden, "ascii"), "");
});

test("uses the conservative fallback and rejects burst timing", () => {
	const fallback = new TurnTelemetryTracker(clock(0, 50, 50.1, 50.15, 50.3, 250, 300));
	const message = makeMessage();
	startTurn(fallback, message);
	fallback.handle(update(message));
	fallback.handle(update(message));
	fallback.handle(update(message));
	assert.equal(endTurn(fallback, message)?.tps, 100);

	const burst = new TurnTelemetryTracker(clock(0, 100, 100.1, 100.1, 100.1, 100.1, 100.1, 100.1, 101, 101));
	startTurn(burst, message);
	for (let i = 0; i < 6; i++) burst.handle(update(message));
	assert.equal(endTurn(burst, message)?.tps, null);
});

test("groups consecutive stalls and starts a new count after streaming resumes", () => {
	const tracker = new TurnTelemetryTracker(clock(0, 100, 200, 300, 900, 1500, 1600, 2200, 2300, 2400));
	const message = makeMessage();
	startTurn(tracker, message);
	for (let i = 0; i < 6; i++) tracker.handle(update(message));
	const telemetry = endTurn(tracker, message)!;

	assert.equal(telemetry.stallMs, 1800);
	assert.equal(telemetry.stallCount, 2);
	assert.match(formatTurnTelemetry(telemetry, theme, DEFAULT_CONFIG.telemetry, "ascii"), /! stall 2x \/ 1\.8s/);
});

test("only meaningful stream deltas define TTFT and stalls", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();
	startTurn(tracker, message);

	now = 100;
	tracker.handle(update(message, { type: "start", partial: message }));
	now = 200;
	tracker.handle(update(message, { type: "text_start", contentIndex: 0, partial: message }));
	now = 700;
	tracker.handle(update(message));
	now = 800;
	tracker.handle(update(message));
	now = 900;
	tracker.handle(update(message));
	now = 10_000;
	tracker.handle(update(message, { type: "done", reason: "stop", message }));
	now = 10_100;
	const telemetry = endTurn(tracker, message)!;

	assert.equal(telemetry.ttftMs, 700);
	assert.equal(telemetry.stallMs, 0);
	assert.equal(telemetry.stallCount, 0);
});

test("excludes tool gaps between assistant messages from primary TPS", () => {
	const tracker = new TurnTelemetryTracker(clock(
		0,
		100, 200, 300, 400, 500, 600,
		1600, 1700, 1800, 1900, 2000, 2100,
		2200,
	));
	const first = makeMessage(20, 10);
	const second = makeMessage(20, 10);

	startTurn(tracker, first);
	for (let i = 0; i < 4; i++) tracker.handle(update(first));
	tracker.handle({ type: "message_end", message: first });
	tracker.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
	tracker.handle({ type: "message_start", message: second });
	for (let i = 0; i < 4; i++) tracker.handle(update(second));
	const telemetry = endTurn(tracker, second)!;

	assert.equal(telemetry.tps, 100);
	assert.equal(telemetry.outputTokens, 40);
	assert.equal(telemetry.stallMs, 0);
});

test("clamps fallback tool-call TPS to the model's reliable observed speed", () => {
	const tracker = new TurnTelemetryTracker(clock(
		0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
		1000, 1100, 1100.1, 1100.15, 1100.3, 1300, 1300,
	));
	const message = makeMessage();

	startTurn(tracker, message);
	for (let i = 0; i < 6; i++) tracker.handle(update(message));
	assert.equal(endTurn(tracker, message)?.tps, 50);

	startTurn(tracker, message, 1);
	tracker.handle(update(message));
	tracker.handle(update(message));
	tracker.handle(update(message));
	tracker.handle({ type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} });
	assert.equal(endTurn(tracker, message, 1)?.tps, 50);
});

test("aggregates every turn into one complete agent-run result", () => {
	const tracker = new TurnTelemetryTracker(clock(
		0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
		1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 2000,
	));
	const first = makeMessage(20, 50);
	const second = makeMessage(30, 100);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, first);
	for (let i = 0; i < 6; i++) tracker.handle(update(first));
	endTurn(tracker, first);
	tracker.handle({ type: "agent_start" });
	startTurn(tracker, second, 1);
	for (let i = 0; i < 6; i++) tracker.handle(update(second));
	endTurn(tracker, second, 1);
	const telemetry = tracker.handle({ type: "agent_settled" });

	assert.equal(telemetry?.tps, 62.5);
	assert.equal(telemetry?.ttftMs, 200);
	assert.equal(telemetry?.totalMs, 2000);
	assert.equal(telemetry?.inputTokens, 150);
	assert.equal(telemetry?.outputTokens, 50);
	assert.equal(telemetry?.totalTokens, 200);
	assert.equal(telemetry?.rateUsdPerMTokens, 4);
});

test("aggregates TPS from measurable turns when a tool turn is not measurable", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const toolTurn = makeMessage(5, 20);
	const finalTurn = makeMessage(20, 50);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, toolTurn);
	now = 100;
	tracker.handle(update(toolTurn));
	tracker.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
	now = 150;
	endTurn(tracker, toolTurn);

	now = 200;
	startTurn(tracker, finalTurn, 1);
	for (const timestamp of [300, 400, 500, 600, 700, 800]) {
		now = timestamp;
		tracker.handle(update(finalTurn));
	}
	now = 900;
	endTurn(tracker, finalTurn, 1);
	now = 1_000;
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.tps, 50);
	assert.equal(telemetry.measurementMs, 400);
	assert.equal(telemetry.inputTokens, 70);
	assert.equal(telemetry.outputTokens, 25);
});

test("open-tui notifies once after a complete agent run", () => {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void>>();
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { theme, notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const message = makeMessage();

	openTui(pi);
	emit("agent_start", { type: "agent_start" });
	emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	emit("message_start", { type: "message_start", message });
	emit("message_update", update(message));
	emit("message_end", { type: "message_end", message });
	emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });

	assert.equal(notifications.length, 0);
	emit("agent_settled", { type: "agent_settled" });
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /TPS —.*TTFT/);
});
