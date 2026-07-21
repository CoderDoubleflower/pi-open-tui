import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findBottomBorderIndex, isEditorBorderLine, stripAnsi } from "./utils.ts";

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

function roundedBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	sourceLine?: string,
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));
	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);

	if (sourceLine) {
		const plain = stripAnsi(sourceLine);
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		if (scrollMatch) {
			const label = `─── ${scrollMatch[1]} `;
			const fill = Math.max(0, width - 2 - visibleWidth(label));
			return paint(`${corners[0]}${label}${"─".repeat(fill)}${corners[1]}`);
		}
	}

	return paint(`${corners[0]}${"─".repeat(Math.max(0, width - 2))}${corners[1]}`);
}

export class OpenTuiEditor extends CustomEditor {
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getUiTheme: () => Theme,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.getRail = () => getUiTheme().fg("accent", "│");
		this.getBorder = (s: string) => getUiTheme().fg("borderMuted", s);
	}

	override setPaddingX(_padding: number): void {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		super.setPaddingX(0);
	}

	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const rail = this.getRail();
		const borderPaint = this.getBorder;
		const railWidth = 2;

		const innerWidth = Math.max(0, width - railWidth);
		const baseLines = super.render(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);

		const result: string[] = [];
		result.push(roundedBorder(width, "top", borderPaint, baseLines[0]));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			if (isEditorBorderLine(line)) {
				result.push(`${rail} ${fillLine("", innerWidth)}`);
			} else {
				result.push(`${rail} ${fillLine(line, innerWidth)}`);
			}
		}

		result.push(roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]));

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i]!);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(_pi: ExtensionAPI, ctx: ExtensionContext): () => void {
	const getUiTheme = () => ctx.ui.theme;
	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
		new OpenTuiEditor(tui, editorTheme, keybindings, getUiTheme),
	);
	return () => {
		ctx.ui.setEditorComponent(undefined);
	};
}
