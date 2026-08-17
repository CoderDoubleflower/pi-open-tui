import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SPINNER_OVERRIDE_EVENT,
	SPINNER_TASKS_EVENT,
	SpinnerEventStore,
} from "../extensions/open-tui/spinner-events.ts";

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

test("override sources use last write, source-specific clear, and scopes", () => {
	const bus = new FakeEventBus();
	let changes = 0;
	const store = new SpinnerEventStore(bus.events, () => changes++);
	bus.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "agent", message: "Agent work" });
	bus.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "session",
		message: "Session work...",
		scope: "session",
	});
	assert.equal(store.content.overrideMessage, "Session work");

	bus.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "session", message: null });
	assert.equal(store.content.overrideMessage, "Agent work");
	store.agentEnd();
	assert.equal(store.content.overrideMessage, null);
	assert.equal(changes, 4);
	store.dispose();
});

test("agent end preserves session-scoped override until session reset", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerEventStore(bus.events);
	bus.events.emit(SPINNER_OVERRIDE_EVENT, {
		version: 1,
		source: "session",
		message: "Session work",
		scope: "session",
	});
	store.agentEnd();
	assert.equal(store.content.overrideMessage, "Session work");
	store.resetSession();
	assert.equal(store.content.overrideMessage, null);
	store.dispose();
});

test("invalid override payloads are ignored rather than clearing valid state", () => {
	const bus = new FakeEventBus();
	let changes = 0;
	const store = new SpinnerEventStore(bus.events, () => changes++);
	bus.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "valid", message: "Working" });
	for (const payload of [
		{ version: 2, source: "valid", message: "Wrong version" },
		{ version: 1, source: "", message: "Empty source" },
		{ version: 1, source: "valid", message: "bad\nmessage" },
		{ version: 1, source: "valid", message: "Wrong scope", scope: "turn" },
	]) bus.events.emit(SPINNER_OVERRIDE_EVENT, payload);
	assert.equal(store.content.overrideMessage, "Working");
	assert.equal(changes, 1);
	store.dispose();
});

test("task snapshots enforce full validation, revision, and source order", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerEventStore(bus.events);
	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "one",
		revision: 1,
		tasks: [
			{ id: 1, subject: "Pending", status: "pending" },
			{ id: 2, subject: "Current", activeForm: "Doing current", status: "in_progress" },
			{ id: 3, subject: "Second", status: "in_progress" },
		],
	});
	assert.equal(store.content.currentTask?.id, 2);
	assert.equal(store.content.currentTask?.activeForm, "Doing current");

	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "one",
		revision: 1,
		tasks: [{ id: 9, subject: "Stale", status: "in_progress" }],
	});
	assert.equal(store.content.currentTask?.id, 2);

	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "two",
		revision: 0,
		tasks: [{ id: 10, subject: "Done", status: "completed" }],
	});
	assert.equal(store.content.currentTask, null);

	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "one",
		revision: 2,
		tasks: [{ id: 4, subject: "New current", status: "in_progress" }],
	});
	assert.equal((store.content.currentTask as { id: string | number } | null)?.id, 4);
	store.dispose();
});

test("invalid task snapshots do not consume their revision", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerEventStore(bus.events);
	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 1,
		tasks: [{ id: 1, subject: "Bad", status: "unknown" }],
	});
	assert.equal(store.content.currentTask, null);
	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 1,
		tasks: [{ id: 1, subject: "Good", status: "in_progress" }],
	});
	assert.equal((store.content.currentTask as { subject: string } | null)?.subject, "Good");
	store.dispose();
});

test("dispose unsubscribes both channels and reset allows fresh revisions", () => {
	const bus = new FakeEventBus();
	const store = new SpinnerEventStore(bus.events);
	assert.equal(bus.listenerCount(), 2);
	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 5,
		tasks: [{ id: 1, subject: "Old", status: "in_progress" }],
	});
	store.resetSession();
	bus.events.emit(SPINNER_TASKS_EVENT, {
		version: 1,
		source: "tasks",
		revision: 0,
		tasks: [{ id: 2, subject: "Fresh", status: "in_progress" }],
	});
	assert.equal(store.content.currentTask?.id, 2);
	store.dispose();
	assert.equal(bus.listenerCount(), 0);
	bus.events.emit(SPINNER_OVERRIDE_EVENT, { version: 1, source: "late", message: "Late" });
	assert.equal(store.content.overrideMessage, null);
});
