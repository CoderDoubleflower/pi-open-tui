import { extname } from "node:path";
import { createTwoFilesPatch, diffWordsWithSpace } from "diff";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDiffLayout, ToolRenderingConfig } from "./config.ts";
import {
	asString,
	detailsOf,
	displayPath,
	isObject,
	plural,
	stableTextHash,
	type ToolResultLike,
} from "./claude-tool-renderer-shared.ts";

export const DIFF_ADDED_BACKGROUND = "\x1b[48;5;22m";
export const DIFF_REMOVED_BACKGROUND = "\x1b[48;5;52m";
const BACKGROUND_RESET = "\x1b[49m";
const FG_RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_RESET = "\x1b[22m";

export type ClaudeDiffLineKind = "context" | "add" | "remove" | "hunk" | "meta";

export interface ClaudeDiffLine {
	kind: ClaudeDiffLineKind;
	content: string;
	oldLine?: number;
	newLine?: number;
}

export interface ClaudeDiffDocument {
	lines: ClaudeDiffLine[];
	additions: number;
	removals: number;
	hunks: number;
}

export interface ClaudeDiffFilePreview {
	path: string;
	diff: string;
	operation?: "add" | "update" | "delete";
}

export interface ClaudeDiffPreview {
	key: string;
	files: ClaudeDiffFilePreview[];
}

export interface ClaudeDiffRenderOptions {
	width: number;
	expanded: boolean;
	theme: Theme;
	config: ToolRenderingConfig;
}

type CodeToAnsi = (code: string, language: string, theme: string) => Promise<string> | string;
let codeToAnsiLoader: Promise<CodeToAnsi> | null = null;
const highlightCache = new Map<string, string[]>();
const HIGHLIGHT_CACHE_MAX = 96;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	go: "go",
	h: "c",
	hpp: "cpp",
	html: "html",
	java: "java",
	js: "javascript",
	jsx: "jsx",
	json: "json",
	kt: "kotlin",
	md: "markdown",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	svelte: "svelte",
	swift: "swift",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	vue: "vue",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
};

function languageForPath(path: string): string | undefined {
	const extension = extname(path).slice(1).toLowerCase();
	return LANGUAGE_BY_EXTENSION[extension];
}

function normalizeDiff(value: string): string {
	return value.replace(/\r\n?/g, "\n").trimEnd();
}

export function parseClaudeDiff(value: string): ClaudeDiffDocument {
	const rawLines = normalizeDiff(value).split("\n");
	const lines: ClaudeDiffLine[] = [];
	let oldLine = 1;
	let newLine = 1;
	let additions = 0;
	let removals = 0;
	let hunks = 0;

	for (const raw of rawLines) {
		if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("diff --git ")) {
			lines.push({ kind: "meta", content: raw });
			continue;
		}
		if (raw.startsWith("@@")) {
			const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
			if (match) {
				oldLine = Number.parseInt(match[1]!, 10);
				newLine = Number.parseInt(match[2]!, 10);
			}
			hunks++;
			lines.push({ kind: "hunk", content: raw });
			continue;
		}
		if (raw.startsWith("+") && !raw.startsWith("+++")) {
			lines.push({ kind: "add", content: raw.slice(1), newLine });
			newLine++;
			additions++;
			continue;
		}
		if (raw.startsWith("-") && !raw.startsWith("---")) {
			lines.push({ kind: "remove", content: raw.slice(1), oldLine });
			oldLine++;
			removals++;
			continue;
		}
		if (raw.startsWith(" ")) {
			lines.push({ kind: "context", content: raw.slice(1), oldLine, newLine });
			oldLine++;
			newLine++;
			continue;
		}
		lines.push({ kind: "meta", content: raw });
	}

	if (hunks === 0 && additions + removals > 0) hunks = 1;
	return { lines, additions, removals, hunks };
}

