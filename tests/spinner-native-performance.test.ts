import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionWidgetOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	installSpinner,
	type SpinnerDependencies,
} from "../extensions/open-tui/spinner.ts";
import type { SpinnerClock, SpinnerRandom } from "../extensions/open-tui/spinner-state.ts";
import { SPINNER_SUFFIX_EVENT } from "../extensions/open-tui/spinner-suffix.ts";
import { SPINNER_WIDGET_INTERVAL_MS } from "../extensions/open-tui/spinner-widget.ts";

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
} as Theme;

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

function setup() {
	const clock = new FakeClock();
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.enabled = true;
	config.reducedMotion = true;
	let renderRequests = 0;
	let widget: (Component & { dispose?(): void }) | undefined;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	} as unknown as TUI;
	const ctx = {
		ui: {
			theme,
			setWorkingVisible() {},
			setWidget(
				_key: string,
				content: string[] | WidgetFactory | undefined,
				_options?: ExtensionWidgetOptions,
			) {
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
	const installation = installSpinner(events.events, ctx, () => config, dependencies)!;
	return {
		clock,
		events,
		config,
		ctx,
		dependencies,
		installation,
		renderRequests: () => renderRequests,
		renderWidget: () => widget?.render(120) ?? [],
	};
}

test("custom widget keeps the original 120ms animation cadence", () => {
	assert.equal(SPINNER_WIDGET_INTERVAL_MS, 120);
});

test("60 seconds of controller ticks are deduplicated to visible timer changes", () => {
	const result = setup();
	result.config.verbose = true;
	result.installation.controller.agentStart(null, false);
	const beforeTicks = result.renderRequests();
	for (let tick = 1; tick <= 240; tick++) {
		result.clock.value = tick * 250;
		result.installation.controller.tick();
	}
	const tickRequests = result.renderRequests() - beforeTicks;
	assert.ok(tickRequests >= 55 && tickRequests <= 65, `unexpected render count: ${tickRequests}`);
	assert.match(result.renderWidget()[0] ?? "", /1m 0s/);
	result.installation.dispose();
});

test("stream chunks without visible segments do not request extra renders", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.showTimer = false;
	result.config.showTokens = false;
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	controller.messageUpdate({ type: "text_start" });
	const settledRequests = result.renderRequests();
	for (let index = 0; index < 400; index++) {
		controller.messageUpdate({ type: "text_delta", delta: "x" });
	}
	assert.equal(result.renderRequests(), settledRequests);
	assert.match(result.renderWidget()[0] ?? "", /Working…/);
	result.installation.dispose();
});

test("streamed response length, not provider usage, drives the visible token counter", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.showTimer = false;
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	const beforeUsage = result.renderRequests();
	controller.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(400) },
		{ input: 40, output: 100 },
	);
	assert.equal(result.renderRequests(), beforeUsage + 1);
	assert.match(result.renderWidget()[0] ?? "", /↓ 100 tokens/);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /↑ 40 tokens/);

	const settledRequests = result.renderRequests();
	controller.messageUpdate({ type: "done" }, { input: 4_000, output: 2_000 });
	assert.equal(result.renderRequests(), settledRequests);
	assert.equal(controller.state.inputTokens, 4_000);
	assert.equal(controller.state.outputTokens, 2_000);
	result.installation.dispose();
});

test("non-reduced token counter smoothly catches up instead of snapping", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.showTimer = false;
	result.config.reducedMotion = false;
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	controller.messageUpdate({ type: "text_delta", delta: "x".repeat(400) });
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /tokens/);

	result.clock.value = 250;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /↓ 63 tokens/);
	assert.doesNotMatch(result.renderWidget()[0] ?? "", /↓ 100 tokens/);

	result.clock.value = 5_000;
	controller.tick();
	assert.match(result.renderWidget()[0] ?? "", /↓ 100 tokens/);
	result.installation.dispose();
});

test("stall transitions request renders only when the visible color bucket changes", () => {
	const result = setup();
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	const initialRequests = result.renderRequests();

	result.clock.value = 3_250;
	controller.tick();
	assert.equal(result.renderRequests(), initialRequests + 1);
	assert.match(result.renderWidget()[0] ?? "", /warning/);

	for (const now of [3_500, 4_000, 4_500]) {
		result.clock.value = now;
		controller.tick();
	}
	assert.equal(result.renderRequests(), initialRequests + 1);

	result.clock.value = 5_000;
	controller.tick();
	assert.equal(result.renderRequests(), initialRequests + 2);
	assert.match(result.renderWidget()[0] ?? "", /error/);
	result.installation.dispose();
});

test("dispose blocks late ticks/events and repeated installs do not accumulate listeners", () => {
	const result = setup();
	result.installation.controller.agentStart(null, false);
	result.installation.dispose();
	const requests = result.renderRequests();
	result.installation.controller.tick();
	result.events.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "late",
		suffix: "late",
	});
	assert.equal(result.renderRequests(), requests);
	assert.equal(result.events.listenerCount(), 0);

	for (let cycle = 0; cycle < 20; cycle++) {
		const installation = installSpinner(
			result.events.events,
			result.ctx,
			() => result.config,
			result.dependencies,
		)!;
		assert.equal(result.events.listenerCount(), 3);
		installation.dispose();
		assert.equal(result.events.listenerCount(), 0);
	}
});
