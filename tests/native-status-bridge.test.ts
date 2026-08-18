import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	installNativeStatusBridge,
	type NativeStatusKind,
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

test("controller renders retry and compaction as transient custom spinner activities", () => {
	const clock = new FakeClock();
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	const controller = new SpinnerController(events.events, () => config, {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	});

	controller.agentStart(null, false);
	clock.value = 1_500;
	controller.agentEnd();
	assert.equal(controller.getWidgetSnapshot().phase, "idle");

	const retry = {};
	controller.nativeStatusStart(retry, "retry", "Retrying (1/3) in 2s...");
	assert.equal(controller.getWidgetSnapshot().phase, "running");
	assert.equal(controller.getWidgetSnapshot().message, "Retrying (1/3) in 2s...");
	assert.equal(controller.getWidgetSnapshot().stalledIntensity, 0);

	controller.nativeStatusUpdate(retry, "Retrying (1/3) in 1s...");
	assert.equal(controller.getWidgetSnapshot().message, "Retrying (1/3) in 1s...");
	controller.nativeStatusEnd(retry);
	assert.equal(controller.getWidgetSnapshot().phase, "hidden");

	const compaction = {};
	controller.nativeStatusStart(compaction, "compaction", "Compacting context...");
	assert.equal(controller.getWidgetSnapshot().message, "Compacting context...");
	controller.nativeStatusEnd(compaction);
	assert.equal(controller.getWidgetSnapshot().phase, "hidden");
	controller.dispose();
});

test("bridge suppresses supported Pi status indicators and mirrors live message updates", () => {
	const widget = fakeComponent();
	const statusContainer = fakeContainer();
	const widgetContainer = fakeContainer([widget]);
	const tui = {
		children: [fakeContainer(), fakeContainer(), statusContainer, widgetContainer, fakeContainer()],
	} as unknown as TUI;
	const starts: Array<{ token: object; kind: NativeStatusKind; message: string }> = [];
	const updates: Array<{ token: object; message: string }> = [];
	const ends: object[] = [];
	const sink: NativeStatusSink = {
		nativeStatusStart(token, kind, message) {
			starts.push({ token, kind, message });
		},
		nativeStatusUpdate(token, message) {
			updates.push({ token, message });
		},
		nativeStatusEnd(token) {
			ends.push(token);
		},
	};

	const cleanup = installNativeStatusBridge(tui, widget, sink);
	assert.ok(cleanup);

	const retry = fakeIndicator("retry", "Retrying (1/3) in 2s...");
	statusContainer.addChild(retry);
	assert.deepEqual(statusContainer.children, []);
	assert.deepEqual(starts.map(({ kind, message }) => ({ kind, message })), [
		{ kind: "retry", message: "Retrying (1/3) in 2s..." },
	]);

	retry.setMessage("Retrying (1/3) in 1s...");
	assert.equal(retry.message, "Retrying (1/3) in 1s...");
	assert.deepEqual(updates.map(({ message }) => message), ["Retrying (1/3) in 1s..."]);
	retry.dispose();
	assert.deepEqual(ends, [retry]);

	// Unknown future content fails open instead of being swallowed.
	const unknown = fakeComponent();
	statusContainer.addChild(unknown);
	assert.deepEqual(statusContainer.children, [unknown]);
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