function applyPatchPath(line: string): { operation: "add" | "update" | "delete"; path: string } | undefined {
	const match = /^\*\*\*\s+(Add|Update|Delete) File:\s+(.+?)\s*$/.exec(line);
	if (!match) return undefined;
	return {
		operation: match[1]!.toLowerCase() as "add" | "update" | "delete",
		path: match[2]!.trim(),
	};
}

export function parseApplyPatchPreview(value: string): ClaudeDiffFilePreview[] {
	const normalized = normalizeDiff(value);
	if (!normalized) return [];
	if (!normalized.includes("*** Begin Patch")) {
		return [{ path: "patch", diff: normalized, operation: "update" }];
	}

	const files: ClaudeDiffFilePreview[] = [];
	let current: { operation: "add" | "update" | "delete"; path: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		let body = current.lines.filter((line) => !line.startsWith("*** Move to:")).join("\n");
		if (!body.includes("@@")) {
			const changed = current.lines.filter((line) => line.startsWith("+") || line.startsWith("-")).length;
			const count = Math.max(1, changed);
			body = `@@ -1,${count} +1,${count} @@\n${body}`;
		}
		files.push({ path: current.path, operation: current.operation, diff: body });
		current = undefined;
	};

	for (const line of normalized.split("\n")) {
		const next = applyPatchPath(line);
		if (next) {
			flush();
			current = { ...next, lines: [] };
			continue;
		}
		if (line === "*** Begin Patch" || line === "*** End Patch") continue;
		if (line.startsWith("*** ")) {
			flush();
			continue;
		}
		current?.lines.push(line);
	}
	flush();
	return files;
}

function editOperations(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(args.edits)) {
		return args.edits.flatMap((entry) => {
			if (!isObject(entry)) return [];
			const oldText = asString(entry.oldText ?? entry.old_string);
			const newText = asString(entry.newText ?? entry.new_string);
			return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
		});
	}
	const oldText = asString(args.oldText ?? args.old_string);
	const newText = asString(args.newText ?? args.new_string);
	return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
}

function patchForEdit(path: string, oldText: string, newText: string): string {
	return createTwoFilesPatch(path || "file", path || "file", oldText, newText, "", "", { context: 3 });
}

export function buildClaudeDiffPreview(
	toolName: string,
	argsValue: unknown,
	resultValue: unknown,
	cwd?: string,
	argsComplete = true,
): ClaudeDiffPreview | undefined {
	const lower = toolName.toLowerCase();
	const args = isObject(argsValue) ? argsValue : {};
	const result = isObject(resultValue) ? resultValue as ToolResultLike : undefined;
	let files: ClaudeDiffFilePreview[] = [];

	if (lower === "apply_patch") {
		const patch = asString(args.patch ?? args.input ?? args.diff);
		if (!patch || !argsComplete) return undefined;
		files = parseApplyPatchPreview(patch);
	} else if (lower === "edit") {
		const path = displayPath(args.file_path ?? args.path, cwd) || "file";
		const operations = editOperations(args);
		if (operations.length > 0 && argsComplete) {
			files = operations.map((operation, index) => ({
				path: operations.length > 1 ? `${path} · edit ${index + 1}` : path,
				operation: "update",
				diff: patchForEdit(path, operation.oldText, operation.newText),
			}));
		} else {
			const resultDiff = asString(detailsOf(result).diff);
			if (resultDiff) files = [{ path, operation: "update", diff: resultDiff }];
		}
	} else if (lower === "write") {
		const path = displayPath(args.file_path ?? args.path, cwd) || "file";
		const content = asString(args.content);
		if (content === undefined || !argsComplete) return undefined;
		files = [{ path, operation: "add", diff: patchForEdit(path, "", content) }];
	}

	if (files.length === 0) return undefined;
	const keySource = files.map((file) => `${file.operation ?? "update"}\0${file.path}\0${file.diff}`).join("\x01");
	return { key: stableTextHash(keySource), files };
}

