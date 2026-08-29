import type { ToolRenderingConfig } from "./config.ts";
import {
	asNumber,
	asString,
	BASH_PROGRESS_LINES,
	BASH_RESULT_LINES,
	detailsOf,
	displayPath,
	encodedByteLength,
	expandHint,
	EXPAND_HINT,
	formatFileSize,
	isObject,
	logicalLineCount,
	plural,
	structuredTextOutput,
	textOutput,
	textOutputRaw,
	type ClaudeToolStatus,
	type ToolResultLike,
	visibleContentLines,
	WRITE_PREVIEW_LINES,
} from "./claude-tool-renderer-shared.ts";
import { stripAnsi } from "./utils.ts";

function imageSummary(result: ToolResultLike | undefined): string | undefined {
	const block = result?.content?.find((item) => item.type === "image");
	if (!block) return undefined;
	const bytes = encodedByteLength(block.data);
	return bytes > 0 ? `Read image (${formatFileSize(bytes)})` : "Read image";
}

function readResult(
	result: ToolResultLike | undefined,
	expanded: boolean,
	config?: ToolRenderingConfig,
): string[] {
	if (config?.readOutputMode === "hidden") return [];
	const details = detailsOf(result);
	if (
		details.type === "file_unchanged" ||
		details.fileUnchanged === true ||
		details.unchanged === true
	) {
		return ["Unchanged since last read"];
	}
	const image = imageSummary(result);
	if (image) return [image];
	const pdfBlock = result?.content?.find((item) => item.mimeType === "application/pdf");
	if (pdfBlock) {
		const bytes = encodedByteLength(pdfBlock.data);
		return [bytes > 0 ? `Read PDF (${formatFileSize(bytes)})` : "Read PDF"];
	}
	const numCells = asNumber(details.numCells ?? details.cells);
	if (numCells !== undefined) {
		return [numCells === 0 ? "No cells found in notebook" : `Read ${numCells} ${plural(numCells, "cell")}`];
	}
	const output = textOutputRaw(result);
	const contentLines = visibleContentLines(output);
	const truncation = isObject(details.truncation) ? details.truncation : undefined;
	const outputLines = truncation ? asNumber(truncation.outputLines) : undefined;
	const count = outputLines ?? logicalLineCount(output);
	const summary = `Read ${count} ${plural(count, "line")}`;
	if (!config || config.readOutputMode === "summary") return [summary];
	return configuredPreview(summary, contentLines, expanded, config.previewLines, config.expandedPreviewMaxLines);
}

function writeResult(
	args: Record<string, unknown>,
	cwd: string | undefined,
	expanded: boolean,
	config?: ToolRenderingConfig,
): string[] {
	const path = displayPath(args.file_path ?? args.path, cwd);
	const content = asString(args.content) ?? "";
	const count = logicalLineCount(content);
	const summary = `Wrote ${count} ${plural(count, "line")} to ${path || "file"}`;
	// Runtime rendering already appends the rich call/result diff. Preserve the
	// historical content preview for direct formatter consumers only.
	if (config) return [summary];
	const contentLines = content ? visibleContentLines(content) : ["(No content)"];
	const preview = expanded ? contentLines : contentLines.slice(0, WRITE_PREVIEW_LINES);
	const hidden = Math.max(0, contentLines.length - preview.length);
	const result = [summary, ...preview];
	if (!expanded && hidden > 0) result.push(`… +${hidden} ${plural(hidden, "line")} ${EXPAND_HINT}`);
	return result;
}

function editSummary(diff: string): string {
	let additions = 0;
	let removals = 0;
	for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	if (additions > 0 && removals > 0) {
		return `Added ${additions} ${plural(additions, "line")}, removed ${removals} ${plural(removals, "line")}`;
	}
	if (additions > 0) return `Added ${additions} ${plural(additions, "line")}`;
	if (removals > 0) return `Removed ${removals} ${plural(removals, "line")}`;
	return "Updated file";
}

