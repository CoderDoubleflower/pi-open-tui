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
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
	shouldShowFullscreenJumpToBottom,
} from "../extensions/open-tui/fullscreen-scroll.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bg: (color: string, text: string) => color === "selectedBg"
		? `\x1b[42m${text}\x1b[49m`
		: `\x1b[40m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

interface TestMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

function buttonColumn(line: string): number {
	return stripAnsi(line).indexOf(FULLSCREEN_JUMP_TO_BOTTOM_LABEL);
}

function createFunctionWrappingTuiReference<T extends object>(target: T): T {
	return new Proxy({} as T, {
		get: (_proxyTarget, property) => {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => Reflect.apply(value, target, args);
		},
		set: (_proxyTarget, property, value) => Reflect.set(target, property, value, target),
	});
}

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

test("jump-to-bottom widget highlights the whole button on hover and handles clicks without OSC 8", () => {
	let following = false;
	let jumps = 0;
	let selectionEvents = 0;
	const tui = {
		mode: "fullscreen",
		previousScreen: [] as string[],
		get isFollowingOutput() {
			return following;
		},
		scrollToBottom() {
			jumps++;
			following = true;
		},
		handleSelectionMouseEvent() {
			selectionEvents++;
		},
		requestRender() {},
	} as unknown as TUI;
	const widget = createFullscreenJumpToBottomWidget(tui, theme);
	const line = widget.render(80)[0] ?? "";
	const mouseX = buttonColumn(line);
	(tui as unknown as { previousScreen: string[] }).previousScreen = [line];

	assert.ok(!line.includes("\x1b]8;"));
	assert.ok(line.includes("\x1b[40m"));
	assert.equal(stripAnsi(line).trim(), FULLSCREEN_JUMP_TO_BOTTOM_LABEL);
	assert.ok(stripAnsi(line).startsWith(" "));

	const patched = (tui as unknown as { handleSelectionMouseEvent(event: TestMouseEvent): void })
		.handleSelectionMouseEvent;
	patched({ button: 32, x: mouseX, y: 0, release: false });
	assert.ok((widget.render(80)[0] ?? "").includes("\x1b[42m"));

	patched({ button: 0, x: mouseX, y: 0, release: false });
	patched({ button: 0, x: mouseX, y: 0, release: true });
	assert.equal(jumps, 1);
	assert.deepEqual(widget.render(80), []);

	widget.dispose();
	(tui as unknown as { handleSelectionMouseEvent(event: TestMouseEvent): void })
		.handleSelectionMouseEvent({ button: 32, x: 0, y: 0, release: false });
	assert.equal(selectionEvents, 1);
});

test("jump-to-bottom widget works through Pi's function-wrapping TUI proxy", () => {
	let following = false;
	let jumps = 0;
	let selectionEvents = 0;
	const target = {
		mode: "fullscreen",
		previousScreen: [] as string[],
		get isFollowingOutput() {
			return following;
		},
		scrollToBottom() {
			jumps++;
			following = true;
		},
		handleSelectionMouseEvent() {
			selectionEvents++;
		},
		requestRender() {},
	};
	const tui = createFunctionWrappingTuiReference(target) as unknown as TUI;
	const widget = createFullscreenJumpToBottomWidget(tui, theme);
	const line = widget.render(80)[0] ?? "";
	const mouseX = buttonColumn(line);
	target.previousScreen = [line];

	assert.ok(!line.includes("\x1b]8;"));
	(tui as unknown as { handleSelectionMouseEvent(event: TestMouseEvent): void })
		.handleSelectionMouseEvent({ button: 0, x: mouseX, y: 0, release: false });
	(tui as unknown as { handleSelectionMouseEvent(event: TestMouseEvent): void })
		.handleSelectionMouseEvent({ button: 0, x: mouseX, y: 0, release: true });
	assert.equal(jumps, 1);
	assert.deepEqual(widget.render(80), []);

	widget.dispose();
	(tui as unknown as { handleSelectionMouseEvent(event: TestMouseEvent): void })
		.handleSelectionMouseEvent({ button: 32, x: 0, y: 0, release: false });
	assert.equal(selectionEvents, 1);
});

test("jump-to-bottom widget stays hidden outside fullscreen mode", () => {
	const tui = {
		mode: "regular",
		isFollowingOutput: false,
		scrollToBottom() {},
		handleSelectionMouseEvent() {},
	} as unknown as TUI;
	const widget = createFullscreenJumpToBottomWidget(tui, theme);
	assert.deepEqual(widget.render(80), []);
	widget.dispose();
});
