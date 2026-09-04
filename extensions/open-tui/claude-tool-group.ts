import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRenderingConfig } from "./config.ts";
import {
	isClaudeRenderableTool,
	parseClaudeToolStatus,
	type ClaudeToolComponentLike,
} from "./claude-tool-renderer.ts";

const GROUP_MARK = Symbol("open-tui:claude-tool-group");
const NON_GROUPABLE_TOOL_NAMES = new Set([
	"ask_user_question",
	"exitplanmode",
	"exit_plan_mode",
	"plan_write",
	"planwrite",
	"spawn_agent",
	"send_input",
	"wait_agent",
	"close_agent",
	"list_agents",
]);

interface ParentContainer extends Component {
	children: Component[];
	addChild(component: Component): unknown;
	removeChild?(component: Component): unknown;
	clear?(): unknown;
}

interface GroupableTool extends Component, ClaudeToolComponentLike {
	setExpanded?: (expanded: boolean) => void;
}

export interface ClaudeToolGroupingInstallation {
	refresh(): void;
	dispose(): void;
	groupCount(): number;
}

export interface ClaudeToolGroupingOptions {
	containerPrototype?: ParentContainer;
	isTool?: (value: unknown) => value is GroupableTool;
}

function toolName(value: ClaudeToolComponentLike): string {
	return typeof value.toolName === "string" ? value.toolName.toLowerCase() : "";
}

function defaultIsTool(value: unknown): value is GroupableTool {
	return value instanceof ToolExecutionComponent
		&& isClaudeRenderableTool(value)
		&& !NON_GROUPABLE_TOOL_NAMES.has(toolName(value));
}

function isSpacer(value: Component): boolean {
	return value.constructor?.name === "Spacer";
}

function statusCounts(tools: readonly GroupableTool[]) {
	let pending = 0;
	let running = 0;
	let success = 0;
	let error = 0;
	for (const tool of tools) {
		const status = parseClaudeToolStatus(tool);
		if (status === "pending") pending++;
		else if (status === "running") running++;
		else if (status === "success") success++;
		else if (status === "error") error++;
	}
	return { pending, running, success, error };
}

function trimToolLines(lines: string[]): string[] {
	const result = [...lines];
	while (result.length > 0 && result[0]!.trim() === "") result.shift();
	while (result.length > 0 && result.at(-1)!.trim() === "") result.pop();
	return result;
}

function pad(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

class ClaudeToolGroupComponent extends Container {
	readonly [GROUP_MARK] = true;
	private readonly tools: GroupableTool[] = [];
	private readonly getTheme: () => Theme;
	private parent: ParentContainer | undefined;
	private expanded = false;

	constructor(getTheme: () => Theme) {
		super();
		this.getTheme = getTheme;
	}

	setParent(parent: ParentContainer | undefined): void {
		this.parent = parent;
	}

	getParent(): ParentContainer | undefined {
		return this.parent;
	}

	getTools(): GroupableTool[] {
		return [...this.tools];
	}

	addTool(tool: GroupableTool): void {
		this.tools.push(tool);
		tool.setExpanded?.(this.expanded);
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded?.(expanded);
		this.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0 || this.tools.length === 0) return [];
		const theme = this.getTheme();
		const counts = statusCounts(this.tools);
		const active = counts.pending + counts.running > 0;
		const dotColor = counts.error > 0 ? "error" : active ? "dim" : "success";
		const verb = active ? "Running" : counts.error > 0 ? "Ran" : "Ran";
		const header = `${theme.fg(dotColor, "●")} ${theme.bold(`${verb} ${this.tools.length} tools`)}`;
		const lines: string[] = ["", pad(header, width)];
		const branchWidth = 3;
		const childWidth = Math.max(1, width - branchWidth);

		for (let index = 0; index < this.tools.length; index++) {
			const tool = this.tools[index]!;
			const last = index === this.tools.length - 1;
			const rendered = trimToolLines(tool.render(childWidth));
			if (rendered.length === 0) continue;
			const firstPrefix = theme.fg("dim", last ? "└─ " : "├─ ");
			const restPrefix = theme.fg("dim", last ? "   " : "│  ");
			for (let lineIndex = 0; lineIndex < rendered.length; lineIndex++) {
				lines.push(`${lineIndex === 0 ? firstPrefix : restPrefix}${rendered[lineIndex] ?? ""}`);
			}
		}
		return lines;
	}
}