function editResult(result: ToolResultLike | undefined, config?: ToolRenderingConfig): string[] {
	const diff = asString(detailsOf(result).diff);
	if (!diff) return ["Updated file"];
	const summary = editSummary(diff);
	// Avoid duplicating the rich diff in the runtime renderer while keeping the
	// original public formatter contract intact.
	if (config) return [summary];
	const lines = diff.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	return [summary, ...lines];
}

function searchContentLines(result: ToolResultLike | undefined, emptySentinels: string[]): string[] {
	const output = structuredTextOutput(result).trim();
	if (!output || emptySentinels.some((sentinel) => output.toLowerCase() === sentinel.toLowerCase())) return [];
	return output.split("\n");
}

function configuredPreview(
	summary: string,
	content: readonly string[],
	expanded: boolean,
	collapsedLimit: number,
	expandedLimit: number,
): string[] {
	const limit = expanded ? expandedLimit : collapsedLimit;
	const shown = content.slice(0, limit);
	const hidden = Math.max(0, content.length - shown.length);
	const result = [summary, ...shown];
	if (hidden > 0) result.push(`… +${hidden} ${plural(hidden, "line")} ${expanded ? "(output capped)" : EXPAND_HINT}`);
	return result;
}

function searchResult(
	noun: string,
	count: number,
	content: string[],
	expanded: boolean,
	config?: ToolRenderingConfig,
): string[] {
	const pluralNoun = noun === "entry" ? "entries" : `${noun}s`;
	const baseSummary = `Found ${count} ${plural(count, noun, pluralNoun)}`;
	if (!config) {
		const summary = expandHint(baseSummary, count, expanded);
		return expanded && count > 0 ? [summary, ...content] : [summary];
	}
	if (config.searchOutputMode === "hidden") return [];
	if (config.searchOutputMode === "summary" || count === 0) return [baseSummary];
	return configuredPreview(baseSummary, content, expanded, config.previewLines, config.expandedPreviewMaxLines);
}

function grepResult(result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	const content = searchContentLines(result, ["No matches found", "No matches"]);
	const matches = content.filter((line) => /:\d+:/.test(line));
	const count = matches.length > 0 ? matches.length : content.filter((line) => line.trim().length > 0).length;
	return searchResult("line", count, content, expanded, config);
}

function findResult(result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	const content = searchContentLines(result, ["No files found matching pattern"]).filter((line) => line.trim().length > 0);
	return searchResult("file", content.length, content, expanded, config);
}

function lsResult(result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	const content = searchContentLines(result, ["(empty directory)"]).filter((line) => line.trim().length > 0);
	return searchResult("entry", content.length, content, expanded, config);
}

function isNoOutput(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return !normalized || normalized === "(no output)" || normalized === "no output";
}

function bashDisplayOutput(result: ToolResultLike | undefined, structured = true): string {
	return stripAnsi(structured ? structuredTextOutput(result) : textOutput(result));
}

function bashProgressResult(result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	if (config && !config.livePreview) return ["Running…"];
	const output = bashDisplayOutput(result).trim();
	if (isNoOutput(output)) return ["Running…"];
	if (expanded) {
		const lines = output.split("\n");
		return config ? lines.slice(-config.expandedPreviewMaxLines) : lines;
	}
	const lines = output.split("\n").filter((line) => line.length > 0);
	const limit = config?.livePreviewLines ?? BASH_PROGRESS_LINES;
	const visible = lines.slice(-limit);
	const truncation = detailsOf(result).truncation;
	const totalLines = isObject(truncation) ? asNumber(truncation.totalLines) : undefined;
	const totalBytes = isObject(truncation) ? asNumber(truncation.totalBytes) : undefined;
	const hidden = Math.max(0, (totalLines ?? lines.length) - visible.length);
	if (totalBytes !== undefined && totalLines !== undefined) return [...visible, `~${totalLines} lines ${formatFileSize(totalBytes)}`];
	return hidden > 0 ? [...visible, `+${hidden} lines`] : visible;
}

