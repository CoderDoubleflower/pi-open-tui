import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_SPINNER_SUFFIX_CODE_POINTS,
	SPINNER_SUFFIX_EVENT,
	SpinnerSuffixStore,
	sanitizeSpinnerSuffix,
} from "../extensions/open-tui/spinner-suffix.ts";

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

test("suffix sources use last write, source-specific clear, and fallback", () => {
	const bus = new FakeEventBus();
	let changes = 0;
	const store = new SpinnerSuffixStore(bus.events, () => changes++);
	bus.events.emit(SPINNER_SUFFIX_EVENT, { version: 1, source: "one", suffix: "workspace" });
	bus.events.emit(SPINNER_SUFFIX_EVENT, { version: 1, source: "two", suffix: "tests" });
	assert.equal(store.suffix, "tests");
	bus.events.emit(SPINNER_SUFFIX_EVENT, { version: 1, source: "two", suffix: null });
	assert.equal(store.suffix, "workspace");
	assert.equal(changes, 3);
	store.dispose();
});

test("agent end clears agent scope and preserves session scope", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerSuffixStore(bus.events);
	bus.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "session",
		suffix: "repository",
		scope: "session",
	});
	bus.events.emit(SPINNER_SUFFIX_EVENT, {
		version: 1,
		source: "agent",
		suffix: "current turn",
	});
	assert.equal(store.suffix, "current turn");
	store.agentEnd();
	assert.equal(store.suffix, "repository");
	store.resetSession();
	assert.equal(store.suffix, null);
	store.dispose();
});

test("sanitizes one-line suffixes and enforces the code-point limit", () => {
	assert.equal(sanitizeSpinnerSuffix(" workspace "), "workspace");
	assert.equal(sanitizeSpinnerSuffix("项目 🔍"), "项目 🔍");
	assert.equal(sanitizeSpinnerSuffix(""), null);
	assert.equal(sanitizeSpinnerSuffix("line\nbreak"), null);
	assert.equal(sanitizeSpinnerSuffix("escape\x1b[31m"), null);
	assert.equal(sanitizeSpinnerSuffix("x".repeat(MAX_SPINNER_SUFFIX_CODE_POINTS)), "x".repeat(64));
	assert.equal(sanitizeSpinnerSuffix("🔍".repeat(MAX_SPINNER_SUFFIX_CODE_POINTS + 1)), null);
});

test("invalid suffix payloads do not replace the current value", () => {
	const bus = new FakeEventBus();
	let changes = 0;
	const store = new SpinnerSuffixStore(bus.events, () => changes++);
	bus.events.emit(SPINNER_SUFFIX_EVENT, { version: 1, source: "valid", suffix: "workspace" });
	for (const payload of [
		{ version: 2, source: "valid", suffix: "wrong version" },
		{ version: 1, source: "", suffix: "empty source" },
		{ version: 1, source: "valid", suffix: "bad\nsuffix" },
		{ version: 1, source: "valid", suffix: "wrong scope", scope: "turn" },
		{ version: 1, source: "valid", suffix: 42 },
	]) bus.events.emit(SPINNER_SUFFIX_EVENT, payload);
	assert.equal(store.suffix, "workspace");
	assert.equal(changes, 1);
	store.dispose();
});

test("dispose unsubscribes and ignores later events", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerSuffixStore(bus.events);
	assert.equal(bus.listenerCount(), 1);
	store.dispose();
	store.dispose();
	assert.equal(bus.listenerCount(), 0);
	bus.events.emit(SPINNER_SUFFIX_EVENT, { version: 1, source: "late", suffix: "late" });
	assert.equal(store.suffix, null);
});
