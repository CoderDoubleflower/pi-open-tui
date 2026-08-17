import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	installSpinner,
	type SpinnerDependencies,
} from "../extensions/open-tui/spinner.ts";
import type { SpinnerClock, SpinnerRandom } from "../extensions/open-tui/spinner-state.ts";
import { SPINNER_SUFFIX_EVENT } from "../extensions/open-tui/spinner-suffix.ts";

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

function setup() {
	const clock = new FakeClock();
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.enabled = true;
	let themeVersion = 1;
	const theme = {
		fg: (color: string, text: string) => `<v${themeVersion}:${color}>${text}</v${themeVersion}:${color}>`,
	} as Theme;
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<WorkingIndicatorOptions | undefined> = [];
	const ctx = {
		ui: {
			theme,
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
			setWorkingIndicator(indicator?: WorkingIndicatorOptions) {
				workingIndicators.push(indicator);
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
		workingMessages,
		workingIndicators,
		setThemeVersion(value: number) {
			themeVersion = value;
		},
	};
}

test("60 seconds of virtual ticks create no controller interval and write timer changes only", () => {
	const originalSetInterval = globalThis.setInterval;
	let scheduledIntervals = 0;
	globalThis.setInterval = ((..._args: unknown[]) => {
		scheduledIntervals++;
		return {} as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	try {
		const result = setup();
		result.config.verbose = true;
		result.installation.controller.agentStart(null, false);
		for (let tick = 1; tick <= 240; tick++) {
			result.clock.value = tick * 250;
			result.installation.controller.tick();
		}
		assert.equal(scheduledIntervals, 0);
		assert.equal(result.workingMessages.length, 61);
		assert.equal(result.workingMessages.at(-1), "Working… (1m 0s)");
		result.installation.dispose();
	} finally {
		globalThis.setInterval = originalSetInterval;
	}
});

test("provider token usage publishes immediately and unchanged ticks stay deduplicated", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.showTimer = false;
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	controller.messageUpdate(
		{ type: "text_delta", delta: "x".repeat(400) },
		{ input: 40, output: 100 },
	);
	assert.equal(result.workingMessages.at(-1), "Working… (↑ 40 tokens · ↓ 100 tokens)");
	const settledWrites = result.workingMessages.length;
	for (let tick = 1; tick <= 10; tick++) controller.tick();
	assert.equal(result.workingMessages.length, settledWrites);
	result.installation.dispose();
});

test("stream chunks without new provider usage do not write the working message", () => {
	const result = setup();
	result.config.verbose = true;
	result.config.showTimer = false;
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	const initialWrites = result.workingMessages.length;
	for (let index = 0; index < 400; index++) {
		controller.messageUpdate({ type: "text_delta", delta: "x" });
	}
	assert.equal(result.workingMessages.at(-1), "Working…");
	assert.equal(result.workingMessages.length, initialWrites);
	result.installation.dispose();
});

test("stall buckets and theme frame changes each trigger one indicator write", () => {
	const result = setup();
	const controller = result.installation.controller;
	controller.agentStart(null, false);
	const initialWrites = result.workingIndicators.length;
	result.clock.value = 3_250;
	controller.tick();
	assert.equal(result.workingIndicators.length, initialWrites + 1);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /warning/);
	for (const now of [3_500, 4_000, 4_500]) {
		result.clock.value = now;
		controller.tick();
	}
	assert.equal(result.workingIndicators.length, initialWrites + 1);
	result.clock.value = 5_000;
	controller.tick();
	assert.equal(result.workingIndicators.length, initialWrites + 2);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /error/);

	controller.refresh();
	assert.equal(result.workingIndicators.length, initialWrites + 2);
	result.setThemeVersion(2);
	controller.refresh();
	assert.equal(result.workingIndicators.length, initialWrites + 3);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /v2/);
	result.installation.dispose();
});

test("reduced motion publishes one static frame", () => {
	const result = setup();
	result.config.reducedMotion = true;
	result.installation.controller.refresh();
	assert.equal(result.workingIndicators.at(-1)?.frames?.length, 1);
	assert.match(result.workingIndicators.at(-1)?.frames?.[0] ?? "", /●/);
	assert.equal(result.workingIndicators.at(-1)?.intervalMs, undefined);
	result.installation.dispose();
});

test("dispose blocks ticks and events and repeated installs do not accumulate listeners", () => {
	const result = setup();
	result.installation.controller.agentStart(null, false);
	result.installation.dispose();
	const messageWrites = result.workingMessages.length;
	const indicatorWrites = result.workingIndicators.length;
	result.installation.controller.tick();
	result.events.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "late",
		suffix: "late",
	});
	assert.equal(result.workingMessages.length, messageWrites);
	assert.equal(result.workingIndicators.length, indicatorWrites);
	assert.equal(result.events.listenerCount(), 0);

	for (let cycle = 0; cycle < 100; cycle++) {
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
