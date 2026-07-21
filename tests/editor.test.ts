import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { OpenTuiEditor } from "../extensions/open-tui/editor.ts";
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

const uiTheme = {
	fg: (_color: string, text: string) => text,
} as Theme;

test("compensates Pi editor padding for the custom left rail", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		() => uiTheme,
	);
	editor.setText("x");

	// Pi copies editorPaddingX after constructing a custom editor.
	editor.setPaddingX(2);
	const contentLine = stripAnsi(editor.render(40)[1] ?? "");

	assert.equal(contentLine.indexOf("x"), 2);
});