function collapsedBashResult(output: string, limit = BASH_RESULT_LINES): string[] {
	const lines = output.trimEnd().split("\n");
	if (lines.length <= limit + 1) return lines;
	const hidden = lines.length - limit;
	return [...lines.slice(0, limit), `… +${hidden} lines ${EXPAND_HINT}`];
}

function bashSuccessResult(result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	if (result?.content?.some((block) => block.type === "image")) return ["[Image data detected and sent to Claude]"];
	const details = detailsOf(result);
	const output = bashDisplayOutput(result);
	if (isNoOutput(output)) {
		const returnCodeInterpretation = asString(details.returnCodeInterpretation);
		if (returnCodeInterpretation) return [returnCodeInterpretation];
		if (details.backgroundTaskId) return ["Running in the background (↓ to manage)"];
		return [details.noOutputExpected === true ? "Done" : "(No output)"];
	}
	if (!config) return expanded ? output.trimEnd().split("\n") : collapsedBashResult(output);
	const contentLines = output.trimEnd().split("\n");
	if (config.bashOutputMode === "hidden") return [];
	if (config.bashOutputMode === "summary") return [`Completed with ${contentLines.length} ${plural(contentLines.length, "line")}`];
	if (expanded) {
		const shown = contentLines.slice(0, config.expandedPreviewMaxLines);
		const hidden = contentLines.length - shown.length;
		return hidden > 0 ? [...shown, `… +${hidden} ${plural(hidden, "line")} (output capped)`] : shown;
	}
	return collapsedBashResult(output, config.previewLines);
}

function isFileNotFoundError(value: string): boolean {
	const lower = value.toLowerCase();
	return lower.includes("enoent") || lower.includes("no such file") || lower.includes("file not found") || lower.includes("path not found");
}

function errorResult(toolName: string, result: ToolResultLike | undefined, expanded: boolean, config?: ToolRenderingConfig): string[] {
	const raw = (toolName === "bash" ? bashDisplayOutput(result, false) : textOutput(result)).trim();
	if (expanded) {
		const lines = raw ? raw.split("\n") : ["Tool failed"];
		return config ? lines.slice(0, config.expandedPreviewMaxLines) : lines;
	}
	if (toolName === "bash") return raw ? collapsedBashResult(raw, config?.previewLines) : ["Tool failed"];
	if (isFileNotFoundError(raw)) return ["File not found"];
	if (toolName === "read") return ["Error reading file"];
	if (toolName === "write") return ["Error writing file"];
	if (toolName === "edit") {
		if (/has not been read|must be read first/i.test(raw)) return ["File must be read first"];
		return ["Error editing file"];
	}
	if (toolName === "grep" || toolName === "find") return ["Error searching files"];
	if (toolName === "ls") return ["Error listing directory"];
	return raw ? [raw.split("\n")[0] ?? "Tool failed"] : ["Tool failed"];
}

export function formatClaudeToolResult(
	toolName: string,
	argsValue: unknown,
	resultValue: unknown,
	status: ClaudeToolStatus,
	cwd?: string,
	expanded = false,
	config?: ToolRenderingConfig,
): string[] {
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	const lower = toolName.toLowerCase();
	if (status === "pending") return lower === "bash" ? ["Waiting…"] : [];
	if (status === "error") return errorResult(lower, result, expanded, config);
	if (status === "running") return lower === "bash" ? bashProgressResult(result, expanded, config) : [];
	if (lower === "bash") return bashSuccessResult(result, expanded, config);
	if (lower === "read") return readResult(result, expanded, config);
	if (lower === "write") return writeResult(args, cwd, expanded, config);
	if (lower === "edit") return editResult(result, config);
	if (lower === "grep") return grepResult(result, expanded, config);
	if (lower === "find") return findResult(result, expanded, config);
	if (lower === "ls") return lsResult(result, expanded, config);
	const output = textOutput(result);
	if (!output) return [];
	const lines = output.split("\n");
	return config ? lines.slice(0, expanded ? config.expandedPreviewMaxLines : config.previewLines) : lines;
}
