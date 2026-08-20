import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const DOT = "●";
const RESPONSE = "⎿";
const DIM = "\x1b[2m";
const DIM_RESET = "\x1b[22m";
const RGB_RESET = "\x1b[39m";
const SUCCESS_RGB = [78, 186, 101] as const;
const ERROR_RGB = [255, 107, 128] as const;
const NATIVE_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export type ClaudeToolStatus = "pending" | "running" | "success" | "error";

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

interface ToolResultLike {
	content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
	details?: unknown;
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

export interface ClaudeToolUse {
	name: string;
	detail: string;
}

export interface ClaudeToolRendererOptions {
	blink?: ClaudeToolBlinkController;
	prototype?: ToolPrototype;
}

const defaultBlinkScheduler: BlinkScheduler = {
	setInterval: (callback, delayMs) => setInterval(callback, delayMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function rgb([r, g, b]: readonly [number, number, number], text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RGB_RESET}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSlashes(value: string): string {
	return value.replaceAll("\\", "/");
}

export function displayPath(value: unknown, cwd?: string): string {
	const raw = asString(value);
	if (!raw) return "";
	const normalized = normalizeSlashes(raw);
	const normalizedCwd = cwd ? normalizeSlashes(cwd).replace(/\/$/, "") : "";
	if (normalizedCwd && normalized.startsWith(`${normalizedCwd}/`)) {
		return normalized.slice(normalizedCwd.length + 1);
	}
	return normalized;
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function oneLine(value: string): string {
	return value.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

function compactCommand(command: string, expanded: boolean): string {
	if (expanded) return oneLine(command);
	const flattened = oneLine(command);
	return flattened.length <= 160 ? flattened : `${flattened.slice(0, 157)}...`;
}

function patternDetail(args: Record<string, unknown>, cwd?: string): string {
	const pattern = asString(args.pattern) ?? "";
	const path = displayPath(args.path, cwd);
	let detail = `pattern: ${quote(pattern)}`;
	if (path) detail += `, path: ${quote(path)}`;
	return detail;
}

export function formatClaudeToolUse(
	toolName: string,
	argsValue: unknown,
	cwd?: string,
	expanded = false,
): ClaudeToolUse {
	const args = isObject(argsValue) ? argsValue : {};
	const lower = toolName.toLowerCase();
	if (lower === "read") {
		const path = displayPath(args.file_path ?? args.path, cwd);
		let detail = path;
		if (expanded) {
			const offset = asNumber(args.offset);
			const limit = asNumber(args.limit);
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				detail += limit !== undefined
					? ` · lines ${start}-${start + limit - 1}`
					: ` · from line ${start}`;
			}
		}
		return { name: "Read", detail };
	}
	if (lower === "write") {
		return { name: "Write", detail: displayPath(args.file_path ?? args.path, cwd) };
	}
	if (lower === "edit") {
		return { name: "Update", detail: displayPath(args.file_path ?? args.path, cwd) };
	}
	if (lower === "bash") {
		return { name: "Bash", detail: compactCommand(asString(args.command) ?? "", expanded) };
	}
	if (lower === "grep") {
		return { name: "Grep", detail: patternDetail(args, cwd) };
	}
	if (lower === "find") {
		return { name: "Search", detail: patternDetail(args, cwd) };
	}
	if (lower === "ls") {
		return { name: "List", detail: displayPath(args.path, cwd) || "." };
	}
	return { name: toolName, detail: "" };
}

function textOutput(result: ToolResultLike | undefined): string {
	if (!result?.content) return "";
	return result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trimEnd();
}

function nonEmptyLines(value: string): string[] {
	return value.split("\n").filter((line) => line.length > 0);
}

function logicalLineCount(value: string): number {
	if (!value) return 0;
	return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

function collapsedLines(lines: string[], expanded: boolean, limit = 10, fromTail = false): string[] {
	if (expanded || lines.length <= limit) return lines;
	const visible = fromTail ? lines.slice(-limit) : lines.slice(0, limit);
	const hidden = lines.length - visible.length;
	return fromTail
		? [`… ${hidden} earlier lines`, ...visible]
		: [...visible, `… +${hidden} lines (ctrl+o to expand)`];
}

function writeResult(args: Record<string, unknown>, cwd: string | undefined, expanded: boolean): string[] {
	const path = displayPath(args.file_path ?? args.path, cwd);
	const content = asString(args.content) ?? "";
	const count = logicalLineCount(content);
	const noun = count === 1 ? "line" : "lines";
	const preview = collapsedLines(content.split("\n"), expanded, 10);
	return [`Wrote ${count} ${noun} to ${path || "file"}`, ...preview.filter(Boolean)];
}

function editResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const details = isObject(result?.details) ? result?.details : undefined;
	const diff = details ? asString(details.diff) : undefined;
	if (!diff) return ["Updated file"];
	return collapsedLines(diff.split("\n"), expanded, 14);
}

function readResult(result: ToolResultLike | undefined): string[] {
	if (result?.content?.some((block) => block.type === "image")) return ["Read image"];
	const output = textOutput(result);
	const count = logicalLineCount(output);
	return [`Read ${count} ${count === 1 ? "line" : "lines"}`];
}

function countResult(label: string, result: ToolResultLike | undefined): string[] {
	const count = nonEmptyLines(textOutput(result)).length;
	return [`Found ${count} ${count === 1 ? label : `${label}s`}`];
}

function errorResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const lines = nonEmptyLines(textOutput(result));
	if (lines.length === 0) return ["Tool failed"];
	return expanded ? lines : lines.slice(0, 1);
}

export function formatClaudeToolResult(
	toolName: string,
	argsValue: unknown,
	resultValue: unknown,
	status: ClaudeToolStatus,
	cwd?: string,
	expanded = false,
): string[] {
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	const lower = toolName.toLowerCase();

	if (status === "pending") return [];
	if (status === "error") return errorResult(result, expanded);
	if (status === "running" && lower !== "bash") return [];

	if (lower === "bash") {
		const lines = nonEmptyLines(textOutput(result));
		if (status === "running" && lines.length === 0) return ["Running…"];
		return collapsedLines(lines, expanded, 10, true);
	}
	if (status === "running") return [];
	if (lower === "read") return readResult(result);
	if (lower === "write") return writeResult(args, cwd, expanded);
	if (lower === "edit") return editResult(result, expanded);
	if (lower === "grep") return countResult("line", result);
	if (lower === "find") return countResult("file", result);
	if (lower === "ls") return countResult("entry", result);
	return collapsedLines(nonEmptyLines(textOutput(result)), expanded, 10);
}

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

function statusDot(status: ClaudeToolStatus, blink: ClaudeToolBlinkController): string {
	if (status === "running" && !blink.isLit()) return " ";
	if (status === "pending" || status === "running") return `${DIM}${DOT}${DIM_RESET}`;
	return rgb(status === "success" ? SUCCESS_RGB : ERROR_RGB, DOT);
}

function responsePrefix(): string {
	return `${DIM}  ${RESPONSE}  ${DIM_RESET}`;
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
	const first = `${statusDot(status, blink)} ${theme.bold(use.name)}${detail}`;
	const resultLines = formatClaudeToolResult(toolName, tool.args, tool.result, status, cwd, expanded);
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
	const ownsBlink = options.blink === undefined;
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
		if (!ownsBlink) return;
	};
}
