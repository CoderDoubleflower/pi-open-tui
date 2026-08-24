import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	formatClaudeRetryStatus,
	installNativeStatusBridge,
	parseNativeRetryStatus,
	type NativeStatusKind,
	type NativeStatusPresentation,
	type NativeStatusSink,
} from "../extensions/open-tui/native-status-bridge.ts";
import { SpinnerController } from "../extensions/open-tui/spinner.ts";
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
}

type FakeContainer = Component & {
	children: Component[];
	addChild(component: Component): void;
	clear(): void;
};

function fakeComponent(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}

function fakeContainer(children: Component[] = []): FakeContainer {
	return {
		children: [...children],
		addChild(component) {
			this.children.push(component);
		},
		clear() {
			this.children = [];
		},
		invalidate() {},
		render() {
			return [];
		},
	};
}

type FakeIndicator = Component & {
	kind: NativeStatusKind;
	message: string;
	setMessage(message: string): void;
	dispose(): void;
};

function fakeIndicator(kind: NativeStatusKind, message: string): FakeIndicator {
	return {
		kind,
		message,
		setMessage(nextMessage) {
			this.message = nextMessage;
		},
		dispose() {},
		invalidate() {},
		render() {
			return [];
		},
	};
}

function createController(clock = new FakeClock()) {
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	const controller = new SpinnerController(events.events, () => config, {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	});
	return { clock, controller };
}

test("Claude retry parser and formatter match the external Claude Code row", () => {
	assert.deepEqual(parseNativeRetryStatus("Retrying (4/10) in 2s... (esc to cancel)"), {
		attempt: 4,
		maxRetries: 10,
		seconds: 2,
	});
	assert.equal(
		formatClaudeRetryStatus({ attempt: 4, maxRetries: 10, seconds: 2 }),
		"Retrying in 2 seconds… (attempt 4/10)",
	);
	assert.equal(
		formatClaudeRetryStatus({ attempt: 5, maxRetries: 10, seconds: 1 }),
		"Retrying in 1 second… (attempt 5/10)",
	);
	assert.equal(parseNativeRetryStatus("Retrying..."), null);
});

test("controller keeps the main spinner through the first three Claude-hidden retries", () => {
	const { clock, controller } = createController();
	controller.agentStart(null, false);
	clock.value = 1_500;
	controller.agentEnd();
	assert.equal(controller.getWidgetSnapshot().phase, "idle");

	const retry = {};
	controller.nativeStatusStart(retry, {
		kind: "retry",
		style: "retry",
		retry: { attempt: 1, maxRetries: 10, seconds: 2 },
	});
	const hiddenRetry = controller.getWidgetSnapshot();
	assert.equal(hiddenRetry.phase, "running");
	assert.equal(hiddenRetry.message, "Working…");
	assert.equal(hiddenRetry.retryMessage, undefined);
	assert.equal(hiddenRetry.stalledIntensity, 0);

	controller.nativeStatusUpdate(retry, {
		kind: "retry",
		style: "retry",
		retry: { attempt: 4, maxRetries: 10, seconds: 1 },
	});
	assert.equal(
		controller.getWidgetSnapshot().retryMessage,
		"Retrying in 1 second… (attempt 4/10)",
	);

	// A retry is one Claude turn: preserve its original spinner verb/timer when
	// Pi emits the next agent_start for the retry attempt.
	clock.value = 2_000;
	controller.agentStart(null, false);
	assert.equal(controller.state.agentStartedAtMs, 0);
	assert.equal(controller.state.randomVerb, "Working");
	controller.dispose();
});

test("compaction and branch summary use Claude's single system-compaction presentation", () => {
	const { controller } = createController();
	controller.agentStart(null, false);

	const compaction = {};
	controller.nativeStatusStart(compaction, {
		kind: "compaction",
		style: "system-requesting",
		message: "Compacting conversation…",
	});
	assert.equal(controller.getWidgetSnapshot().message, "Compacting conversation…");
	assert.equal(controller.getWidgetSnapshot().visualMode, "system-requesting");
	controller.nativeStatusEnd(compaction);
	assert.equal(controller.getWidgetSnapshot().phase, "hidden");

	const branchSummary = {};
	controller.nativeStatusStart(branchSummary, {
		kind: "branchSummary",
		style: "system-requesting",
		message: "Compacting conversation…",
	});
	assert.equal(controller.getWidgetSnapshot().message, "Compacting conversation…");
	assert.equal(controller.getWidgetSnapshot().visualMode, "system-requesting");
	controller.dispose();
});

