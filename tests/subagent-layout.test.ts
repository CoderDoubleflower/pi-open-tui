import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTodoIntegration } from "../extensions/open-tui/todo.ts";
import { TODO_WIDGET_KEY } from "../extensions/open-tui/todo-widget.ts";
import { SPINNER_MOUNTED_EVENT } from "../extensions/open-tui/spinner-events.ts";

const PANEL = "pi-simple-subagent-panel";
const SPINNER = "open-tui-spinner";
const PANEL_MOUNTED = "pi-simple-subagent:panel-mounted";
function harness() {
	const widgets = new Map<string, unknown>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const events = {
		on(name: string, fn: (data: unknown) => void) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; },
		emit(name: string, data: unknown) { for (const fn of [...listeners.get(name) ?? []]) fn(data); },
	};
	const ctx = { hasUI: true, sessionManager: { getBranch: () => [] }, ui: {
		setWidget(key: string, value: unknown) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
	} } as unknown as ExtensionContext;
	const pi = { events, registerTool() {}, on(name: string, fn: (event: never, ctx: ExtensionContext) => unknown) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
	const start = () => hooks.get("session_start")?.({} as never, ctx);
	const mountPanel = () => { widgets.delete(PANEL); widgets.set(PANEL, {}); events.emit(PANEL_MOUNTED, { version: 1 }); };
	const mountSpinner = () => { widgets.delete(SPINNER); widgets.set(SPINNER, {}); events.emit(SPINNER_MOUNTED_EVENT, { version: 1 }); };
	return { pi, ctx, events, widgets, hooks, start, mountPanel, mountSpinner };
}
describe("spinner / subagent / Todo layout", () => {
	for (const childListenerFirst of [true, false]) {
		it(`preserves order through spinner remounts (child listener first=${childListenerFirst})`, () => {
			const h = harness();
			if (childListenerFirst) h.events.on(SPINNER_MOUNTED_EVENT, h.mountPanel);
			registerTodoIntegration(h.pi);
			if (!childListenerFirst) h.events.on(SPINNER_MOUNTED_EVENT, h.mountPanel);
			h.start(); h.mountPanel(); h.mountSpinner();
			assert.deepEqual([...h.widgets.keys()], [SPINNER, PANEL, TODO_WIDGET_KEY]);
			h.mountSpinner(); assert.deepEqual([...h.widgets.keys()], [SPINNER, PANEL, TODO_WIDGET_KEY]);
			h.mountPanel(); assert.deepEqual([...h.widgets.keys()], [SPINNER, PANEL, TODO_WIDGET_KEY]);
		});
	}
	it("supports panel-before-Todo startup and does not revive Todo after shutdown", () => {
		const h = harness(); h.mountPanel(); registerTodoIntegration(h.pi); h.start();
		assert.deepEqual([...h.widgets.keys()], [PANEL, TODO_WIDGET_KEY]);
		h.hooks.get("session_shutdown")?.({} as never, h.ctx); h.mountPanel(); assert.deepEqual([...h.widgets.keys()], [PANEL]);
	});
	it("ignores malformed or incompatible layout events", () => {
		const h = harness(); registerTodoIntegration(h.pi); h.start(); h.widgets.set("other", {});
		for (const data of [null, {}, { version: 2 }, []]) h.events.emit(PANEL_MOUNTED, data);
		assert.deepEqual([...h.widgets.keys()], [TODO_WIDGET_KEY, "other"]);
	});
});
