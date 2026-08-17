import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { registerOpenTui } from "../extensions/open-tui/index.ts";
import {
	installSpinner,
	type SpinnerDependencies,
} from "../extensions/open-tui/spinner.ts";
import {
	SPINNER_OVERRIDE_EVENT,
	SPINNER_TASKS_EVENT,
} from "../extensions/open-tui/spinner-events.ts";
import { SPINNER_SUFFIX_EVENT } from "../extensions/open-tui/spinner-suffix.ts";
import type { SpinnerClock, SpinnerRandom } from "../extensions/open-tui/spinner-state.ts";

class FakeClock implements SpinnerClock {
	value = 0;
	now(): number {
		return this.value;
	}
}

class FixedRandom implements SpinnerRandom {
	pick<T>(items: readonly T[]): T {
		return items[0]!;
	}
}

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function createTestEventBus(): ExtensionAPI["events"] {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const channelHandlers = handlers.get(channel) ?? new Set();
			channelHandlers.add(handler);
			handlers.set(channel, channelHandlers);
			return () => channelHandlers.delete(handler);
		},
	};
}

function setup(enabled = true) {
	const clock = new FakeClock();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.enabled = enabled;
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<WorkingIndicatorOptions | undefined> = [];
	const workingVisible: boolean[] = [];
	let widgetCalls = 0;
	const ctx = {
		ui: {
			theme,
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
			setWorkingIndicator(indicator?: WorkingIndicatorOptions) {
				workingIndicators.push(indicator);
			},
			setWorkingVisible(visible: boolean) {
				workingVisible.push(visible);
			},
			setWidget() {
				widgetCalls++;
			},
		},
	} as unknown as ExtensionContext;
	const dependencies: SpinnerDependencies = {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	};
	const events = createTestEventBus();
	const installation = installSpinner(events, ctx, () => config, dependencies);
	return {
		clock,
		config,
		ctx,
		dependencies,
		events,
		installation,
		workingMessages,
		workingIndicators,
		workingVisible,
		widgetCalls: () => widgetCalls,
	};
}

test("disabled spinner does not change native working row settings", () => {
	const result = setup(false);
	assert.equal(result.installation, undefined);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingIndicators, []);
	assert.deepEqual(result.workingVisible, []);
	assert.equal(result.widgetCalls(), 0);
});

test("enabled spinner configures Pi native indicator without a widget", () => {
	const result = setup();
	assert.ok(result.installation);
	assert.equal(result.workingIndicators.length, 1);
	assert.equal(result.workingIndicators[0]?.intervalMs, 120);
	assert.equal(result.workingIndicators[0]?.frames?.length, 12);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingVisible, []);
	assert.equal(result.widgetCalls(), 0);
});

test("agent events publish native working messages", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart("high", true);
	assert.equal(result.workingMessages.at(-1), "Working…");

	controller.messageUpdate({ type: "thinking_start" });
	assert.equal(result.workingMessages.at(-1), "Working… (thinking with high effort)");
	controller.messageUpdate({ type: "thinking_end" });
	controller.messageUpdate({ type: "text_start" });
	assert.match(result.workingMessages.at(-1)!, /^Working…/);
	assert.equal(result.widgetCalls(), 0);
});

test("provider usage updates tokens while ticks update timer without owning a timer", () => {
	const result = setup();
	result.config.verbose = true;
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Working… (0s)");

	controller.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(100) },
		{ input: 50, output: 25 },
	);
	assert.equal(result.workingMessages.at(-1), "Working… (0s · ↑ 50 tokens · ↓ 25 tokens)");
	const writesBeforeTick = result.workingMessages.length;
	controller.tick();
	assert.equal(result.workingMessages.length, writesBeforeTick);
	assert.equal(result.widgetCalls(), 0);
});

test("unchanged native message is not written repeatedly", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	const writes = result.workingMessages.length;
	result.clock.value = 50;
	controller.tick();
	controller.tick();
	assert.equal(result.workingMessages.length, writes);
});

test("stall changes only the native indicator color", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	const normalWrites = result.workingIndicators.length;

	result.clock.value = 4_000;
	controller.tick();
	assert.equal(result.workingIndicators.length, normalWrites + 1);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /warning/);

	result.clock.value = 5_000;
	controller.tick();
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /error/);
	controller.toolExecutionStart("tool-1");
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /accent/);
});