test("bridge maps Pi retry countdowns to Claude semantics", () => {
	const widget = fakeComponent();
	const statusContainer = fakeContainer();
	const widgetContainer = fakeContainer([widget]);
	const tui = {
		children: [fakeContainer(), fakeContainer(), statusContainer, widgetContainer, fakeContainer()],
	} as unknown as TUI;
	const starts: Array<{ token: object; presentation: NativeStatusPresentation }> = [];
	const updates: Array<{ token: object; presentation: NativeStatusPresentation }> = [];
	const ends: object[] = [];
	const sink: NativeStatusSink = {
		nativeStatusStart(token, presentation) {
			starts.push({ token, presentation });
		},
		nativeStatusUpdate(token, presentation) {
			updates.push({ token, presentation });
		},
		nativeStatusEnd(token) {
			ends.push(token);
		},
	};

	const cleanup = installNativeStatusBridge(tui, widget, sink);
	assert.ok(cleanup);

	const retry = fakeIndicator("retry", "Retrying (4/10) in 2s... (esc to cancel)");
	statusContainer.addChild(retry);
	assert.deepEqual(statusContainer.children, []);
	assert.deepEqual(starts[0]?.presentation, {
		kind: "retry",
		style: "retry",
		retry: { attempt: 4, maxRetries: 10, seconds: 2 },
	});

	retry.setMessage("Retrying (4/10) in 1s... (esc to cancel)");
	assert.equal(retry.message, "Retrying (4/10) in 1s... (esc to cancel)");
	assert.deepEqual(updates[0]?.presentation, {
		kind: "retry",
		style: "retry",
		retry: { attempt: 4, maxRetries: 10, seconds: 1 },
	});
	retry.dispose();
	assert.deepEqual(ends, [retry]);

	// Unknown future content fails open instead of being swallowed.
	const unknown = fakeComponent();
	statusContainer.addChild(unknown);
	assert.deepEqual(statusContainer.children, [unknown]);
	cleanup();
});

test("summary retries stay on Compacting conversation instead of showing Pi retry UI", () => {
	const widget = fakeComponent();
	const statusContainer = fakeContainer();
	const widgetContainer = fakeContainer([widget]);
	const tui = {
		children: [fakeContainer(), fakeContainer(), statusContainer, widgetContainer, fakeContainer()],
	} as unknown as TUI;
	const starts: NativeStatusPresentation[] = [];
	const sink: NativeStatusSink = {
		nativeStatusStart(_token, presentation) {
			starts.push(presentation);
		},
		nativeStatusUpdate() {},
		nativeStatusEnd() {},
	};
	const cleanup = installNativeStatusBridge(tui, widget, sink);
	assert.ok(cleanup);

	const compaction = fakeIndicator("compaction", "Compacting context... (esc to cancel)");
	statusContainer.addChild(compaction);
	assert.deepEqual(starts[0], {
		kind: "compaction",
		style: "system-requesting",
		message: "Compacting conversation…",
	});

	// Pi showStatusIndicator() disposes the current status and synchronously adds
	// the retry status. The bridge recognizes this as a compaction retry.
	compaction.dispose();
	const retry = fakeIndicator("retry", "Retrying (1/3) in 2s... (esc to cancel)");
	statusContainer.addChild(retry);
	assert.deepEqual(starts[1], {
		kind: "retry",
		style: "system-requesting",
		message: "Compacting conversation…",
	});

	retry.dispose();
	const branchSummary = fakeIndicator("branchSummary", "Summarizing branch... (esc to cancel)");
	statusContainer.addChild(branchSummary);
	assert.deepEqual(starts[2], {
		kind: "branchSummary",
		style: "system-requesting",
		message: "Compacting conversation…",
	});
	cleanup();
});

test("bridge restores an active native indicator when the custom spinner is removed", () => {
	const widget = fakeComponent();
	const statusContainer = fakeContainer();
	const widgetContainer = fakeContainer([widget]);
	const tui = {
		children: [fakeContainer(), fakeContainer(), statusContainer, widgetContainer, fakeContainer()],
	} as unknown as TUI;
	const ended: object[] = [];
	const sink: NativeStatusSink = {
		nativeStatusStart() {},
		nativeStatusUpdate() {},
		nativeStatusEnd(token) {
			ended.push(token);
		},
	};
	const cleanup = installNativeStatusBridge(tui, widget, sink);
	assert.ok(cleanup);

	const compaction = fakeIndicator("compaction", "Compacting context...");
	statusContainer.addChild(compaction);
	assert.deepEqual(statusContainer.children, []);
	cleanup();
	assert.deepEqual(statusContainer.children, [compaction]);
	assert.deepEqual(ended, [compaction]);

	const nextRetry = fakeIndicator("retry", "Retrying...");
	statusContainer.addChild(nextRetry);
	assert.deepEqual(statusContainer.children, [compaction, nextRetry]);
});
