import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolRenderingConfig } from "./config.ts";
import { DEFAULT_TOOL_RENDERING_CONFIG } from "./config.ts";
import {
	buildClaudeDiffPreview,
	DIFF_ADDED_BACKGROUND,
	DIFF_REMOVED_BACKGROUND,
	renderClaudeDiffPreview,
	renderClaudeDiffPreviewSync,
	type ClaudeDiffPreview,
} from "./claude-diff.ts";
import {
	formatClaudeMcpToolResult,
	formatClaudeMcpToolUse,
	identifyClaudeMcpTool,
	type ClaudeMcpToolIdentity,
} from "./claude-mcp-tool.ts";
import {
	formatClaudeOpenAiToolResult,
	formatClaudeOpenAiToolUse,
	identifyClaudeOpenAiTool,
	type ClaudeOpenAiToolIdentity,
} from "./claude-openai-tool.ts";
import { formatClaudeToolResult } from "./claude-tool-results.ts";
import {
	applyOutputMode,
	asString,
	EXPAND_HINT,
	isObject,
	plural,
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
export {
	formatClaudeOpenAiToolResult,
	formatClaudeOpenAiToolUse,
	identifyClaudeOpenAiTool,
	type ClaudeOpenAiToolIdentity,
	type ClaudeOpenAiToolKind,
	type ClaudeOpenAiToolUse,
} from "./claude-openai-tool.ts";
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
const TOOL_HEADING_CONTINUATION = "  ";
const DIFF_INDENT = "     ";
const NATIVE_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const DIFF_RENDER_STATE = Symbol("open-tui:claude-diff-render-state");

// Backward-compatible exports used by existing tests and downstream themes.
export const EDIT_DIFF_ADDED_BACKGROUND = DIFF_ADDED_BACKGROUND;
export const EDIT_DIFF_REMOVED_BACKGROUND = DIFF_REMOVED_BACKGROUND;

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

export interface ClaudeToolComponentLike {
	toolName?: unknown;
	args?: unknown;
	cwd?: unknown;
	expanded?: unknown;
	isPartial?: unknown;
	executionStarted?: unknown;
	argsComplete?: unknown;
	result?: unknown;
	toolDefinition?: unknown;
	ui?: unknown;
	setExpanded?: (expanded: boolean) => void;
}

interface DiffRenderState {
	key: string;
	lines: string[];
}

export interface ClaudeToolRendererOptions {
	blink?: ClaudeToolBlinkController;
	prototype?: ToolPrototype;
	getConfig?: () => ToolRenderingConfig;
}

interface ToolIdentity {
	mcp?: ClaudeMcpToolIdentity;
	openAi?: ClaudeOpenAiToolIdentity;
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

function toolIdentity(tool: ClaudeToolComponentLike): ToolIdentity {
	const toolName = asString(tool.toolName);
	if (!toolName) return {};
	const mcp = identifyClaudeMcpTool(toolName, tool.toolDefinition, tool.args);
	if (mcp) return { mcp };
	return { openAi: identifyClaudeOpenAiTool(toolName, tool.toolDefinition) };
}

export function isClaudeRenderableTool(value: unknown): value is ClaudeToolComponentLike {
	if (!isObject(value)) return false;
	const toolName = asString(value.toolName);
	if (!toolName) return false;
	if (NATIVE_TOOLS.has(toolName.toLowerCase())) return true;
	return !!identifyClaudeMcpTool(toolName, value.toolDefinition, value.args)
		|| !!identifyClaudeOpenAiTool(toolName, value.toolDefinition);
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

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function renderToolHeading(title: string, detail: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (!detail) return new Text(title, 0, 0).render(safeWidth);
	const indentWidth = Math.min(TOOL_HEADING_CONTINUATION.length, Math.max(0, safeWidth - 1));
	const indent = TOOL_HEADING_CONTINUATION.slice(0, indentWidth);
	const contentWidth = Math.max(1, safeWidth - indentWidth);
	const detailLines = detail.replaceAll("\t", "   ").split("\n");
	const logicalLines = [`${title}(${detailLines[0] ?? ""}`, ...detailLines.slice(1)];
	logicalLines[logicalLines.length - 1] = `${logicalLines.at(-1) ?? ""})`;
	const rendered: string[] = [];
	for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex++) {
		const wrapped = wrapTextWithAnsi(logicalLines[lineIndex] ?? "", contentWidth);
		const fragments = wrapped.length > 0 ? wrapped : [""];
		for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
			const continuation = lineIndex > 0 || fragmentIndex > 0;
			rendered.push(padLine(`${continuation ? indent : ""}${fragments[fragmentIndex] ?? ""}`, safeWidth));
		}
	}
	return rendered;
}

function boldSummaryCounts(toolName: string, index: number, line: string, theme: Theme): string {
	if (index !== 0) return line;
	const lower = toolName.toLowerCase();
	if (lower === "write") {
		return line.replace(/^Wrote (\d+) lines? to (.+)$/, (_match, count: string, path: string) =>
			`Wrote ${theme.bold(count)} ${Number(count) === 1 ? "line" : "lines"} to ${theme.bold(path)}`,
		);
	}
	if (["read", "grep", "find", "ls"].includes(lower)) {
		return line.replace(/^(Read|Found) (\d+) /, (_match, verb: string, count: string) => `${verb} ${theme.bold(count)} `);
	}
	if (lower === "edit") {
		return line.replace(/\b(Added|removed|Removed) (\d+) /g, (_match, verb: string, count: string) => `${verb} ${theme.bold(count)} `);
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
	if (line.startsWith("⚠ ")) return theme.fg("warning", line);
	if (status === "error") return theme.fg("error", line);
	if (status === "pending" || status === "running") return `${DIM}${line}${DIM_RESET}`;
	if (line.startsWith("… +")) return `${DIM}${line}${DIM_RESET}`;
	if (toolName.toLowerCase() === "read" && line === "Unchanged since last read") return `${DIM}${line}${DIM_RESET}`;
	if (toolName.toLowerCase() === "bash" && ["(No output)", "Done"].includes(line)) return `${DIM}${line}${DIM_RESET}`;
	if (isMcp && line === "(No content)") return `${DIM}${line}${DIM_RESET}`;
	return dimExpandHint(boldSummaryCounts(toolName, index, line, theme));
}

function configurableMcpResult(
	result: unknown,
	status: ClaudeToolStatus,
	expanded: boolean,
	config: ToolRenderingConfig,
): string[] {
	const all = formatClaudeMcpToolResult(result, status, true);
	if (status === "pending" || status === "running" || status === "error") return all;
	const warnings = all.filter((line) => line.startsWith("⚠ "));
	const content = all.filter((line) => !line.startsWith("⚠ "));
	if (config.mcpOutputMode === "hidden") return warnings;
	const summary = content.length === 1 && content[0] === "(No content)"
		? "(No content)"
		: `Returned ${content.length} ${plural(content.length, "line")}`;
	return [...warnings, ...applyOutputMode(
		summary,
		content,
		config.mcpOutputMode,
		expanded,
		config.previewLines,
		config.expandedPreviewMaxLines,
	)];
}

function formatUse(
	tool: ClaudeToolComponentLike,
	identity: ToolIdentity,
	expanded: boolean,
): { name: string; detail: string } {
	const toolName = asString(tool.toolName) ?? "";
	const cwd = asString(tool.cwd);
	if (identity.mcp) return formatClaudeMcpToolUse(identity.mcp, tool.args, expanded);
	if (identity.openAi) return formatClaudeOpenAiToolUse(identity.openAi, tool.args, cwd, expanded);
	return formatClaudeToolUse(toolName, tool.args, cwd, expanded);
}

function formatResult(
	tool: ClaudeToolComponentLike,
	identity: ToolIdentity,
	status: ClaudeToolStatus,
	config: ToolRenderingConfig,
): string[] {
	const toolName = asString(tool.toolName) ?? "";
	const cwd = asString(tool.cwd);
	const expanded = tool.expanded === true;
	if (identity.mcp) return configurableMcpResult(tool.result, status, expanded, config);
	if (identity.openAi) {
		return formatClaudeOpenAiToolResult(identity.openAi, tool.args, tool.result, status, expanded, config);
	}
	return formatClaudeToolResult(toolName, tool.args, tool.result, status, cwd, expanded, config);
}

function diffRenderKey(preview: ClaudeDiffPreview, width: number, expanded: boolean, config: ToolRenderingConfig): string {
	return [
		preview.key,
		width,
		expanded ? 1 : 0,
		config.diffCollapsedLines,
		config.expandedPreviewMaxLines,
		config.diffLayout,
		config.diffTheme,
	].join(":");
}

function diffLinesForTool(
	tool: ClaudeToolComponentLike,
	theme: Theme,
	width: number,
	config: ToolRenderingConfig,
): string[] | undefined {
	const toolName = asString(tool.toolName);
	if (!toolName) return undefined;
	const preview = buildClaudeDiffPreview(
		toolName,
		tool.args,
		tool.result,
		asString(tool.cwd),
		tool.argsComplete !== false,
	);
	if (!preview) return undefined;
	const diffWidth = Math.max(20, width - DIFF_INDENT.length);
	const expanded = tool.expanded === true;
	const key = diffRenderKey(preview, diffWidth, expanded, config);
	const carrier = tool as ClaudeToolComponentLike & { [DIFF_RENDER_STATE]?: DiffRenderState };
	if (carrier[DIFF_RENDER_STATE]?.key === key) return carrier[DIFF_RENDER_STATE]!.lines;
	const options = { width: diffWidth, expanded, theme, config };
	const fallback = renderClaudeDiffPreviewSync(preview, options);
	carrier[DIFF_RENDER_STATE] = { key, lines: fallback };
	void renderClaudeDiffPreview(preview, options).then((lines) => {
		if (carrier[DIFF_RENDER_STATE]?.key !== key) return;
		carrier[DIFF_RENDER_STATE] = { key, lines };
		if (isRenderRequester(tool.ui)) tool.ui.requestRender();
	}).catch(() => {
		// The plain renderer is already installed as a safe fallback.
	});
	return fallback;
}

function renderResultBody(lines: readonly string[], width: number): string[] {
	if (lines.length === 0) return [];
	const safeWidth = Math.max(1, width);
	const fullIndentWidth = visibleWidth(DIFF_INDENT);
	const indentWidth = Math.min(fullIndentWidth, Math.max(0, safeWidth - 1));
	const continuationPrefix = DIFF_INDENT.slice(0, indentWidth);
	const firstPrefix = indentWidth === fullIndentWidth ? responsePrefix() : continuationPrefix;
	const contentWidth = Math.max(1, safeWidth - indentWidth);
	const rendered: string[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const normalizedLine = (lines[lineIndex] ?? "").replaceAll("\t", "   ");
		const wrapped = wrapTextWithAnsi(normalizedLine, contentWidth);
		const fragments = wrapped.length > 0 ? wrapped : [""];
		for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
			const prefix = lineIndex === 0 && fragmentIndex === 0 ? firstPrefix : continuationPrefix;
			rendered.push(padLine(`${prefix}${fragments[fragmentIndex] ?? ""}`, safeWidth));
		}
	}

	return rendered;
}

function renderClaudeTool(
	tool: ClaudeToolComponentLike,
	status: ClaudeToolStatus,
	blink: ClaudeToolBlinkController,
	theme: Theme,
	width: number,
	config: ToolRenderingConfig,
): string[] {
	const toolName = asString(tool.toolName) ?? "";
	const expanded = tool.expanded === true;
	const identity = toolIdentity(tool);
	const use = formatUse(tool, identity, expanded);
	const title = `${statusDot(status, blink, theme)} ${theme.bold(use.name)}`;
	const headingLines = renderToolHeading(title, use.detail, width);
	const rawResultLines = formatResult(tool, identity, status, config);
	const resultLines = rawResultLines.map((line, index) => styleResultLine(toolName, status, index, line, theme, !!identity.mcp));
	const diffLines = status === "error" ? undefined : diffLinesForTool(tool, theme, width, config);
	const body = renderResultBody(resultLines, width);
	return [
		"",
		...headingLines,
		...body,
		...(diffLines?.map((line) => `${DIFF_INDENT}${line}`) ?? []),
	];
}

export function installClaudeToolRenderer(
	getTheme: () => Theme,
	options: ClaudeToolRendererOptions = {},
): () => void {
	const prototype = options.prototype ?? ToolExecutionComponent.prototype;
	const blink = options.blink ?? new ClaudeToolBlinkController();
	const previousRender = prototype.render;
	const getConfig = options.getConfig ?? (() => DEFAULT_TOOL_RENDERING_CONFIG);
	const claudeRender = function (this: ClaudeToolComponentLike, width: number): string[] {
		const config = getConfig();
		if (!config.enabled || !isClaudeRenderableTool(this)) {
			if (typeof this === "object" && this) blink.remove(this);
			return previousRender.call(this, width);
		}
		const status = parseClaudeToolStatus(this);
		if (!status || !isRenderRequester(this.ui)) {
			if (typeof this === "object" && this) blink.remove(this);
			return previousRender.call(this, width);
		}
		blink.sync(this as object, this.ui, status === "running");
		try {
			return renderClaudeTool(this, status, blink, getTheme(), width, config);
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
