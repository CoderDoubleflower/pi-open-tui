import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	SPINNER_MOUNTED_EVENT,
	SPINNER_TASKS_EVENT,
	type SpinnerTasksEventV1,
} from "./spinner-events.ts";
import {
	createTodoWidget,
	TODO_WIDGET_KEY,
	type TodoItem,
	type TodoWidgetSnapshot,
	type TodoWidgetSource,
} from "./todo-widget.ts";

const TodoItemSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, description: "A concise description of the task" }),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
		]),
		activeForm: Type.String({ minLength: 1, description: "Present-continuous form shown while the task is active" }),
	},
	{ additionalProperties: false },
);

const TodoWriteParameters = Type.Object(
	{
		todos: Type.Array(TodoItemSchema, { description: "The complete updated todo list" }),
	},
	{ additionalProperties: false },
);

export interface TodoWriteDetails {
	oldTodos: TodoItem[];
	newTodos: TodoItem[];
}

const HIDDEN_TOOL_ROW: Component = {
	invalidate() {},
	render() {
		return [];
	},
};

const TODO_SPINNER_SOURCE = "TodoWrite";

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

function storedTodosFromSubmitted(todos: readonly TodoItem[]): TodoItem[] {
	return todos.every((todo) => todo.status === "completed") ? [] : cloneTodos(todos);
}

function isTodoWriteDetails(value: unknown): value is TodoWriteDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TodoWriteDetails>;
	return Array.isArray(details.oldTodos) && Array.isArray(details.newTodos);
}

function isSpinnerMountedEvent(value: unknown): boolean {
	return !!value
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& (value as Record<string, unknown>).version === 1;
}

export class TodoController implements TodoWidgetSource {
	private todos: TodoItem[] = [];
	private requestRender: (() => void) | undefined;
	private revision = 0;
	private readonly events: ExtensionAPI["events"] | undefined;

	constructor(events?: ExtensionAPI["events"]) {
		this.events = events;
	}

	getWidgetSnapshot(): TodoWidgetSnapshot {
		return { todos: this.todos };
	}

	setRequestRender(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	getTodos(): TodoItem[] {
		return cloneTodos(this.todos);
	}

	replace(todos: readonly TodoItem[]): void {
		this.todos = cloneTodos(todos);
		this.publishSpinnerTasks();
		this.requestRender?.();
	}

	publishSpinnerTasks(): void {
		if (!this.events) return;
		const event: SpinnerTasksEventV1 = {
			version: 1,
			source: TODO_SPINNER_SOURCE,
			revision: ++this.revision,
			tasks: this.todos.map((todo, index) => ({
				id: index + 1,
				subject: todo.content,
				activeForm: todo.activeForm,
				status: todo.status,
			})),
		};
		this.events.emit(SPINNER_TASKS_EVENT, event);
	}

	reset(): void {
		this.replace([]);
	}
}

export interface TodoInstallation {
	dispose(): void;
}

export function installTodoWidget(ctx: ExtensionContext, controller: TodoController): TodoInstallation {
	ctx.ui.setWidget(
		TODO_WIDGET_KEY,
		(tui, theme) => createTodoWidget(tui, theme, controller),
		{ placement: "aboveEditor" },
	);

	return {
		dispose() {
			ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
			controller.setRequestRender(undefined);
		},
	};
}

function reconstructState(ctx: ExtensionContext, controller: TodoController): void {
	let restored: TodoItem[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "TodoWrite") continue;
		if (!isTodoWriteDetails(message.details)) continue;
		restored = storedTodosFromSubmitted(message.details.newTodos);
	}
	controller.replace(restored);
}

export function registerTodoWriteTool(pi: ExtensionAPI, controller: TodoController): void {
	pi.registerTool({
		name: "TodoWrite",
		label: "TodoWrite",
		description:
			"Replace the session todo list. Use it to keep multi-step work visible and update task status as work progresses.",
		promptSnippet: "TodoWrite: maintain a visible task checklist for multi-step work.",
		promptGuidelines: [
			"Use TodoWrite for multi-step tasks and keep exactly one task in_progress while actively working when practical.",
			"Each update replaces the entire list; preserve unfinished tasks and mark completed work promptly.",
			"Use activeForm as a present-continuous description such as 'Running tests'.",
		],
		parameters: TodoWriteParameters,
		renderShell: "self",
		async execute(_toolCallId, input) {
			const oldTodos = controller.getTodos();
			const submittedTodos = cloneTodos(input.todos);

			// Claude Code clears the stored list after an all-completed write while
			// returning the submitted completed list in the tool result.
			controller.replace(storedTodosFromSubmitted(submittedTodos));

			return {
				content: [
					{
						type: "text" as const,
						text: "Todos have been modified successfully. Continue using the todo list to track progress and proceed with the current tasks if applicable.",
					},
				],
				details: {
					oldTodos,
					newTodos: submittedTodos,
				} satisfies TodoWriteDetails,
			};
		},
		renderCall() {
			return HIDDEN_TOOL_ROW;
		},
		renderResult() {
			return HIDDEN_TOOL_ROW;
		},
	});
}

export function registerTodoIntegration(pi: ExtensionAPI): void {
	const controller = new TodoController(pi.events);
	let installation: TodoInstallation | undefined;
	let currentCtx: ExtensionContext | undefined;

	registerTodoWriteTool(pi, controller);

	pi.events.on(SPINNER_MOUNTED_EVENT, (data) => {
		if (!isSpinnerMountedEvent(data) || !currentCtx?.hasUI) return;

		// Pi keeps extension widgets in insertion order. Reinsert Todo after the
		// spinner mounts so the visual stack matches Claude: spinner, then tasks.
		installation?.dispose();
		installation = installTodoWidget(currentCtx, controller);

		// session_start reconstruction may have happened before the spinner
		// subscribed to task events, so replay the latest task snapshot now.
		controller.publishSpinnerTasks();
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		installation?.dispose();
		installation = undefined;
		reconstructState(ctx, controller);
		if (ctx.hasUI) installation = installTodoWidget(ctx, controller);
	});

	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx, controller);
	});

	pi.on("session_shutdown", () => {
		installation?.dispose();
		installation = undefined;
		controller.reset();
		currentCtx = undefined;
	});
}
