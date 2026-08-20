import {
	asNumber,
	asString,
	displayPath,
	isObject,
} from "./claude-tool-renderer-shared.ts";

const BASH_COMMAND_MAX_LINES = 2;
const BASH_COMMAND_MAX_CHARS = 160;

export interface ClaudeToolUse {
	name: string;
	detail: string;
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function compactCommand(command: string, expanded: boolean): string {
	if (expanded) return command;
	const lines = command.split("\n");
	const needsLineTruncation = lines.length > BASH_COMMAND_MAX_LINES;
	const needsCharTruncation = command.length > BASH_COMMAND_MAX_CHARS;
	if (!needsLineTruncation && !needsCharTruncation) return command;

	let truncated = needsLineTruncation
		? lines.slice(0, BASH_COMMAND_MAX_LINES).join("\n")
		: command;
	if (truncated.length > BASH_COMMAND_MAX_CHARS) {
		truncated = truncated.slice(0, BASH_COMMAND_MAX_CHARS);
	}
	return `${truncated.trim()}…`;
}

function patternDetail(args: Record<string, unknown>, cwd?: string): string {
	const pattern = asString(args.pattern) ?? "";
	const path = displayPath(args.path, cwd);
	let detail = `pattern: ${quote(pattern)}`;
	if (path) detail += `, path: ${quote(path)}`;
	return detail;
}

function editCreatesFile(args: Record<string, unknown>): boolean {
	if (asString(args.old_string) === "" || asString(args.oldText) === "") return true;
	if (!Array.isArray(args.edits) || args.edits.length !== 1) return false;
	const edit = args.edits[0];
	return isObject(edit) && asString(edit.oldText) === "";
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
		const pages = asString(args.pages);
		if (pages) detail += ` · pages ${pages}`;
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
		return {
			name: editCreatesFile(args) ? "Create" : "Update",
			detail: displayPath(args.file_path ?? args.path, cwd),
		};
	}
	if (lower === "bash") {
		return { name: "Bash", detail: compactCommand(asString(args.command) ?? "", expanded) };
	}
	if (lower === "grep") return { name: "Grep", detail: patternDetail(args, cwd) };
	if (lower === "find") return { name: "Search", detail: patternDetail(args, cwd) };
	if (lower === "ls") return { name: "List", detail: displayPath(args.path, cwd) || "." };
	return { name: toolName, detail: "" };
}
