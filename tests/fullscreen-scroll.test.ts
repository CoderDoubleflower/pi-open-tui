import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	applyFullscreenWheelScrollLines,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "../extensions/open-tui/fullscreen-scroll.ts";

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
