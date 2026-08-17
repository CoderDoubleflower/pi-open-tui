import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	SpinnerController,
	type SpinnerDependencies,
} from "../extensions/open-tui/spinner.ts";
import type { SpinnerClock, SpinnerRandom } from "../extensions/open-tui/spinner-state.ts";
import { createSpinnerWidget } from "../extensions/open-tui/spinner-widget.ts";

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

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

test("agent end freezes a Claude-style worked duration while compaction fully hides it", () => {
	const clock = new FakeClock();
	const events = new FakeEventBus();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.reducedMotion = true;
	const dependencies: SpinnerDependencies = {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	};
	const controller = new SpinnerController(events.events, () => config, dependencies);
	let renderRequests = 0;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	} as unknown as TUI;
	const widget = createSpinnerWidget(tui, theme, "other", controller);

	assert.equal(controller.state.phase, "hidden");
	assert.deepEqual(widget.render(120), []);

	controller.agentStart(null, false);
	assert.equal(controller.state.phase, "running");
	assert.equal(controller.state.active, true);
	assert.match(widget.render(120)[0] ?? "", /Working…/);
	assert.equal(widget.render(120)[1], "");

	clock.value = 5_000;
	controller.tick();
	assert.equal(controller.state.stalledIntensity, 1);

	controller.agentEnd();
	assert.equal(controller.state.phase, "idle");
	assert.equal(controller.state.active, false);
	assert.equal(controller.state.agentCompletedDurationMs, 5_000);
	assert.equal(controller.state.stalledIntensity, 0);
	assert.equal(controller.state.activeToolIds.size, 0);
	assert.match(widget.render(120)[0] ?? "", /✻ Worked for 5s/);
	assert.equal(widget.render(120)[1], "");

	const idleRenderRequests = renderRequests;
	clock.value = 60_000;
	controller.tick();
	assert.equal(controller.state.phase, "idle");
	assert.equal(controller.state.agentCompletedDurationMs, 5_000);
	assert.equal(controller.state.stalledIntensity, 0);
	assert.equal(renderRequests, idleRenderRequests);
	assert.match(widget.render(120)[0] ?? "", /✻ Worked for 5s/);

	controller.beforeCompact();
	assert.equal(controller.state.phase, "hidden");
	assert.deepEqual(widget.render(120), []);

	// A late/repeated agent_end after compaction must not resurrect the idle surface.
	controller.agentEnd();
	assert.equal(controller.state.phase, "hidden");
	assert.deepEqual(widget.render(120), []);

	widget.dispose();
	controller.dispose();
});
