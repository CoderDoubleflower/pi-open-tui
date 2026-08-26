import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	applyFullscreenWheelScrollLines,
	createFullscreenJumpToBottomWidget,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	FULLSCREEN_JUMP_TO_BOTTOM_LABEL,
	FULLSCREEN_JUMP_TO_BOTTOM_URL,
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
	shouldShowFullscreenJumpToBottom,
} from "../extensions/open-tui/fullscreen-scroll.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

test("defaults fullscreen mouse wheel scrolling to four lines", () => {
	assert.equal(DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES, 4);
	assert.equal(DEFAULT_CONFIG.fullscreen.wheelScrollLines, 4);
});

test("normalizes fullscreen mouse wheel speed into the supported range", () => {
	assert.equal(normalizeFullscreenWheelScrollLines(0), MIN_FULLSCREEN_WHEEL_SCROLL_LINES);
	assert.equal(normalizeFullscreenWheelScrollLines(3.9), 3);
	assert.equal(normalizeFullscreenWheelScrollLines(100), MAX_FULLSCREEN_WHEEL_SCROLL_LINES);
	assert.equal(normalizeFullscreenWheelScrollLines("fast"), DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES);
});

test("applies mouse wheel speed to Pi fullscreen TUI instances", () => {
	const tui = {
		mode: "fullscreen",
		wheelScrollLines: 1,
	} as unknown as TUI;

	assert.equal(applyFullscreenWheelScrollLines(tui, 6), true);
	assert.equal((tui as unknown as { wheelScrollLines: number }).wheelScrollLines, 6);
});

test("leaves non-fullscreen TUI instances untouched", () => {
	const tui = {
		mode: "inline",
		wheelScrollLines: 1,
	} as unknown as TUI;

	assert.equal(applyFullscreenWheelScrollLines(tui, 6), false);
	assert.equal((tui as unknown as { wheelScrollLines: number }).wheelScrollLines, 1);
});

test("jump-to-bottom visibility follows the fullscreen viewport follow state", () => {
	const fullscreen = {
		mode: "fullscreen",
		isFollowingOutput: false,
		scrollToBottom() {},
	} as unknown as TUI;
	assert.equal(shouldShowFullscreenJumpToBottom(fullscreen), true);
	(fullscreen as unknown as { isFollowingOutput: boolean }).isFollowingOutput = true;
	assert.equal(shouldShowFullscreenJumpToBottom(fullscreen), false);

	const inline = {
		mode: "regular",
		isFollowingOutput: false,
		scrollToBottom() {},
	} as unknown as TUI;
	assert.equal(shouldShowFullscreenJumpToBottom(inline), false);
});

test("jump-to-bottom widget is clickable, centered, and preserves normal URL handling", () => {
	let following = false;
	let jumps = 0;
	const opened: string[] = [];
	const originalOpenUrl = (url: string) => opened.push(url);
	const tui = {
		mode: "fullscreen",
		get isFollowingOutput() {
			return following;
		},
		scrollToBottom() {
			jumps++;
			following = true;
		},
		openUrl: originalOpenUrl,
		requestRender() {},
	} as unknown as TUI;
	const widget = createFullscreenJumpToBottomWidget(tui, theme);
	const line = widget.render(80)[0] ?? "";

	assert.ok(line.includes(FULLSCREEN_JUMP_TO_BOTTOM_URL));
	assert.equal(stripAnsi(line).trim(), FULLSCREEN_JUMP_TO_BOTTOM_LABEL);
	assert.ok(stripAnsi(line).startsWith(" "));

	const patched = (tui as unknown as { openUrl(url: string): void }).openUrl;
	patched(FULLSCREEN_JUMP_TO_BOTTOM_URL);
	assert.equal(jumps, 1);
	assert.deepEqual(widget.render(80), []);

	patched("https://example.com");
	assert.deepEqual(opened, ["https://example.com"]);

	widget.dispose();
	assert.equal((tui as unknown as { openUrl: (url: string) => void }).openUrl, originalOpenUrl);
});

test("jump-to-bottom widget stays hidden outside fullscreen mode", () => {
	const originalOpenUrl = (_url: string) => {};
	const tui = {
		mode: "regular",
		isFollowingOutput: false,
		scrollToBottom() {},
		openUrl: originalOpenUrl,
	} as unknown as TUI;
	const widget = createFullscreenJumpToBottomWidget(tui, theme);
	assert.deepEqual(widget.render(80), []);
	assert.equal((tui as unknown as { openUrl: (url: string) => void }).openUrl, originalOpenUrl);
	widget.dispose();
});