function isToolGroup(value: unknown): value is ClaudeToolGroupComponent {
	return !!value && typeof value === "object" && (value as { [GROUP_MARK]?: unknown })[GROUP_MARK] === true;
}

function previousToolSibling(
	children: Component[],
	start: number,
	isTool: (value: unknown) => value is GroupableTool,
): { index: number; child: GroupableTool | ClaudeToolGroupComponent; spacers: number[] } | undefined {
	const spacers: number[] = [];
	for (let index = start; index >= 0; index--) {
		const child = children[index]!;
		if (isSpacer(child)) {
			spacers.push(index);
			continue;
		}
		return isTool(child) || isToolGroup(child) ? { index, child, spacers } : undefined;
	}
	return undefined;
}

export function installClaudeToolGrouping(
	getTheme: () => Theme,
	getConfig: () => ToolRenderingConfig,
	options: ClaudeToolGroupingOptions = {},
): ClaudeToolGroupingInstallation {
	const prototype = options.containerPrototype ?? Container.prototype as unknown as ParentContainer;
	const isTool = options.isTool ?? defaultIsTool;
	const originalAddChild = prototype.addChild;
	const originalRemoveChild = prototype.removeChild;
	const originalClear = prototype.clear;
	const activeGroups = new Set<ClaudeToolGroupComponent>();
	let disposed = false;

	const ungroup = (group: ClaudeToolGroupComponent) => {
		const parent = group.getParent();
		const children = parent?.children;
		if (children) {
			const index = children.indexOf(group);
			if (index >= 0) children.splice(index, 1, ...group.getTools());
		}
		group.setParent(undefined);
		activeGroups.delete(group);
	};

	const ungroupAll = () => {
		for (const group of [...activeGroups]) ungroup(group);
	};

	const maybeGroup = (parent: ParentContainer, component: Component) => {
		if (disposed || !getConfig().enabled || !getConfig().groupToolCalls) return;
		if (isToolGroup(parent) || !isTool(component) || !Array.isArray(parent.children)) return;
		const currentIndex = parent.children.indexOf(component);
		if (currentIndex <= 0) return;
		const previous = previousToolSibling(parent.children, currentIndex - 1, isTool);
		if (!previous) return;

		// Remove spacer components between adjacent tool calls. The group owns its
		// own top margin and branch spacing.
		for (const spacerIndex of previous.spacers.sort((a, b) => b - a)) {
			parent.children.splice(spacerIndex, 1);
		}
		const adjustedCurrentIndex = parent.children.indexOf(component);
		if (isToolGroup(previous.child)) {
			parent.children.splice(adjustedCurrentIndex, 1);
			previous.child.addTool(component);
			return;
		}

		const previousIndex = parent.children.indexOf(previous.child);
		if (previousIndex < 0 || adjustedCurrentIndex < 0) return;
		const group = new ClaudeToolGroupComponent(getTheme);
		group.setParent(parent);
		group.addTool(previous.child);
		group.addTool(component);
		parent.children[previousIndex] = group;
		parent.children.splice(parent.children.indexOf(component), 1);
		activeGroups.add(group);
	};

	const patchedAddChild = function (this: ParentContainer, component: Component): unknown {
		const result = originalAddChild.call(this, component);
		maybeGroup(this, component);
		return result;
	};
	prototype.addChild = patchedAddChild;

	if (typeof originalRemoveChild === "function") {
		prototype.removeChild = function (this: ParentContainer, component: Component): unknown {
			if (isToolGroup(component)) {
				component.setParent(undefined);
				activeGroups.delete(component);
			}
			return originalRemoveChild.call(this, component);
		};
	}
	if (typeof originalClear === "function") {
		prototype.clear = function (this: ParentContainer): unknown {
			for (const child of this.children ?? []) {
				if (isToolGroup(child)) {
					child.setParent(undefined);
					activeGroups.delete(child);
				}
			}
			return originalClear.call(this);
		};
	}

	return {
		refresh() {
			if (!getConfig().enabled || !getConfig().groupToolCalls) ungroupAll();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			ungroupAll();
			if (prototype.addChild === patchedAddChild) prototype.addChild = originalAddChild;
			if (typeof originalRemoveChild === "function") prototype.removeChild = originalRemoveChild;
			if (typeof originalClear === "function") prototype.clear = originalClear;
		},
		groupCount: () => activeGroups.size,
	};
}
