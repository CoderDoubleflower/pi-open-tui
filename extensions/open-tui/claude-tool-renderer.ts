import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatClaudeToolResult } from "./claude-tool-results.ts";
import {
	asString,
	EXPAND_HINT,
	isObject,
	type ClaudeToolStatus,
} from "./claude-tool-renderer-shared.ts";
import { formatClaudeToolUse } from "./claude-tool-use.ts";

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
): string {
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
	return dimExpandHint(boldSummaryCounts(toolName, index, line, theme));
}

function renderClaudeTool(
	tool: ToolInternals,
	status: ClaudeToolStatus,
	blink: ClaudeToolBlinkController,
	theme: Theme,
	width: number,
): string[] {
	const toolName = asString(tool.toolName) ?? "";
	const cwd = asString(tool.cwd);
	const expanded = tool.expanded === true;
	const use = formatClaudeToolUse(toolName, tool.args, cwd, expanded);
	const detail = use.detail ? `(${use.detail})` : "";
	const first = `${statusDot(status, blink, theme)} ${theme.bold(use.name)}${detail}`;
	const resultLines = formatClaudeToolResult(toolName, tool.args, tool.result, status, cwd, expanded)
		.map((line, index) => styleResultLine(toolName, status, index, line, theme));
	const body = resultLines.length === 0
		? first
		: [first, `${responsePrefix()}${resultLines[0]}`, ...resultLines.slice(1).map((line) => `     ${line}`)].join("\n");
	return new Text(body, 0, 0).render(width);
}

export function installClaudeToolRenderer(
	getTheme: () => Theme,
	options: ClaudeToolRendererOptions = {},
): () => void {
	const prototype = options.prototype ?? ToolExecutionComponent.prototype;
	const blink = options.blink ?? new ClaudeToolBlinkController();
	const previousRender = prototype.render;
	const claudeRender = function (this: ToolInternals, width: number): string[] {
		const toolName = asString(this.toolName)?.toLowerCase();
		if (!toolName || !NATIVE_TOOLS.has(toolName)) {
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
			return renderClaudeTool(this, status, blink, getTheme(), width);
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
