import { DEFAULT_TOOL_RENDERING_CONFIG, type ToolRenderingConfig } from "./config.ts";
import {
	applyOutputMode,
	asNumber,
	asString,
	detailsOf,
	displayPath,
	encodedByteLength,
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
	config: ToolRenderingConfig,
): string[] {
	const details = detailsOf(result);
	if (details.type === "file_unchanged" || details.fileUnchanged === true || details.unchanged === true) {
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
	return applyOutputMode(
		`Read ${count} ${plural(count, "line")}`,
		contentLines,
		config.readOutputMode,
		expanded,
		config.previewLines,
		config.expandedPreviewMaxLines,
	);
}

function writeResult(args: Record<string, unknown>, cwd: string | undefined): string[] {
	const path = displayPath(args.file_path ?? args.path, cwd);
	const content = asString(args.content) ?? "";
	const count = logicalLineCount(content);
	return [`Wrote ${count} ${plural(count, "line")} to ${path || "file"}`];
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

function editResult(result: ToolResultLike | undefined): string[] {
	const diff = asString(detailsOf(result).diff);
	return [diff ? editSummary(diff) : "Updated file"];
}

function searchContentLines(result: ToolResultLike | undefined, emptySentinels: string[]): string[] {
	const output = structuredTextOutput(result).trim();
	if (!output || emptySentinels.some((sentinel) => output.toLowerCase() === sentinel.toLowerCase())) return [];
	return output.split("\n");
}

function searchResult(
	noun: string,
	content: string[],
	expanded: boolean,
	config: ToolRenderingConfig,
): string[] {
	const count = content.length;
	return applyOutputMode(
		`Found ${count} ${plural(count, noun, noun === "entry" ? "entries" : `${noun}s`)}`,
		content,
		config.searchOutputMode,
		expanded,
		config.previewLines,
		config.expandedPreviewMaxLines,
	);
}

function isNoOutput(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return !normalized || normalized === "(no output)" || normalized === "no output";
}

function bashDisplayOutput(result: ToolResultLike | undefined, structured = true): string {
	return stripAnsi(structured ? structuredTextOutput(result) : textOutput(result));
}

function bashProgressResult(
	result: ToolResultLike | undefined,
	expanded: boolean,
	config: ToolRenderingConfig,
): string[] {
	if (!config.livePreview) return ["Running…"];
	const output = bashDisplayOutput(result).trim();
	if (isNoOutput(output)) return ["Running…"];
	const lines = output.split("\n").filter((line) => line.length > 0);
	if (expanded) return lines.slice(-config.expandedPreviewMaxLines);
	const visible = lines.slice(-config.livePreviewLines);
	const truncation = detailsOf(result).truncation;
	const totalLines = isObject(truncation) ? asNumber(truncation.totalLines) : undefined;
	const totalBytes = isObject(truncation) ? asNumber(truncation.totalBytes) : undefined;
	const hidden = Math.max(0, (totalLines ?? lines.length) - visible.length);
	if (totalBytes !== undefined && totalLines !== undefined) return [...visible, `~${totalLines} lines ${formatFileSize(totalBytes)}`];
	return hidden > 0 ? [...visible, `+${hidden} lines`] : visible;
}

function bashSuccessResult(
	result: ToolResultLike | undefined,
	expanded: boolean,
	config: ToolRenderingConfig,
): string[] {
	if (result?.content?.some((block) => block.type === "image")) return ["[Image data detected and sent to Claude]"];
	const details = detailsOf(result);
	const output = bashDisplayOutput(result);
	if (isNoOutput(output)) {
		const interpretation = asString(details.returnCodeInterpretation);
		if (interpretation) return [interpretation];
		if (details.backgroundTaskId) return ["Running in the background (↓ to manage)"];
		return [details.noOutputExpected === true ? "Done" : "(No output)"];
	}
	const contentLines = output.trimEnd().split("\n");
	return applyOutputMode(
		`Completed with ${contentLines.length} ${plural(contentLines.length, "line")}`,
		contentLines,
		config.bashOutputMode,
		expanded,
		config.previewLines,
		config.expandedPreviewMaxLines,
	);
}

function isFileNotFoundError(value: string): boolean {
	const lower = value.toLowerCase();
	return lower.includes("enoent") || lower.includes("no such file") || lower.includes("file not found") || lower.includes("path not found");
}

function errorResult(toolName: string, result: ToolResultLike | undefined, expanded: boolean, config: ToolRenderingConfig): string[] {
	const raw = (toolName === "bash" ? bashDisplayOutput(result, false) : textOutput(result)).trim();
	if (expanded) return raw ? raw.split("\n").slice(0, config.expandedPreviewMaxLines) : ["Tool failed"];
	if (toolName === "bash") return raw ? raw.split("\n").slice(0, config.previewLines) : ["Tool failed"];
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
	config: ToolRenderingConfig = DEFAULT_TOOL_RENDERING_CONFIG,
): string[] {
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	const lower = toolName.toLowerCase();
	if (status === "pending") return lower === "bash" ? ["Waiting…"] : [];
	if (status === "error") return errorResult(lower, result, expanded, config);
	if (status === "running") return lower === "bash" ? bashProgressResult(result, expanded, config) : [];
	if (lower === "bash") return bashSuccessResult(result, expanded, config);
	if (lower === "read") return readResult(result, expanded, config);
	if (lower === "write") return writeResult(args, cwd);
	if (lower === "edit") return editResult(result);
	if (lower === "grep") return searchResult("line", searchContentLines(result, ["No matches found", "No matches"]), expanded, config);
	if (lower === "find") return searchResult("file", searchContentLines(result, ["No files found matching pattern"]).filter(Boolean), expanded, config);
	if (lower === "ls") return searchResult("entry", searchContentLines(result, ["(empty directory)"]).filter(Boolean), expanded, config);
	const output = textOutput(result);
	return output ? output.split("\n").slice(0, expanded ? config.expandedPreviewMaxLines : config.previewLines) : [];
}
