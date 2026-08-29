import type { ToolRenderingConfig } from "./config.ts";
import {
	applyOutputMode,
	asString,
	displayPath,
	isObject,
	logicalLineCount,
	plural,
	structuredTextOutput,
	textOutput,
	type ClaudeToolStatus,
	type ToolResultLike,
} from "./claude-tool-renderer-shared.ts";
import { parseApplyPatchPreview } from "./claude-diff.ts";

export type ClaudeOpenAiToolKind =
	| "apply-patch"
	| "shell"
	| "web-search"
	| "web-fetch"
	| "task"
	| "context"
	| "generic";

export interface ClaudeOpenAiToolIdentity {
	kind: ClaudeOpenAiToolKind;
	name: string;
}

export interface ClaudeOpenAiToolUse {
	name: string;
	detail: string;
}

const KNOWN_TOOLS: Record<string, ClaudeOpenAiToolIdentity> = {
	apply_patch: { kind: "apply-patch", name: "Apply Patch" },
	shell_command: { kind: "shell", name: "Shell" },
	exec_command: { kind: "shell", name: "Shell" },
	run_command: { kind: "shell", name: "Shell" },
	web_search: { kind: "web-search", name: "Web Search" },
	websearch: { kind: "web-search", name: "Web Search" },
	search_web: { kind: "web-search", name: "Web Search" },
	web_fetch: { kind: "web-fetch", name: "Web Fetch" },
	webfetch: { kind: "web-fetch", name: "Web Fetch" },
	fetch_content: { kind: "web-fetch", name: "Fetch Content" },
	fetch_url: { kind: "web-fetch", name: "Fetch URL" },
	task: { kind: "task", name: "Task" },
	task_list: { kind: "task", name: "Task List" },
	tasklist: { kind: "task", name: "Task List" },
	task_output: { kind: "task", name: "Task Output" },
	taskoutput: { kind: "task", name: "Task Output" },
	task_stop: { kind: "task", name: "Task Stop" },
	taskstop: { kind: "task", name: "Task Stop" },
	context: { kind: "context", name: "Context" },
	context_search: { kind: "context", name: "Context Search" },
	context_read: { kind: "context", name: "Context Read" },
};

function normalizeName(value: string): string {
	return value.trim().replace(/[\s-]+/g, "_").toLowerCase();
}

function definitionLabel(value: unknown): string | undefined {
	return isObject(value) && typeof value.label === "string" ? value.label.trim() : undefined;
}

