import assert from "node:assert/strict";
import test from "node:test";
import { VERSION, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	applyFullscreenWheelScrollLines,
	createFullscreenJumpToBottomWidget,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	FULLSCREEN_JUMP_TO_BOTTOM_LABEL,
	FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY,
	installFullscreenJumpToBottom,
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
	NATIVE_FULLSCREEN_JUMP_TO_BOTTOM_VERSION,
	needsLegacyFullscreenJumpToBottom,
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


test("custom jump-to-bottom is only needed before Pi 0.85.0", () => {
	assert.equal(NATIVE_FULLSCREEN_JUMP_TO_BOTTOM_VERSION, "0.85.0");
	for (const version of ["0.9.0", "0.84.3", "0.84.99", "0.84.3+build.1", "v0.84.3", " 0.84.3 ", "0.85.0-rc.1"]) {
		assert.equal(needsLegacyFullscreenJumpToBottom(version), true, version);
	}
	for (const version of ["0.85.0", "v0.85.0", "0.85.0+build.1", "0.85.1", "0.85.1-rc.1", "0.86.0", "0.100.0", "1.0.0"]) {
		assert.equal(needsLegacyFullscreenJumpToBottom(version), false, version);
	}
});

test("unknown or malformed Pi versions do not enable the legacy mouse shim", () => {
	for (const version of ["", "unknown", "nightly", "0.84", "0.84.3garbage", "00.84.3", "0.84.3-", "0.84.3-rc..1", "0.84.3-01", "0.84.9007199254740992"]) {
		assert.equal(needsLegacyFullscreenJumpToBottom(version), false, version);
	}
});

test("Pi 0.85.0 and newer never register the custom widget or touch native mouse handling", () => {
	const ctx = {
		ui: {
			setWidget() {
				assert.fail("native Pi must not register or remove a legacy widget");
			},
		},
	} as unknown as ExtensionContext;
	for (const version of ["0.85.0", "0.85.0+build.1", "0.85.1", "0.86.0", "0.100.0", "1.0.0", "unknown"]) {
		const cleanup = installFullscreenJumpToBottom(ctx, version);
		cleanup();
		cleanup();
	}
});

test("legacy Pi still registers the above-editor widget and restores its mouse handler on cleanup", () => {
	const calls: unknown[][] = [];
	const ctx = {
		ui: { setWidget: (...args: unknown[]) => { calls.push(args); } },
	} as unknown as ExtensionContext;
	const cleanup = installFullscreenJumpToBottom(ctx, "0.84.3");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]![0], FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY);
	assert.deepEqual(calls[0]![2], { placement: "aboveEditor" });
	const factory = calls[0]![1] as (tui: TUI, theme: Theme) => Component;
	const originalMouseHandler = () => {};
	const tui = {
		mode: "fullscreen",
		isFollowingOutput: false,
		scrollToBottom() {},
		handleSelectionMouseEvent: originalMouseHandler,
		requestRender() {},
	};
	const widget = factory(tui as unknown as TUI, theme);
	assert.equal(stripAnsi(widget.render(80)[0] ?? "").trim(), FULLSCREEN_JUMP_TO_BOTTOM_LABEL);
	assert.notEqual(tui.handleSelectionMouseEvent, originalMouseHandler);
	cleanup();
	assert.deepEqual(calls[1], [FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY, undefined]);
	assert.equal(tui.handleSelectionMouseEvent, originalMouseHandler);
	assert.deepEqual(widget.render(80), []);
});

test("installation defaults to the running Pi VERSION, not the plugin version", () => {
	const calls: unknown[][] = [];
	const ctx = {
		ui: { setWidget: (...args: unknown[]) => { calls.push(args); } },
	} as unknown as ExtensionContext;
	const cleanup = installFullscreenJumpToBottom(ctx);
	assert.equal(calls.length, needsLegacyFullscreenJumpToBottom(VERSION) ? 1 : 0);
	cleanup();
});
