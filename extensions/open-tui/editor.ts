import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findBottomBorderIndex, isEditorBorderLine, stripAnsi } from "./utils.ts";

const BORDER_RGB = "\x1b[38;2;103;103;103m";
const PROMPT_RGB = "\x1b[38;2;181;181;181m";
const AUTOCOMPLETE_SELECTED_RGB = "\x1b[38;2;175;215;255m";
const AUTOCOMPLETE_UNSELECTED_RGB = "\x1b[38;2;122;122;122m";
const RESET = "\x1b[0m";
const PROMPT_WIDTH = 2;

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

function isAutocompleteMetaLine(content: string): boolean {
	return content === "No matching commands" || /^\(\d+\/\d+\)$/.test(content);
}

export function paintAutocompleteLine(line: string, showSlashPrefix = false): string {
	const plain = stripAnsi(line);
	const selected = plain.startsWith("→ ");
	const color = selected
		? AUTOCOMPLETE_SELECTED_RGB
		: AUTOCOMPLETE_UNSELECTED_RGB;
	const content = plain.slice(2);
	let renderedContent = `  ${content}`;
	if (showSlashPrefix && !isAutocompleteMetaLine(content)) {
		renderedContent = content.startsWith("/") ? content : `/${content}`;
	}
	return `${color}${renderedContent}${RESET}`;
}

function horizontalBorder(
	width: number,
	paint: (s: string) => string,
	sourceLine?: string,
): string {
	if (sourceLine) {
		const plain = stripAnsi(sourceLine);
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		if (scrollMatch) {
			const label = `─── ${scrollMatch[1]} `;
			const fill = Math.max(0, width - visibleWidth(label));
			return paint(truncateToWidth(`${label}${"─".repeat(fill)}`, width, ""));
		}
	}

	return paint("─".repeat(Math.max(0, width)));
}

export class OpenTuiEditor extends CustomEditor {
	private readonly getDynamicBorderColor: () => boolean;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getDynamicBorderColor: () => boolean = () => false,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.getDynamicBorderColor = getDynamicBorderColor;
	}

	override setPaddingX(_padding: number): void {
		// The prompt owns the horizontal inset.
		super.setPaddingX(0);
	}

	render(width: number): string[] {
		if (width <= 0) return [""];

		const borderPaint = this.getDynamicBorderColor()
			? (s: string) => this.borderColor(s)
			: (s: string) => `${BORDER_RGB}${s}${RESET}`;
		const innerWidth = Math.max(1, width - PROMPT_WIDTH);
		const baseLines = super.render(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);
		const firstInputLineIsVisible = !stripAnsi(baseLines[0] ?? "").includes("↑");
		const cursor = this.getCursor();
		const textBeforeCursor = cursor.line === 0
			? (this.getLines()[0] ?? "").slice(0, cursor.col).trimStart()
			: "";
		const showSlashPrefix = /^\/\S*$/.test(textBeforeCursor);

		const result: string[] = [];
		result.push(horizontalBorder(width, borderPaint, baseLines[0]));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			const prefix = i === 1 && firstInputLineIsVisible
				? `${PROMPT_RGB}❯${RESET} `
				: " ".repeat(PROMPT_WIDTH);
			result.push(`${prefix}${fillLine(isEditorBorderLine(line) ? "" : line, innerWidth)}`);
		}

		result.push(horizontalBorder(width, borderPaint, baseLines[bottomIdx]));

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			const autocompleteLine = paintAutocompleteLine(baseLines[i]!, showSlashPrefix);
			result.push(`${" ".repeat(PROMPT_WIDTH)}${fillLine(autocompleteLine, innerWidth)}`);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	getDynamicBorderColor: () => boolean,
): () => void {
	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
		new OpenTuiEditor(tui, editorTheme, keybindings, getDynamicBorderColor),
	);
	return () => {
		ctx.ui.setEditorComponent(undefined);
	};
}
