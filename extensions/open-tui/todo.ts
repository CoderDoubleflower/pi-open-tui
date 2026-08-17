import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
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

type TodoWriteInput = Static<typeof TodoWriteParameters>;

export interface TodoWriteDetails {
	oldTodos: TodoItem[];
	newTodos: TodoItem[];
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

export class TodoController implements TodoWidgetSource {
	private todos: TodoItem[] = [];
	private requestRender: (() => void) | undefined;

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
		this.requestRender?.();
	}

	reset(): void {
		if (this.todos.length === 0) return;
		this.todos = [];
		this.requestRender?.();
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
		async execute(_toolCallId, input: TodoWriteInput) {
			const oldTodos = controller.getTodos();
			const submittedTodos = cloneTodos(input.todos);
			const allDone = submittedTodos.every((todo) => todo.status === "completed");

			// Claude Code clears the stored list after an all-completed write while
			// returning the submitted completed list in the tool result.
			controller.replace(allDone ? [] : submittedTodos);

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
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	});
}

export function registerTodoIntegration(pi: ExtensionAPI): void {
	const controller = new TodoController();
	let installation: TodoInstallation | undefined;

	registerTodoWriteTool(pi, controller);

	pi.on("session_start", (_event, ctx) => {
		installation?.dispose();
		installation = undefined;
		controller.reset();
		if (ctx.hasUI) {
			installation = installTodoWidget(ctx, controller);
		}
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		installation?.dispose();
		installation = undefined;
		controller.reset();
	});
}
