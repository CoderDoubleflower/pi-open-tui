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
import { SPINNER_WIDGET_KEY } from "../extensions/open-tui/spinner-widget.ts";
import {
	registerTodoIntegration,
	type TodoWriteDetails,
} from "../extensions/open-tui/todo.ts";
import { TODO_WIDGET_KEY, type TodoItem } from "../extensions/open-tui/todo-widget.ts";

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
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
	italic: (text: string) => text,
	strikethrough: (text: string) => `<s>${text}</s>`,
} as Theme;

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function setup(restoredTodos: TodoItem[] = []) {
	const eventBus = new FakeEventBus();
	const sessionHandlers = new Map<string, SessionHandler[]>();
	const widgets = new Map<string, Component & { dispose?(): void }>();
	let registeredTodoTool: { execute: (...args: any[]) => Promise<any> } | undefined;
	let renderRequests = 0;

	const tui = {
		requestRender() {
			renderRequests++;
		},
	} as unknown as TUI;

	const ctx = {
		hasUI: true,
		sessionManager: {
			getBranch() {
				if (restoredTodos.length === 0) return [];
				const details: TodoWriteDetails = { oldTodos: [], newTodos: restoredTodos };
				return [{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "TodoWrite",
						details,
					},
				}];
			},
		},
		ui: {
			theme,
			setWorkingVisible() {},
			setWidget(
				key: string,
				content: string[] | WidgetFactory | undefined,
				_options?: ExtensionWidgetOptions,
			) {
				const existing = widgets.get(key);
				existing?.dispose?.();
				if (content === undefined) {
					widgets.delete(key);
					return;
				}
				if (typeof content === "function") {
					widgets.set(key, content(tui, theme));
				}
			},
		},
	} as unknown as ExtensionContext;

	const pi = {
		events: eventBus.events,
		registerTool(tool: unknown) {
			registeredTodoTool = tool as { execute: (...args: any[]) => Promise<any> };
		},
		on(name: string, handler: SessionHandler) {
			const handlers = sessionHandlers.get(name) ?? [];
			handlers.push(handler);
			sessionHandlers.set(name, handlers);
		},
	} as unknown as ExtensionAPI;

	registerTodoIntegration(pi);
	for (const handler of sessionHandlers.get("session_start") ?? []) handler({}, ctx);

	const clock = new FakeClock();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.enabled = true;
	config.reducedMotion = true;
	config.taskIntegration = "events";
	const dependencies: SpinnerDependencies = {
		clock,
		random: new FixedRandom(),
		environment: { platform: "linux", env: {} },
		getVerbs: () => ["Working"],
	};
	const spinner = installSpinner(eventBus.events, ctx, () => config, dependencies)!;

	return {
		clock,
		config,
		ctx,
		registeredTodoTool: () => registeredTodoTool!,
		spinner,
		widgetOrder: () => [...widgets.keys()],
		renderWidget(key: string, width = 200): string[] {
			return widgets.get(key)?.render(width) ?? [];
		},
		renderRequests: () => renderRequests,
	};
}

test("spinner mounts above Todo and restored Todo activeForm drives spinner", () => {
	const restoredTodos: TodoItem[] = [
		{ content: "Inspect parser", status: "completed", activeForm: "Inspecting parser" },
		{ content: "Fix parser", status: "in_progress", activeForm: "Fixing parser" },
		{ content: "Run tests", status: "pending", activeForm: "Running tests" },
	];
	const result = setup(restoredTodos);

	assert.deepEqual(result.widgetOrder(), [SPINNER_WIDGET_KEY, TODO_WIDGET_KEY]);
	result.spinner.controller.agentStart(null, false);
	assert.match(result.renderWidget(SPINNER_WIDGET_KEY)[0] ?? "", /Fixing parser…/);
	assert.match(result.renderWidget(TODO_WIDGET_KEY).join("\n"), /Fix parser/);
	assert.equal(result.renderWidget(TODO_WIDGET_KEY).at(-1), "");
	result.spinner.dispose();
});

test("TodoWrite updates switch spinner to the current in-progress activeForm", async () => {
	const result = setup();
	result.spinner.controller.agentStart(null, false);
	assert.match(result.renderWidget(SPINNER_WIDGET_KEY)[0] ?? "", /Working…/);

	await result.registeredTodoTool().execute("todo-1", {
		todos: [
			{ content: "Implement parser", status: "in_progress", activeForm: "Implementing parser" },
			{ content: "Run tests", status: "pending", activeForm: "Running tests" },
		],
	});
	assert.match(result.renderWidget(SPINNER_WIDGET_KEY)[0] ?? "", /Implementing parser…/);

	await result.registeredTodoTool().execute("todo-2", {
		todos: [
			{ content: "Implement parser", status: "completed", activeForm: "Implementing parser" },
			{ content: "Run tests", status: "in_progress", activeForm: "Running tests" },
		],
	});
	assert.match(result.renderWidget(SPINNER_WIDGET_KEY)[0] ?? "", /Running tests…/);

	await result.registeredTodoTool().execute("todo-3", {
		todos: [
			{ content: "Implement parser", status: "completed", activeForm: "Implementing parser" },
			{ content: "Run tests", status: "completed", activeForm: "Running tests" },
		],
	});
	assert.match(result.renderWidget(SPINNER_WIDGET_KEY)[0] ?? "", /Working…/);
	assert.deepEqual(result.renderWidget(TODO_WIDGET_KEY), []);
	result.spinner.dispose();
});
