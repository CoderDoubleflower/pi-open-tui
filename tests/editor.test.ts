import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { OpenTuiEditor, paintAutocompleteLine } from "../extensions/open-tui/editor.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
} as TUI;

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as EditorTheme;

test("compensates Pi editor padding for the fixed prompt", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("x");

	// Pi copies editorPaddingX after constructing a custom editor.
	editor.setPaddingX(2);
	const contentLine = stripAnsi(editor.render(40)[1] ?? "");

	assert.equal(contentLine.indexOf("x"), 2);
});

test("renders full-width horizontal borders and a fixed prompt", () => {
	let painted = "";
	const theme = {
		...editorTheme,
		borderColor: (text: string) => {
			painted = text;
			return text;
		},
	} as EditorTheme;
	const editor = new OpenTuiEditor(
		tui,
		theme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("hi");

	const lines = editor.render(40);
	const top = lines[0] ?? "";
	const body = lines[1] ?? "";

	assert.equal(stripAnsi(top), "─".repeat(40));
	assert.match(top, /^\x1b\[38;2;103;103;103m/);
	assert.equal(stripAnsi(body).indexOf("❯ hi"), 0);
	assert.match(body, /^\x1b\[38;2;181;181;181m❯\x1b\[0m /);
	assert.equal(painted, "─", "the base editor may paint its internal border before it is replaced");
});

test("dynamic border color only recolors the horizontal borders", () => {
	let paintCalls = 0;
	const theme = {
		...editorTheme,
		borderColor: (text: string) => {
			paintCalls++;
			return `\x1b[32m${text}\x1b[0m`;
		},
	} as EditorTheme;
	const editor = new OpenTuiEditor(
		tui,
		theme,
		{ matches: () => false } as unknown as KeybindingsManager,
		() => true,
	);
	editor.setText("hi");

	const lines = editor.render(40);
	assert.equal(stripAnsi(lines[0] ?? ""), "─".repeat(40));
	assert.equal(stripAnsi(lines[1] ?? "").startsWith("❯ hi"), true);
	assert.equal(paintCalls, 3, "Pi paints the base border once, then both output borders");
});

test("shows the prompt on an empty editor and indents continuation lines", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);

	assert.equal(stripAnsi(editor.render(20)[1] ?? "").startsWith("❯ "), true);
	editor.setText("first\nsecond");
	const lines = editor.render(20).map(stripAnsi);
	assert.equal(lines[1]?.startsWith("❯ first"), true);
	assert.equal(lines[2]?.startsWith("  second"), true);
	assert.ok(lines.every((line) => line.length === 20));
});

test("uses dedicated colors for selected and unselected autocomplete items", () => {
	const selected = paintAutocompleteLine("\x1b[31m→ selected\x1b[0m");
	const unselected = paintAutocompleteLine("  unselected");

	assert.equal(selected, "\x1b[38;2;175;215;255m  selected\x1b[0m");
	assert.equal(unselected, "\x1b[38;2;122;122;122m  unselected\x1b[0m");
});

test("prefixes slash-command items at the input content column", () => {
	const selected = paintAutocompleteLine("\x1b[31m→ selected\x1b[0m", true);
	const unselected = paintAutocompleteLine("  unselected", true);

	assert.equal(selected, "\x1b[38;2;175;215;255m/selected\x1b[0m");
	assert.equal(unselected, "\x1b[38;2;122;122;122m/unselected\x1b[0m");
});

test("does not prefix autocomplete metadata or duplicate an existing slash", () => {
	assert.equal(
		paintAutocompleteLine("  (1/10)", true),
		"\x1b[38;2;122;122;122m  (1/10)\x1b[0m",
	);
	assert.equal(
		paintAutocompleteLine("  /already-prefixed", true),
		"\x1b[38;2;122;122;122m/already-prefixed\x1b[0m",
	);
});