async function loadCodeToAnsi(): Promise<CodeToAnsi> {
	if (!codeToAnsiLoader) {
		codeToAnsiLoader = import("@shikijs/cli").then(
			(module) => module.codeToANSI as CodeToAnsi,
			(error) => {
				codeToAnsiLoader = null;
				throw error;
			},
		);
	}
	return codeToAnsiLoader;
}

function normalizeHighlightedLine(value: string): string {
	return value
		.replace(/\x1b\[(?:4\d|10[0-7])m/g, "")
		.replace(/\x1b\[48;[0-9;]*m/g, "")
		.replace(/\x1b\[49m/g, "")
		.replace(/\x1b\[0m/g, FG_RESET);
}

async function highlightedContents(
	document: ClaudeDiffDocument,
	path: string,
	themeName: string,
): Promise<Map<ClaudeDiffLine, string>> {
	const language = languageForPath(path);
	if (!language) return new Map();
	const codeLines = document.lines.filter((line) => line.kind === "context" || line.kind === "add" || line.kind === "remove");
	if (codeLines.length === 0) return new Map();
	const code = codeLines.map((line) => line.content).join("\n");
	const cacheKey = `${themeName}\0${language}\0${stableTextHash(code)}`;
	let highlighted = highlightCache.get(cacheKey);
	if (!highlighted) {
		try {
			const codeToAnsi = await loadCodeToAnsi();
			const output = await codeToAnsi(code, language, themeName);
			highlighted = output.replace(/\n$/, "").split("\n").map(normalizeHighlightedLine);
			if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
				const oldest = highlightCache.keys().next().value;
				if (oldest !== undefined) highlightCache.delete(oldest);
			}
			highlightCache.set(cacheKey, highlighted);
		} catch {
			return new Map();
		}
	}
	const result = new Map<ClaudeDiffLine, string>();
	for (let index = 0; index < codeLines.length; index++) {
		result.set(codeLines[index]!, highlighted[index] ?? codeLines[index]!.content);
	}
	return result;
}

function summaryLine(file: ClaudeDiffFilePreview, document: ClaudeDiffDocument, layout: ToolDiffLayout, theme: Theme): string {
	const operation = file.operation === "add" ? "new file" : file.operation === "delete" ? "deleted" : layout;
	const additions = theme.fg("success", `+${document.additions}`);
	const removals = theme.fg("error", `-${document.removals}`);
	return `${theme.bold(file.path)} ${theme.fg("dim", "·")} ${additions} ${removals} ${theme.fg("dim", `· ${document.hunks} ${plural(document.hunks, "hunk")} · ${operation}`)}`;
}

function paintBackground(line: string, kind: ClaudeDiffLineKind, width: number): string {
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	if (kind === "add") return `${DIFF_ADDED_BACKGROUND}${padded}${BACKGROUND_RESET}`;
	if (kind === "remove") return `${DIFF_REMOVED_BACKGROUND}${padded}${BACKGROUND_RESET}`;
	return padded;
}

function lineNumber(value: number | undefined, width: number): string {
	return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

function unifiedRows(
	document: ClaudeDiffDocument,
	highlighted: ReadonlyMap<ClaudeDiffLine, string>,
	width: number,
	maxLines: number,
	theme: Theme,
): string[] {
	const maxNumber = Math.max(1, ...document.lines.flatMap((line) => [line.oldLine ?? 0, line.newLine ?? 0]));
	const numberWidth = String(maxNumber).length;
	const rows: string[] = [];
	const visible = document.lines.slice(0, maxLines);
	for (const line of visible) {
		if (line.kind === "hunk" || line.kind === "meta") {
			rows.push(truncateToWidth(theme.fg("toolDiffContext", line.content), width, theme.fg("dim", "…")));
			continue;
		}
		const oldNumber = lineNumber(line.oldLine, numberWidth);
		const newNumber = lineNumber(line.newLine, numberWidth);
		const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
		const gutter = theme.fg("dim", `${oldNumber} ${newNumber} │ `);
		const contentWidth = Math.max(1, width - visibleWidth(gutter));
		const highlightedContent = highlighted.get(line);
		const rawPayload = `${marker}${highlightedContent ?? line.content}`;
		const styledPayload = highlightedContent === undefined
			? theme.fg(line.kind === "context" ? "toolDiffContext" : "text", rawPayload)
			: rawPayload;
		const content = truncateToWidth(styledPayload, contentWidth, theme.fg("dim", "…"));
		rows.push(paintBackground(`${gutter}${content}`, line.kind, width));
	}
	const hidden = document.lines.length - visible.length;
	if (hidden > 0) rows.push(theme.fg("dim", `… +${hidden} diff ${plural(hidden, "line")}`));
	return rows;
}

interface SplitRow {
	left?: ClaudeDiffLine;
	right?: ClaudeDiffLine;
	meta?: ClaudeDiffLine;
}

function splitRows(document: ClaudeDiffDocument): SplitRow[] {
	const rows: SplitRow[] = [];
	for (let index = 0; index < document.lines.length;) {
		const line = document.lines[index]!;
		if (line.kind === "hunk" || line.kind === "meta") {
			rows.push({ meta: line });
			index++;
			continue;
		}
		if (line.kind === "context") {
			rows.push({ left: line, right: line });
			index++;
			continue;
		}
		if (line.kind === "remove") {
			const removed: ClaudeDiffLine[] = [];
			const added: ClaudeDiffLine[] = [];
			while (document.lines[index]?.kind === "remove") removed.push(document.lines[index++]!);
			while (document.lines[index]?.kind === "add") added.push(document.lines[index++]!);
			const count = Math.max(removed.length, added.length);
			for (let pair = 0; pair < count; pair++) rows.push({ left: removed[pair], right: added[pair] });
			continue;
		}
		rows.push({ right: line });
		index++;
	}
	return rows;
}

function emphasizedPair(oldValue: string, newValue: string): [string, string] {
	let left = "";
	let right = "";
	for (const part of diffWordsWithSpace(oldValue, newValue)) {
		if (part.added) right += `${BOLD}${part.value}${BOLD_RESET}`;
		else if (part.removed) left += `${BOLD}${part.value}${BOLD_RESET}`;
		else {
			left += part.value;
			right += part.value;
		}
	}
	return [left, right];
}

function splitCell(
	line: ClaudeDiffLine | undefined,
	content: string,
	cellWidth: number,
	theme: Theme,
): string {
	if (!line) return " ".repeat(cellWidth);
	const number = line.oldLine ?? line.newLine;
	const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
	const gutter = theme.fg("dim", `${number === undefined ? "" : number} │ ${marker} `);
	const contentWidth = Math.max(1, cellWidth - visibleWidth(gutter));
	const rendered = `${gutter}${truncateToWidth(content, contentWidth, theme.fg("dim", "…"))}`;
	return paintBackground(rendered, line.kind, cellWidth);
}

function splitRenderRows(
	document: ClaudeDiffDocument,
	highlighted: ReadonlyMap<ClaudeDiffLine, string>,
	width: number,
	maxLines: number,
	theme: Theme,
): string[] {
	const allRows = splitRows(document);
	const visible = allRows.slice(0, maxLines);
	const gap = theme.fg("dim", " │ ");
	const gapWidth = visibleWidth(gap);
	const leftWidth = Math.max(1, Math.floor((width - gapWidth) / 2));
	const rightWidth = Math.max(1, width - gapWidth - leftWidth);
	const rows: string[] = [];
	for (const row of visible) {
		if (row.meta) {
			rows.push(truncateToWidth(theme.fg("toolDiffContext", row.meta.content), width, theme.fg("dim", "…")));
			continue;
		}
		let leftContent = row.left ? highlighted.get(row.left) ?? row.left.content : "";
		let rightContent = row.right ? highlighted.get(row.right) ?? row.right.content : "";
		if (row.left?.kind === "remove" && row.right?.kind === "add") {
			[leftContent, rightContent] = emphasizedPair(row.left.content, row.right.content);
		}
		rows.push(
			`${splitCell(row.left, leftContent, leftWidth, theme)}${gap}${splitCell(row.right, rightContent, rightWidth, theme)}`,
		);
	}
	const hidden = allRows.length - visible.length;
	if (hidden > 0) rows.push(theme.fg("dim", `… +${hidden} diff ${plural(hidden, "row")}`));
	return rows;
}

function layoutFor(document: ClaudeDiffDocument, width: number, configured: ToolDiffLayout): ToolDiffLayout {
	if (configured !== "auto") return configured;
	return width >= 100 && document.additions > 0 && document.removals > 0 ? "split" : "unified";
}

async function renderFile(
	file: ClaudeDiffFilePreview,
	options: ClaudeDiffRenderOptions,
	highlight: boolean,
): Promise<string[]> {
	const document = parseClaudeDiff(file.diff);
	const layout = layoutFor(document, options.width, options.config.diffLayout);
	const maxLines = options.expanded ? options.config.expandedPreviewMaxLines : options.config.diffCollapsedLines;
	const highlighted = highlight
		? await highlightedContents(document, file.path, options.config.diffTheme)
		: new Map<ClaudeDiffLine, string>();
	const body = layout === "split"
		? splitRenderRows(document, highlighted, options.width, maxLines, options.theme)
		: unifiedRows(document, highlighted, options.width, maxLines, options.theme);
	return [summaryLine(file, document, layout, options.theme), ...body];
}

async function renderPreview(
	preview: ClaudeDiffPreview,
	options: ClaudeDiffRenderOptions,
	highlight: boolean,
): Promise<string[]> {
	const maxFiles = options.expanded ? preview.files.length : Math.min(preview.files.length, 3);
	const lines: string[] = [];
	for (let index = 0; index < maxFiles; index++) {
		if (index > 0) lines.push("");
		lines.push(...await renderFile(preview.files[index]!, options, highlight));
	}
	const hiddenFiles = preview.files.length - maxFiles;
	if (hiddenFiles > 0) lines.push(options.theme.fg("dim", `… +${hiddenFiles} ${plural(hiddenFiles, "file")} (ctrl+o to expand)`));
	return lines;
}

export function renderClaudeDiffPreviewSync(
	preview: ClaudeDiffPreview,
	options: ClaudeDiffRenderOptions,
): string[] {
	// All non-highlighted branches resolve synchronously; keep this explicit
	// implementation so the first render never waits on Shiki initialization.
	const maxFiles = options.expanded ? preview.files.length : Math.min(preview.files.length, 3);
	const lines: string[] = [];
	for (let index = 0; index < maxFiles; index++) {
		const file = preview.files[index]!;
		const document = parseClaudeDiff(file.diff);
		const layout = layoutFor(document, options.width, options.config.diffLayout);
		const maxLines = options.expanded ? options.config.expandedPreviewMaxLines : options.config.diffCollapsedLines;
		if (index > 0) lines.push("");
		lines.push(summaryLine(file, document, layout, options.theme));
		lines.push(...(layout === "split"
			? splitRenderRows(document, new Map(), options.width, maxLines, options.theme)
			: unifiedRows(document, new Map(), options.width, maxLines, options.theme)));
	}
	const hiddenFiles = preview.files.length - maxFiles;
	if (hiddenFiles > 0) lines.push(options.theme.fg("dim", `… +${hiddenFiles} ${plural(hiddenFiles, "file")} (ctrl+o to expand)`));
	return lines;
}

export async function renderClaudeDiffPreview(
	preview: ClaudeDiffPreview,
	options: ClaudeDiffRenderOptions,
): Promise<string[]> {
	return renderPreview(preview, options, true);
}
