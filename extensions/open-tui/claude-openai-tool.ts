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

function objectItems(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isObject) : [];
}

function operationDetail(label: string, values: string[], expanded: boolean): string {
	const normalized = values.map((value) => value.trim()).filter(Boolean);
	if (normalized.length === 0) return "";
	const [first, ...rest] = normalized;
	return compactValue(`${label} ${first}${rest.length > 0 ? ` (+${rest.length})` : ""}`, expanded);
}

export function summarizeClaudeWebSearchCommands(
	argsValue: unknown,
	expanded = false,
): string {
	const args = isObject(argsValue) ? argsValue : {};
	const searchQueries = objectItems(args.search_query);
	if (searchQueries.length > 0) {
		return operationDetail(
			"Search",
			searchQueries.map((query) => asString(query.q) ?? ""),
			expanded,
		);
	}
	const imageQueries = objectItems(args.image_query);
	if (imageQueries.length > 0) {
		return operationDetail(
			"Search images",
			imageQueries.map((query) => asString(query.q) ?? ""),
			expanded,
		);
	}
	const openOperations = objectItems(args.open);
	if (openOperations.length > 0) {
		return operationDetail(
			"Open",
			openOperations.map((operation) => asString(operation.ref_id) ?? ""),
			expanded,
		);
	}
	const clickOperations = objectItems(args.click);
	if (clickOperations.length > 0) {
		return operationDetail(
			"Open link",
			clickOperations.map((operation) => {
				const refId = asString(operation.ref_id) ?? "";
				const linkId = typeof operation.id === "number" ? String(operation.id) : "";
				return `${refId}${linkId ? `#${linkId}` : ""}`;
			}),
			expanded,
		);
	}
	const findOperations = objectItems(args.find);
	if (findOperations.length > 0) {
		return operationDetail(
			"Find",
			findOperations.map((operation) => {
				const pattern = asString(operation.pattern) ?? "";
				const refId = asString(operation.ref_id) ?? "";
				return pattern && refId ? `'${pattern}' in ${refId}` : pattern || refId;
			}),
			expanded,
		);
	}
	const screenshots = objectItems(args.screenshot);
	if (screenshots.length > 0) {
		return operationDetail(
			"Screenshot",
			screenshots.map((operation) => {
				const refId = asString(operation.ref_id) ?? "";
				const page = typeof operation.pageno === "number" ? String(operation.pageno) : "";
				return `${refId}${page ? ` page ${page}` : ""}`;
			}),
			expanded,
		);
	}
	const financeOperations = objectItems(args.finance);
	if (financeOperations.length > 0) {
		return operationDetail(
			"Finance",
			financeOperations.map((operation) => asString(operation.ticker) ?? ""),
			expanded,
		);
	}
	const weatherOperations = objectItems(args.weather);
	if (weatherOperations.length > 0) {
		return operationDetail(
			"Weather",
			weatherOperations.map((operation) => asString(operation.location) ?? ""),
			expanded,
		);
	}
	const sportsOperations = objectItems(args.sports);
	if (sportsOperations.length > 0) {
		return operationDetail(
			"Sports",
			sportsOperations.map((operation) =>
				[asString(operation.league), asString(operation.fn)].filter(Boolean).join(" "),
			),
			expanded,
		);
	}
	const timeOperations = objectItems(args.time);
	if (timeOperations.length > 0) {
		return operationDetail(
			"Time",
			timeOperations.map((operation) => asString(operation.utc_offset) ?? ""),
			expanded,
		);
	}

	const legacyQuery = asString(
		args.query ?? args.q ?? (typeof args.search_query === "string" ? args.search_query : undefined),
	);
	return legacyQuery ? compactValue(legacyQuery, expanded) : "";
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
			detail: summarizeClaudeWebSearchCommands(args, expanded),
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
	if (identity.kind === "web-search") {
		return status === "error" ? errorLines(result, expanded) : [];
	}
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
