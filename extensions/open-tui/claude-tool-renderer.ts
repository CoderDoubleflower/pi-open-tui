import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatClaudeMcpToolResult,
	formatClaudeMcpToolUse,
	identifyClaudeMcpTool,
	type ClaudeMcpToolIdentity,
} from "./claude-mcp-tool.ts";
import { formatClaudeToolResult } from "./claude-tool-results.ts";
import {
	asString,
	EXPAND_HINT,
	isObject,
	type ClaudeToolStatus,
} from "./claude-tool-renderer-shared.ts";
import { formatClaudeToolUse } from "./claude-tool-use.ts";

export {
	formatClaudeMcpToolResult,
	formatClaudeMcpToolUse,
	identifyClaudeMcpTool,
	type ClaudeMcpToolIdentity,
	type ClaudeMcpToolKind,
	type ClaudeMcpToolUse,
} from "./claude-mcp-tool.ts";
export { formatClaudeToolResult } from "./claude-tool-results.ts";
export {
	displayPath,
	type ClaudeToolStatus,
} from "./claude-tool-renderer-shared.ts";
export {
	formatClaudeToolUse,
	type ClaudeToolUse,
} from "./claude-tool-use.ts";

const DOT = "●";
const RESPONSE = "⎿";
const DIM = "\x1b[2m";
const DIM_RESET = "\x1b[22m";
const BACKGROUND_RESET = "\x1b[49m";
const EDIT_DIFF_INDENT = "     ";
export const EDIT_DIFF_ADDED_BACKGROUND = "\x1b[48;5;22m";
export const EDIT_DIFF_REMOVED_BACKGROUND = "\x1b[48;5;52m";
const NATIVE_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export interface BlinkScheduler {
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

interface RenderRequester {
	requestRender(): void;
}

export interface ToolPrototype {
	render(width: number): string[];
}

interface ToolInternals {
	toolName?: unknown;
	args?: unknown;
	cwd?: unknown;
	expanded?: unknown;
	isPartial?: unknown;
	executionStarted?: unknown;
	result?: unknown;
	toolDefinition?: unknown;
	ui?: unknown;
}

export interface ClaudeToolRendererOptions {
	blink?: ClaudeToolBlinkController;
	prototype?: ToolPrototype;
}

const defaultBlinkScheduler: BlinkScheduler = {
	setInterval: (callback, delayMs) => setInterval(callback, delayMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function parseClaudeToolStatus(value: unknown): ClaudeToolStatus | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.isPartial !== "boolean" || typeof value.executionStarted !== "boolean") return undefined;
	if (value.result !== undefined && value.isPartial === false) {
		if (!isObject(value.result) || typeof value.result.isError !== "boolean") return undefined;
		return value.result.isError ? "error" : "success";
	}
	return value.executionStarted ? "running" : "pending";
}

function isRenderRequester(value: unknown): value is RenderRequester {
	return isObject(value) && typeof value.requestRender === "function";
}

export class ClaudeToolBlinkController {
	private readonly scheduler: BlinkScheduler;
	private readonly running = new Map<object, RenderRequester>();
	private interval: unknown;
	private lit = true;

	constructor(scheduler: BlinkScheduler = defaultBlinkScheduler) {
		this.scheduler = scheduler;
	}

	isLit(): boolean {
		return this.lit;
	}

	runningCount(): number {
		return this.running.size;
	}

	sync(component: object, requester: RenderRequester, running: boolean): void {
		if (!running) {
			this.remove(component);
			return;
		}
		const first = this.running.size === 0;
		this.running.set(component, requester);
		if (!first) return;
		this.lit = true;
		this.interval = this.scheduler.setInterval(() => this.tick(), 600);
		(this.interval as { unref?: () => void } | undefined)?.unref?.();
	}

	remove(component: object): void {
		if (!this.running.delete(component) || this.running.size > 0) return;
		this.stop();
		this.lit = true;
	}

	dispose(): void {
		this.running.clear();
		this.stop();
		this.lit = true;
	}

	private tick(): void {
		this.lit = !this.lit;
		for (const requester of new Set(this.running.values())) {
			try {
				requester.requestRender();
			} catch {
				// A disposed TUI must not break the shared blink phase.
			}
		}
	}

	private stop(): void {
		if (this.interval === undefined) return;
		this.scheduler.clearInterval(this.interval);
		this.interval = undefined;
	}
}

function statusDot(status: ClaudeToolStatus, blink: ClaudeToolBlinkController, theme: Theme): string {
	if (status === "running" && !blink.isLit()) return " ";
	if (status === "pending" || status === "running") return `${DIM}${DOT}${DIM_RESET}`;
	return theme.fg(status === "success" ? "success" : "error", DOT);
}

function responsePrefix(): string {
	return `${DIM}  ${RESPONSE}  ${DIM_RESET}`;
}

function boldSummaryCounts(toolName: string, index: number, line: string, theme: Theme): string {
	if (index !== 0) return line;
	const lower = toolName.toLowerCase();
	if (lower === "write") {
		return line.replace(/^Wrote (\d+) lines to (.+)$/, (_match, count: string, path: string) =>
			`Wrote ${theme.bold(count)} lines to ${theme.bold(path)}`,
		);
	}
	if (lower === "read" || lower === "grep" || lower === "find" || lower === "ls") {
		return line.replace(/^(Read|Found) (\d+) /, (_match, verb: string, count: string) =>
			`${verb} ${theme.bold(count)} `,
		);
	}
	if (lower === "edit") {
		return line.replace(/\b(Added|removed|Removed) (\d+) /g, (_match, verb: string, count: string) =>
			`${verb} ${theme.bold(count)} `,
		);
	}
	return line;
}

function dimExpandHint(line: string): string {
	return line.replace(` ${EXPAND_HINT}`, ` ${DIM}${EXPAND_HINT}${DIM_RESET}`);
}

function styleResultLine(
	toolName: string,
	status: ClaudeToolStatus,
	index: number,
	line: string,
	theme: Theme,
	isMcp = false,
): string {
	if (isMcp && line.startsWith("⚠ ")) return theme.fg("warning", line);
	if (status === "error") return theme.fg("error", line);
	if (status === "pending" || status === "running") return `${DIM}${line}${DIM_RESET}`;
	const lower = toolName.toLowerCase();
	if (lower === "edit" && index > 0) {
		if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
		if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
		return theme.fg("toolDiffContext", line);
	}
	if (line.startsWith("… +")) return `${DIM}${line}${DIM_RESET}`;
	if (lower === "read" && line === "Unchanged since last read") return `${DIM}${line}${DIM_RESET}`;
	if (lower === "bash" && ["(No output)", "Done"].includes(line)) return `${DIM}${line}${DIM_RESET}`;
	if (isMcp && line === "(No content)") return `${DIM}${line}${DIM_RESET}`;
	return dimExpandHint(boldSummaryCounts(toolName, index, line, theme));
}

function editDiffBackground(line: string): string | undefined {
	if (line.startsWith("+") && !line.startsWith("+++")) return EDIT_DIFF_ADDED_BACKGROUND;
	if (line.startsWith("-") && !line.startsWith("---")) return EDIT_DIFF_REMOVED_BACKGROUND;
	return undefined;
}

function renderEditResultLines(
	rawResultLines: readonly string[],
	resultLines: readonly string[],
	width: number,
): string[] {
	if (resultLines.length === 0) return [];
	const safeWidth = Math.max(1, width);
	const rendered = new Text(`${responsePrefix()}${resultLines[0]}`, 0, 0).render(safeWidth);
	const indentWidth = Math.min(EDIT_DIFF_INDENT.length, Math.max(0, safeWidth - 1));
	const indent = EDIT_DIFF_INDENT.slice(0, indentWidth);
	const contentWidth = Math.max(1, safeWidth - indentWidth);

	for (let index = 1; index < resultLines.length; index++) {
		const background = editDiffBackground(rawResultLines[index] ?? "");
		const wrapped = new Text(resultLines[index] ?? "", 0, 0).render(contentWidth);
		for (const line of wrapped) {
			rendered.push(
				background
					? `${indent}${background}${line}${BACKGROUND_RESET}`
					: `${indent}${line}`,
			);
		}
	}
	return rendered;
}

function renderClaudeTool(
	tool: ToolInternals,
	status: ClaudeToolStatus,
	blink: ClaudeToolBlinkController,
	theme: Theme,
	width: number,
	mcpIdentity?: ClaudeMcpToolIdentity,
): string[] {
	const toolName = asString(tool.toolName) ?? "";
	const cwd = asString(tool.cwd);
	const expanded = tool.expanded === true;
	const use = mcpIdentity
		? formatClaudeMcpToolUse(mcpIdentity, tool.args, expanded)
		: formatClaudeToolUse(toolName, tool.args, cwd, expanded);
	const detail = use.detail ? `(${use.detail})` : "";
	const first = `${statusDot(status, blink, theme)} ${theme.bold(use.name)}${detail}`;
	const rawResultLines = mcpIdentity
		? formatClaudeMcpToolResult(tool.result, status, expanded)
		: formatClaudeToolResult(toolName, tool.args, tool.result, status, cwd, expanded);
	const resultLines = rawResultLines
		.map((line, index) => styleResultLine(toolName, status, index, line, theme, mcpIdentity !== undefined));

	if (
		mcpIdentity === undefined
		&& toolName.toLowerCase() === "edit"
		&& status === "success"
		&& resultLines.length > 1
	) {
		return [
			"",
			...new Text(first, 0, 0).render(width),
			...renderEditResultLines(rawResultLines, resultLines, width),
		];
	}

	const body = resultLines.length === 0
		? first
		: [first, `${responsePrefix()}${resultLines[0]}`, ...resultLines.slice(1).map((line) => `     ${line}`)].join("\n");
	// ToolExecutionComponent normally renders a leading Spacer(1). Replacing
	// its render method bypasses that child, so restore Claude's top margin here.
	return ["", ...new Text(body, 0, 0).render(width)];
}

export function installClaudeToolRenderer(
	getTheme: () => Theme,
	options: ClaudeToolRendererOptions = {},
): () => void {
	const prototype = options.prototype ?? ToolExecutionComponent.prototype;
	const blink = options.blink ?? new ClaudeToolBlinkController();
	const previousRender = prototype.render;
	const claudeRender = function (this: ToolInternals, width: number): string[] {
		const toolName = asString(this.toolName);
		const lowerToolName = toolName?.toLowerCase();
		// Extension definitions remain attached to ToolExecutionComponent at runtime.
		// Detect the adapter through its public tool names/labels so open-tui does
		// not import, re-register, or depend on pi-mcp-adapter load order.
		const mcpIdentity = toolName
			? identifyClaudeMcpTool(toolName, this.toolDefinition, this.args)
			: undefined;
		if (!lowerToolName || (!NATIVE_TOOLS.has(lowerToolName) && !mcpIdentity)) {
			if (typeof this === "object" && this) blink.remove(this);
			return previousRender.call(this, width);
		}
		const status = parseClaudeToolStatus(this);
		if (!status || !isRenderRequester(this.ui)) {
			blink.remove(this);
			return previousRender.call(this, width);
		}
		blink.sync(this, this.ui, status === "running");
		try {
			return renderClaudeTool(this, status, blink, getTheme(), width, mcpIdentity);
		} catch {
			return previousRender.call(this, width);
		}
	};

	prototype.render = claudeRender;
	return () => {
		blink.dispose();
		if (prototype.render === claudeRender) prototype.render = previousRender;
	};
}