test("reduced motion switches the native indicator to one static frame", () => {
	const result = setup();
	result.config.reducedMotion = true;
	result.installation!.controller.tick();
	assert.deepEqual(result.workingIndicators.at(-1), {
		frames: ["<accent>●</accent>"],
	});
});

test("stall setting keeps the native indicator in its normal color", () => {
	const result = setup();
	result.config.showStall = false;
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	const writes = result.workingIndicators.length;
	result.clock.value = 5_000;
	controller.tick();
	assert.equal(result.workingIndicators.length, writes);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /accent/);
});

test("event content updates the active native message and preserves fallback state", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 1,
		tasks: [{ id: 1, subject: "Fix authentication", activeForm: "Fixing authentication", status: "in_progress" }],
	});
	assert.equal(result.workingMessages.at(-1), "Fixing authentication…");

	result.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "review",
		message: "Reviewing security",
	});
	assert.equal(result.workingMessages.at(-1), "Reviewing security…");
	result.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "review", message: null });
	assert.equal(result.workingMessages.at(-1), "Fixing authentication…");

	result.config.taskIntegration = "off";
	controller.refresh();
	assert.equal(result.workingMessages.at(-1), "Working…");
	result.config.taskIntegration = "events";
	controller.refresh();
	assert.equal(result.workingMessages.at(-1), "Fixing authentication…");

	controller.agentEnd();
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Fixing authentication…");
	const writes = result.workingMessages.length;
	result.installation!.dispose();
	result.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "late", message: "Late" });
	assert.equal(result.workingMessages.length, writes + 1);
});

test("agent override clears at agent end while session override persists", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "agent", message: "Agent override" });
	controller.agentEnd();
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Working…");

	result.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "session",
		message: "Session override",
		scope: "session",
	});
	controller.agentEnd();
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Session override…");
});

test("suffix updates the active row and showSuffix restores stored content", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "workspace",
		suffix: "repository",
	});
	assert.equal(result.workingMessages.at(-1), "Working… (repository)");

	result.config.showSuffix = false;
	controller.refresh();
	assert.equal(result.workingMessages.at(-1), "Working…");
	result.config.showSuffix = true;
	controller.refresh();
	assert.equal(result.workingMessages.at(-1), "Working… (repository)");

	result.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "workspace",
		suffix: null,
	});
	assert.equal(result.workingMessages.at(-1), "Working…");
});

test("agent suffix clears at agent end while session suffix persists", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "agent",
		suffix: "agent suffix",
	});
	controller.agentEnd();
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Working…");

	result.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "session",
		suffix: "session suffix",
		scope: "session",
	});
	controller.agentEnd();
	controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Working… (session suffix)");
});

test("session-scoped suffix does not leak into a replacement installation", () => {
	const result = setup();
	result.installation!.controller.agentStart(null, false);
	result.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "session",
		suffix: "old session",
		scope: "session",
	});
	assert.equal(result.workingMessages.at(-1), "Working… (old session)");
	result.installation!.dispose();

	const replacement = installSpinner(
		result.events,
		result.ctx,
		() => result.config,
		result.dependencies,
	)!;
	replacement.controller.agentStart(null, false);
	assert.equal(result.workingMessages.at(-1), "Working…");
	replacement.dispose();
});

test("compaction stops custom state without changing core row visibility", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	controller.beforeCompact();
	assert.equal(controller.state.active, false);
	assert.deepEqual(result.workingVisible, []);
	assert.equal(result.widgetCalls(), 0);
});

test("cleanup restores native message and indicator defaults exactly once", () => {
	const result = setup();
	const installation = result.installation!;
	installation.controller.agentStart(null, false);
	installation.dispose();
	installation.dispose();
	assert.equal(result.workingMessages.at(-1), undefined);
	assert.equal(result.workingIndicators.at(-1), undefined);
	assert.equal(result.workingMessages.filter((message) => message === undefined).length, 1);
	assert.equal(result.workingIndicators.filter((indicator) => indicator === undefined).length, 1);
	assert.deepEqual(result.workingVisible, []);
});

