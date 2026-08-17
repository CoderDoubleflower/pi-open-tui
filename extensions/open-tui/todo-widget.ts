import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const TODO_WIDGET_KEY = "open-tui-todos";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}

export interface TodoWidgetSnapshot {
	todos: readonly TodoItem[];
	attachedToSpinner: boolean;
}

export interface TodoWidgetSource {
	getWidgetSnapshot(): TodoWidgetSnapshot;
	setRequestRender(requestRender: (() => void) | undefined): void;
}

function renderSummary(theme: Theme, todos: readonly TodoItem[]): string {
	const done = todos.filter((todo) => todo.status === "completed").length;
	const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
	const open = todos.filter((todo) => todo.status === "pending").length;
	const parts = [
		`${theme.bold(String(done))} done`,
		...(inProgress > 0 ? [`${theme.bold(String(inProgress))} in progress`] : []),
		`${theme.bold(String(open))} open`,
	];
	return theme.fg("dim", `${theme.bold(String(todos.length))} tasks (${parts.join(", ")})`);
}

function renderTodoContent(theme: Theme, todo: TodoItem): string {
	if (todo.status === "completed") {
		const content = theme.strikethrough(todo.content);
		return `${theme.fg("success", "✔")} ${theme.fg("dim", content)}`;
	}
	if (todo.status === "in_progress") {
		return `${theme.fg("accent", "◼")} ${theme.bold(todo.content)}`;
	}
	return `◻ ${todo.content}`;
}

function renderStandaloneTodoLine(theme: Theme, todo: TodoItem): string {
	return `  ${renderTodoContent(theme, todo)}`;
}

export function createTodoWidget(
	tui: TUI,
	theme: Theme,
	source: TodoWidgetSource,
): Component & { dispose(): void } {
	let disposed = false;
	const requestRender = () => {
		if (!disposed) tui.requestRender();
	};
	source.setRequestRender(requestRender);

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			source.setRequestRender(undefined);
		},
		invalidate() {},
		render(width: number): string[] {
			if (disposed || width <= 0) return [];
			const { todos, attachedToSpinner } = source.getWidgetSnapshot();
			if (todos.length === 0) return [];

			const ellipsis = theme.fg("dim", "...");
			if (attachedToSpinner) {
				const connector = theme.fg("dim", "  ⎿  ");
				const continuation = "     ";
				return [
					truncateToWidth(`${connector}${renderTodoContent(theme, todos[0]!)}`, width, ellipsis),
					...todos.slice(1).map((todo) =>
						truncateToWidth(`${continuation}${renderTodoContent(theme, todo)}`, width, ellipsis)),
					"",
				];
			}

			return [
				truncateToWidth(`  ${renderSummary(theme, todos)}`, width, ellipsis),
				...todos.map((todo) => truncateToWidth(renderStandaloneTodoLine(theme, todo), width, ellipsis)),
				"",
			];
		},
	};
}
