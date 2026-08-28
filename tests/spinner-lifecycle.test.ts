import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionWidgetOptions,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
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
import { SPINNER_WIDGET_KEY } from "../extensions/open-tui/spinner-widget.ts";

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

class FakeEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	readonly events: ExtensionAPI["events"] = {
		emit: (channel, data) => {
			for (const handler of this.handlers.get(channel) ?? []) handler(data);
		},
		on: (channel, handler) => {
			const handlers = this.handlers.get(channel) ?? new Set();
			handlers.add(handler);
			this.handlers.set(channel, handlers);
			return () => handlers.delete(handler);
		},
	};

	listenerCount(): number {
		return [...this.handlers.values()].reduce((total, handlers) => total + handlers.size, 0);
	}
}

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

type WidgetCall = {
	key: string;
	content: string[] | WidgetFactory | undefined;
	options?: ExtensionWidgetOptions;
};

function setup(enabled = true) {
	const clock = new FakeClock();
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.enabled = enabled;
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<WorkingIndicatorOptions | undefined> = [];
	const workingVisible: boolean[] = [];
	const widgetCalls: WidgetCall[] = [];
	let widget: (Component & { dispose?(): void }) | undefined;
	let renderRequests = 0;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	} as unknown as TUI;

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
			setWidget(
				key: string,
				content: string[] | WidgetFactory | undefined,
				options?: ExtensionWidgetOptions,
			) {
				widgetCalls.push({ key, content, options });
				widget?.dispose?.();
				widget = typeof content === "function" ? content(tui, theme) : undefined;
			},
		},
	} as unknown as ExtensionContext;
	const dependencies: SpinnerDependencies = {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	};
	const installation = installSpinner(events.events, ctx, () => config, dependencies);

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
		widgetCalls,
		renderRequests: () => renderRequests,
		renderWidget(width = 120): string[] {
			return widget?.render(width) ?? [];
		},
	};
}

test("disabled spinner leaves Pi working UI untouched", () => {
	const result = setup(false);
	assert.equal(result.installation, undefined);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingIndicators, []);
	assert.deepEqual(result.workingVisible, []);
	assert.deepEqual(result.widgetCalls, []);
});

test("enabled spinner hides the native row and mounts one above-editor widget", () => {
	const result = setup();
	assert.ok(result.installation);
	assert.deepEqual(result.workingVisible, [false]);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingIndicators, []);
	assert.equal(result.widgetCalls.length, 1);
	assert.equal(result.widgetCalls[0]?.key, SPINNER_WIDGET_KEY);
	assert.equal(typeof result.widgetCalls[0]?.content, "function");
	assert.deepEqual(result.widgetCalls[0]?.options, { placement: "aboveEditor" });
	assert.deepEqual(result.renderWidget(), []);
	result.installation!.dispose();
});

test("agent state renders through the custom widget", () => {
	const result = setup();
	const controller = result.installation!.controller;
	const rendersBeforeStart = result.renderRequests();
	controller.agentStart("high", true);
	assert.ok(result.renderRequests() > rendersBeforeStart);
	assert.match(result.renderWidget()[0] ?? "", /<accent>·<\/accent>/);
	assert.match(result.renderWidget()[0] ?? "", /Working…/);
	assert.equal(result.renderWidget()[1], "");

	controller.messageUpdate({ type: "thinking_start" });
	assert.match(result.renderWidget()[0] ?? "", /thinking with high effort/);
	controller.messageUpdate({ type: "thinking_end" });
	controller.messageUpdate({ type: "text_start" });
	assert.match(result.renderWidget()[0] ?? "", /Working…/);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingIndicators, []);
	result.installation!.dispose();
});

test("provider usage, not streamed character length, drives spinner tokens", () => {
	const result = setup();
	result.config.verbose = true;
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	assert.match(result.renderWidget()[0] ?? "", /Working… \(0s\)/);

	const usage = { input: 50, output: 25, cacheRead: 150, cacheWrite: 10 };
	controller.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(400) },
		usage,
	);
	assert.equal(controller.state.inputTokens, 50);
	assert.equal(controller.state.outputTokens, 25);
	assert.equal(controller.state.responseLength, 400);
	assert.match(result.renderWidget()[0] ?? "", /↓ 25 tokens/);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /100 tokens/);

	result.clock.value = 250;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /↓ 25 tokens/);

	controller.messageEnd(usage);
	controller.turnStart();
	assert.match(result.renderWidget()[0] ?? "", /↑ 50 tokens/);

	result.clock.value = 60_000;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /1m 0s/);
	assert.match(result.renderWidget()[0] ?? "", /↑ 50 tokens/);
	result.installation!.dispose();
});