test("enable and disable round trips never install a widget", () => {
	const result = setup();
	result.installation!.dispose();
	result.config.enabled = false;
	assert.equal(installSpinner(result.events, result.ctx, () => result.config, result.dependencies), undefined);
	result.config.enabled = true;
	const second = installSpinner(result.events, result.ctx, () => result.config, result.dependencies)!;
	second.controller.agentStart(null, false);
	second.dispose();
	assert.equal(result.widgetCalls(), 0);
	assert.deepEqual(result.workingVisible, []);
});

test("extension entry forwards native working row lifecycle", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-spinner-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const config = structuredClone(DEFAULT_CONFIG);
	Object.assign(config.spinner, { enabled: true, verbose: true, reducedMotion: false });
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const clock = new FakeClock();
	const dependencies: SpinnerDependencies = {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	};
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<WorkingIndicatorOptions | undefined> = [];
	const workingVisible: boolean[] = [];
	let widgetCalls = 0;
	let settingsHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let settingsComponent: { handleInput(data: string): void } | undefined;
	const pi = {
		events: createTestEventBus(),
		on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: { handler: typeof settingsHandler }) {
			if (name === "open-tui") settingsHandler = options.handler;
		},
		getThinkingLevel: () => "high",
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: agentDir,
		model: { id: "reasoning-model", provider: "test", reasoning: true },
		getContextUsage: () => ({ tokens: 120, contextWindow: 1_000, percent: 12 }),
		ui: {
			theme,
			notify() {},
			custom(factory: (...args: any[]) => { handleInput(data: string): void }) {
				return new Promise<void>((resolve) => {
					settingsComponent = factory(
						{ requestRender() {} },
						theme,
						{},
						() => resolve(),
					);
				});
			},
			setHeader() {},
			setFooter() {},
			setEditorComponent() {},
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
			setWorkingIndicator(indicator?: WorkingIndicatorOptions) {
				workingIndicators.push(indicator);
			},
			setWorkingVisible(visible: boolean) {
				workingVisible.push(visible);
			},
			setWidget() {
				widgetCalls++;
			},
		},
	} as unknown as ExtensionContext;
	const emit = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const assistantMessage = {
		role: "assistant",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};

	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify(config), "utf8");
		registerOpenTui(pi, dependencies);
		await emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal(workingIndicators.length, 1);
		assert.deepEqual(workingVisible, []);
		assert.equal(widgetCalls, 0);

		await emit("agent_start", { type: "agent_start" });
		assert.equal(workingMessages.at(-1), "Working… (0s)");
		await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		assert.equal(workingMessages.at(-1), "Working… (0s)");
		assistantMessage.usage.input = 80;
		assistantMessage.usage.cacheRead = 20;
		await emit("message_update", {
			type: "message_update",
			message: assistantMessage,
			assistantMessageEvent: { type: "thinking_start" },
		});
		assert.match(workingMessages.at(-1)!, /thinking with high effort/);
		assert.match(workingMessages.at(-1)!, /↑ 80 tokens/);
		assistantMessage.usage.output = 2;
		await emit("message_update", {
			type: "message_update",
			message: assistantMessage,
			assistantMessageEvent: { type: "thinking_delta", delta: "验证" },
		});
		assert.match(workingMessages.at(-1)!, /↑ 80 tokens · ↓ 2 tokens/);
		assistantMessage.usage.output = 7;
		await emit("message_end", { type: "message_end", message: assistantMessage });
		assert.match(workingMessages.at(-1)!, /↑ 80 tokens · ↓ 7 tokens/);

		await emit("session_before_compact", { type: "session_before_compact" });

		assert.ok(settingsHandler);
		const settingsClosed = Promise.resolve(settingsHandler("", ctx));
		assert.ok(settingsComponent);
		settingsComponent.handleInput("\t");
		settingsComponent.handleInput("\t");
		const indicatorWritesBeforeDisable = workingIndicators.length;
		settingsComponent.handleInput("\r");
		assert.equal(workingIndicators.length, indicatorWritesBeforeDisable);
		settingsComponent.handleInput("q");
		await settingsClosed;
		assert.equal(workingIndicators.at(-1), undefined);

		await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.equal(workingMessages.at(-1), undefined);
		assert.equal(workingIndicators.at(-1), undefined);
		assert.deepEqual(workingVisible, []);
		assert.equal(widgetCalls, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
