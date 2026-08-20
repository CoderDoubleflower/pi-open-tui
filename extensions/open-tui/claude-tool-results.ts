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

function imageSummary(result: ToolResultLike | undefined): string | undefined {
	const block = result?.content?.find((item) => item.type === "image");
	if (!block) return undefined;
	const bytes = encodedByteLength(block.data);
	return bytes > 0 ? `Read image (${formatFileSize(bytes)})` : "Read image";
}

function readResult(result: ToolResultLike | undefined): string[] {
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

	const truncation = isObject(details.truncation) ? details.truncation : undefined;
	const outputLines = truncation ? asNumber(truncation.outputLines) : undefined;
	const count = outputLines ?? logicalLineCount(textOutputRaw(result));
	return [`Read ${count} ${plural(count, "line")}`];
}

function writeResult(args: Record<string, unknown>, cwd: string | undefined, expanded: boolean): string[] {
	const path = displayPath(args.file_path ?? args.path, cwd);
	const content = asString(args.content) ?? "";
	const count = logicalLineCount(content);
	const contentLines = content ? visibleContentLines(content) : ["(No content)"];
	const preview = expanded ? contentLines : contentLines.slice(0, WRITE_PREVIEW_LINES);
	const hidden = Math.max(0, count - WRITE_PREVIEW_LINES);
	const result = [`Wrote ${count} lines to ${path || "file"}`, ...preview];
	if (!expanded && hidden > 0) {
		result.push(`… +${hidden} ${plural(hidden, "line")} ${EXPAND_HINT}`);
	}
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

function editResult(result: ToolResultLike | undefined): string[] {
	const diff = asString(detailsOf(result).diff);
	if (!diff) return ["Updated file"];
	const lines = diff.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	return [editSummary(diff), ...lines];
}

function searchContentLines(result: ToolResultLike | undefined, emptySentinels: string[]): string[] {
	const output = structuredTextOutput(result).trim();
	if (!output || emptySentinels.some((sentinel) => output.toLowerCase() === sentinel.toLowerCase())) {
		return [];
	}
	return output.split("\n");
}

function grepResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const content = searchContentLines(result, ["No matches found", "No matches"]);
	const matches = content.filter((line) => /:\d+:/.test(line));
	const count = matches.length > 0 ? matches.length : content.filter((line) => line.trim().length > 0).length;
	const summary = expandHint(`Found ${count} ${plural(count, "line")}`, count, expanded);
	return expanded && count > 0 ? [summary, ...content] : [summary];
}

function findResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const content = searchContentLines(result, ["No files found matching pattern"])
		.filter((line) => line.trim().length > 0);
	const count = content.length;
	const summary = expandHint(`Found ${count} ${plural(count, "file")}`, count, expanded);
	return expanded && count > 0 ? [summary, ...content] : [summary];
}

function lsResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const content = searchContentLines(result, ["(empty directory)"])
		.filter((line) => line.trim().length > 0);
	const count = content.length;
	const summary = expandHint(`Found ${count} ${plural(count, "entry", "entries")}`, count, expanded);
	return expanded && count > 0 ? [summary, ...content] : [summary];
}

function isNoOutput(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return !normalized || normalized === "(no output)" || normalized === "no output";
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function bashProgressResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	const output = stripAnsi(structuredTextOutput(result).trim());
	if (isNoOutput(output)) return ["Running…"];
	if (expanded) return output.split("\n");
	const lines = output.split("\n").filter((line) => line.length > 0);
	const visible = lines.slice(-BASH_PROGRESS_LINES);
	const truncation = detailsOf(result).truncation;
	const totalLines = isObject(truncation) ? asNumber(truncation.totalLines) : undefined;
	const totalBytes = isObject(truncation) ? asNumber(truncation.totalBytes) : undefined;
	const hidden = Math.max(0, (totalLines ?? lines.length) - visible.length);
	if (totalBytes !== undefined && totalLines !== undefined) {
		return [...visible, `~${totalLines} lines ${formatFileSize(totalBytes)}`];
	}
	return hidden > 0 ? [...visible, `+${hidden} lines`] : visible;
}

function collapsedBashResult(output: string): string[] {
	const lines = output.trimEnd().split("\n");
	if (lines.length <= BASH_RESULT_LINES + 1) return lines;
	const hidden = lines.length - BASH_RESULT_LINES;
	return [...lines.slice(0, BASH_RESULT_LINES), `… +${hidden} lines ${EXPAND_HINT}`];
}

function bashSuccessResult(result: ToolResultLike | undefined, expanded: boolean): string[] {
	if (result?.content?.some((block) => block.type === "image")) {
		return ["[Image data detected and sent to Claude]"];
	}
	const details = detailsOf(result);
	const output = structuredTextOutput(result);
	if (isNoOutput(output)) {
		const returnCodeInterpretation = asString(details.returnCodeInterpretation);
		if (returnCodeInterpretation) return [returnCodeInterpretation];
		if (details.backgroundTaskId) return ["Running in the background (↓ to manage)"];
		return [details.noOutputExpected === true ? "Done" : "(No output)"];
	}
	return expanded ? output.trimEnd().split("\n") : collapsedBashResult(output);
}

function isFileNotFoundError(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		lower.includes("enoent") ||
		lower.includes("no such file") ||
		lower.includes("file not found") ||
		lower.includes("path not found")
	);
}

function errorResult(toolName: string, result: ToolResultLike | undefined, expanded: boolean): string[] {
	const raw = textOutput(result).trim();
	if (expanded) return raw ? raw.split("\n") : ["Tool failed"];
	if (toolName === "bash") return raw ? collapsedBashResult(raw) : ["Tool failed"];
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
): string[] {
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	const lower = toolName.toLowerCase();

	if (status === "pending") return lower === "bash" ? ["Waiting…"] : [];
	if (status === "error") return errorResult(lower, result, expanded);
	if (status === "running") return lower === "bash" ? bashProgressResult(result, expanded) : [];
	if (lower === "bash") return bashSuccessResult(result, expanded);
	if (lower === "read") return readResult(result);
	if (lower === "write") return writeResult(args, cwd, expanded);
	if (lower === "edit") return editResult(result);
	if (lower === "grep") return grepResult(result, expanded);
	if (lower === "find") return findResult(result, expanded);
	if (lower === "ls") return lsResult(result, expanded);
	const output = textOutput(result);
	return output ? output.split("\n") : [];
}