function humanize(value: string): string {
	return value
		.replace(/^multi_tool_use\./, "")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function identifyClaudeOpenAiTool(
	toolName: string,
	toolDefinition: unknown,
): ClaudeOpenAiToolIdentity | undefined {
	const normalized = normalizeName(toolName);
	const exact = KNOWN_TOOLS[normalized];
	if (exact) return exact;

	const label = definitionLabel(toolDefinition);
	if (/^MCP:/i.test(label ?? "")) return undefined;
	const normalizedLabel = label ? normalizeName(label) : "";
	const byLabel = normalizedLabel ? KNOWN_TOOLS[normalizedLabel] : undefined;
	if (byLabel) return byLabel;

	if (/^(web|fetch|task|context)_/.test(normalized)) {
		return { kind: "generic", name: label || humanize(toolName) };
	}
	return undefined;
}

function safeJson(value: unknown): string {
	try {
		const result = JSON.stringify(value);
		return result === undefined ? String(value) : result;
	} catch {
		return String(value);
	}
}

function compactValue(value: unknown, expanded: boolean): string {
	const rendered = typeof value === "string" ? value : safeJson(value);
	const limit = expanded ? 400 : 100;
	return rendered.length > limit ? `${rendered.slice(0, limit).trimEnd()}…` : rendered;
}

function compactArgs(args: Record<string, unknown>, expanded: boolean): string {
	return Object.entries(args)
		.filter(([, value]) => value !== undefined)
		.slice(0, expanded ? 12 : 4)
		.map(([key, value]) => `${key}: ${compactValue(value, expanded)}`)
		.join(", ");
}

function applyPatchDetail(args: Record<string, unknown>, expanded: boolean): string {
	const patch = asString(args.patch ?? args.input ?? args.diff);
	if (!patch) return "";
	const files = parseApplyPatchPreview(patch);
	if (files.length === 0) return `${logicalLineCount(patch)} ${plural(logicalLineCount(patch), "line")}`;
	const names = files.map((file) => file.path);
	const shown = expanded ? names : names.slice(0, 3);
	return `${files.length} ${plural(files.length, "file")}: ${shown.join(", ")}${shown.length < names.length ? ", …" : ""}`;
}

export function formatClaudeOpenAiToolUse(
	identity: ClaudeOpenAiToolIdentity,
	argsValue: unknown,
	cwd?: string,
	expanded = false,
): ClaudeOpenAiToolUse {
	const args = isObject(argsValue) ? argsValue : {};
	if (identity.kind === "apply-patch") {
		return { name: identity.name, detail: applyPatchDetail(args, expanded) };
	}
	if (identity.kind === "shell") {
		return {
			name: identity.name,
			detail: compactValue(args.command ?? args.cmd ?? args.script ?? "", expanded),
		};
	}
	if (identity.kind === "web-search") {
		return {
			name: identity.name,
			detail: compactValue(args.query ?? args.search_query ?? args.q ?? "", expanded),
		};
	}
	if (identity.kind === "web-fetch") {
		const url = asString(args.url ?? args.uri ?? args.href);
		return { name: identity.name, detail: url ? compactValue(url, expanded) : compactArgs(args, expanded) };
	}
	if (identity.kind === "task") {
		return {
			name: identity.name,
			detail: compactValue(args.subject ?? args.description ?? args.task ?? args.id ?? "", expanded),
		};
	}
	if (identity.kind === "context") {
		const path = displayPath(args.path ?? args.file_path, cwd);
		return {
			name: identity.name,
			detail: path || compactValue(args.query ?? args.id ?? compactArgs(args, expanded), expanded),
		};
	}
	return { name: identity.name, detail: compactArgs(args, expanded) };
}

function errorLines(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const raw = textOutput(result).trim();
	if (!raw) return ["Tool failed"];
	return expanded ? raw.split("\n") : [raw.split("\n")[0] ?? "Tool failed"];
}

export function formatClaudeOpenAiToolResult(
	identity: ClaudeOpenAiToolIdentity,
	argsValue: unknown,
	resultValue: unknown,
	status: ClaudeToolStatus,
	expanded: boolean,
	config: ToolRenderingConfig,
): string[] {
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	if (status === "pending") return identity.kind === "shell" ? ["Waiting…"] : [];
	const output = structuredTextOutput(result);
	const contentLines = output ? output.split("\n") : [];
	if (status === "running") {
		if (!config.livePreview || contentLines.length === 0) return ["Running…"];
		return contentLines.slice(expanded ? -config.expandedPreviewMaxLines : -config.livePreviewLines);
	}
	if (status === "error") return errorLines(result, expanded);

	let summary = contentLines.length > 0
		? `${identity.kind === "shell" ? "Completed with" : "Returned"} ${contentLines.length} ${plural(contentLines.length, "line")}`
		: "Done";
	if (identity.kind === "apply-patch") {
		const patch = asString(args.patch ?? args.input ?? args.diff);
		const fileCount = patch ? parseApplyPatchPreview(patch).length : 0;
		summary = fileCount > 0 ? `Applied ${fileCount} ${plural(fileCount, "file")}` : "Patch applied";
	}
	return applyOutputMode(
		summary,
		contentLines,
		identity.kind === "shell" ? config.bashOutputMode : config.openAiOutputMode,
		expanded,
		config.previewLines,
		config.expandedPreviewMaxLines,
	);
}