test("stall color and reduced motion are owned by the widget", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);

	result.clock.value = 4_000;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /<warning>/);

	result.clock.value = 5_000;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /<error>/);

	controller.toolExecutionStart("tool-1");
	assert.match(result.renderWidget()[0] ?? "", /<accent>/);

	result.config.reducedMotion = true;
	controller.refresh();
	assert.match(result.renderWidget()[0] ?? "", /●/);
	result.installation!.dispose();
});

test("showStall=false keeps the widget accent-colored", () => {
	const result = setup();
	result.config.showStall = false;
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.clock.value = 5_000;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /<accent>/);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /<error>/);
	result.installation!.dispose();
});

test("task, override, and suffix events update widget content", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);

	result.events.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 1,
		tasks: [{ id: 1, subject: "Fix authentication", activeForm: "Fixing authentication", status: "in_progress" }],
	});
	assert.match(result.renderWidget()[0] ?? "", /Fixing authentication…/);

	result.events.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "workspace",
		suffix: "repository",
	});
	assert.match(result.renderWidget()[0] ?? "", /Fixing authentication… \(repository\)/);

	result.events.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "review",
		message: "Reviewing security",
	});
	assert.match(result.renderWidget()[0] ?? "", /Reviewing security… \(repository\)/);

	result.events.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "review", message: null });
	assert.match(result.renderWidget()[0] ?? "", /Fixing authentication… \(repository\)/);

	result.config.taskIntegration = "off";
	controller.refresh();
	assert.match(result.renderWidget()[0] ?? "", /Working… \(repository\)/);
	result.installation!.dispose();
});

test("agent-scoped event content clears while session-scoped content persists", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	result.events.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "agent",
		message: "Agent override",
	});
	result.events.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "session",
		suffix: "session suffix",
		scope: "session",
	});
	controller.agentEnd();
	controller.agentStart(null, false);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /Agent override/);
	assert.match(result.renderWidget()[0] ?? "", /session suffix/);
	result.installation!.dispose();
});

test("compaction hides the widget without remounting it", () => {
	const result = setup();
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	assert.equal(result.widgetCalls.length, 1);
	assert.equal(result.renderWidget().length, 2);
	controller.beforeCompact();
	assert.equal(controller.state.active, false);
	assert.deepEqual(result.renderWidget(), []);
	assert.equal(result.widgetCalls.length, 1);
	result.installation!.dispose();
});

test("widget truncates its row to the available width", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.reducedMotion = true;
	const controller = result.installation!.controller;
	controller.agentStart(null, false);
	controller.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(123_456) },
		{ input: 123_456, output: 78_900 },
	);
	const line = result.renderWidget(20)[0] ?? "";
	assert.match(line, /\.\.\./);
	result.installation!.dispose();
});

test("dispose removes the widget, restores the native row, and detaches event listeners once", () => {
	const result = setup();
	const installation = result.installation!;
	installation.controller.agentStart(null, false);
	assert.equal(result.events.listenerCount(), 3);
	installation.dispose();
	installation.dispose();

	assert.equal(result.events.listenerCount(), 0);
	assert.deepEqual(result.workingVisible, [false, true]);
	assert.equal(result.widgetCalls.length, 2);
	assert.equal(result.widgetCalls.at(-1)?.key, SPINNER_WIDGET_KEY);
	assert.equal(result.widgetCalls.at(-1)?.content, undefined);
	assert.deepEqual(result.workingMessages, []);
	assert.deepEqual(result.workingIndicators, []);
});

test("replacement installations do not retain session-scoped widget content", () => {
	const result = setup();
	result.installation!.controller.agentStart(null, false);
	result.events.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "session",
		suffix: "old session",
		scope: "session",
	});
	assert.match(result.renderWidget()[0] ?? "", /old session/);
	result.installation!.dispose();

	const replacement = installSpinner(
		result.events.events,
		result.ctx,
		() => result.config,
		result.dependencies,
	)!;
	replacement.controller.agentStart(null, false);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /old session/);
	replacement.dispose();
	assert.equal(result.events.listenerCount(), 0);
});
