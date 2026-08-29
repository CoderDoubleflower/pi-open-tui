import type { ToolOutputMode } from "./config.ts";

export const EXPAND_HINT = "(ctrl+o to expand)";
export const BASH_PROGRESS_LINES = 5;
export const BASH_RESULT_LINES = 3;
export const WRITE_PREVIEW_LINES = 10;

export type ClaudeToolStatus = "pending" | "running" | "success" | "error";

export interface ToolResultBlockLike {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResultLike {
	content?: ToolResultBlockLike[];
	isError?: boolean;
	details?: unknown;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
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

export function textOutputRaw(result: ToolResultLike | undefined): string {
	if (!result?.content) return "";
	return result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "");
}

export function textOutput(result: ToolResultLike | undefined): string {
	return textOutputRaw(result).trimEnd();
}

export function detailsOf(result: ToolResultLike | undefined): Record<string, unknown> {
	return isObject(result?.details) ? result.details : {};
}

export function logicalLineCount(value: string): number {
	if (!value) return 0;
	return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

export function visibleContentLines(value: string): string[] {
	if (!value) return [];
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	if (value.endsWith("\n")) lines.pop();
	return lines;
}

function stripPiNoticeFooter(value: string): string {
	const trimmed = value.trimEnd();
	const footerStart = trimmed.lastIndexOf("\n\n[");
	if (footerStart === -1 || !trimmed.endsWith("]")) return trimmed;
	return trimmed.slice(0, footerStart).trimEnd();
}

function hasPiNoticeDetails(result: ToolResultLike | undefined): boolean {
	const details = detailsOf(result);
	return [
		"truncation",
		"fullOutputPath",
		"matchLimitReached",
		"resultLimitReached",
		"entryLimitReached",
	].some((key) => details[key] !== undefined);
}

export function structuredTextOutput(result: ToolResultLike | undefined): string {
	const output = textOutput(result);
	return hasPiNoticeDetails(result) ? stripPiNoticeFooter(output) : output;
}

export function plural(count: number, singular: string, pluralNoun = `${singular}s`): string {
	return count === 1 ? singular : pluralNoun;
}

export function expandHint(summary: string, count: number, expanded: boolean): string {
	return !expanded && count > 0 ? `${summary} ${EXPAND_HINT}` : summary;
}

export function applyOutputMode(
	summary: string,
	contentLines: readonly string[],
	mode: ToolOutputMode,
	expanded: boolean,
	previewLines: number,
	expandedMaxLines: number,
): string[] {
	if (mode === "hidden") return [];
	if (mode === "summary" || contentLines.length === 0) return [summary];
	const max = expanded ? expandedMaxLines : previewLines;
	const shown = contentLines.slice(0, max);
	const hidden = Math.max(0, contentLines.length - shown.length);
	// Preview mode shows the actual payload, matching Pi's historical formatter
	// contract and avoiding an extra synthetic summary row before MCP/OpenAI data.
	const result = [...shown];
	if (hidden > 0) {
		result.push(`… +${hidden} ${plural(hidden, "line")} ${expanded ? "(output capped)" : EXPAND_HINT}`);
	}
	return result;
}

function base64ByteLength(value: string): number {
	const comma = value.indexOf(",");
	const base64 = (comma >= 0 ? value.slice(comma + 1) : value).replace(/\s+/g, "");
	if (!base64) return 0;
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function encodedByteLength(value: string | undefined): number {
	return value ? base64ByteLength(value) : 0;
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) {
		const value = bytes / 1024;
		return `${value < 10 ? value.toFixed(1) : Math.round(value)}KB`;
	}
	const value = bytes / (1024 * 1024);
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}MB`;
}

export function stableTextHash(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(36);
}
