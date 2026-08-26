import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

export const MIN_FULLSCREEN_WHEEL_SCROLL_LINES = 1;
export const MAX_FULLSCREEN_WHEEL_SCROLL_LINES = 10;
export const DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES = 4;
export const FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY = "open-tui:jump-to-bottom";
export const FULLSCREEN_JUMP_TO_BOTTOM_LABEL = "Jump to bottom (ctrl+End) ↓";
const FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER = Symbol("open-tui:jump-to-bottom-mouse-handler-owner");

export function normalizeFullscreenWheelScrollLines(
	value: unknown,
	fallback = DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(
		MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
		Math.max(MIN_FULLSCREEN_WHEEL_SCROLL_LINES, Math.floor(value)),
	);
}

interface FullscreenMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

type FullscreenViewportTui = TUI & {
	mode?: string;
	wheelScrollLines?: number;
	isFollowingOutput?: boolean;
	scrollToBottom?: () => void;
	previousScreen?: string[];
	handleSelectionMouseEvent?: (event: FullscreenMouseEvent) => void;
	[FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER]?: object;
};

/**
 * Pi 0.84+ exposes wheelScrollLines as a constructor option on TuiAltScreen,
 * but coding-agent does not currently surface that option in user settings.
 * Keep the compatibility shim isolated here so it is easy to remove once Pi
 * exposes a public runtime setter/configuration path.
 */
export function applyFullscreenWheelScrollLines(tui: TUI, value: number): boolean {
	const fullscreenTui = tui as FullscreenViewportTui;
	if (fullscreenTui.mode !== "fullscreen" || typeof fullscreenTui.wheelScrollLines !== "number") {
		return false;
	}

	fullscreenTui.wheelScrollLines = normalizeFullscreenWheelScrollLines(value);
	return true;
}

export function shouldShowFullscreenJumpToBottom(tui: TUI): boolean {
	const fullscreenTui = tui as FullscreenViewportTui;
	return fullscreenTui.mode === "fullscreen"
		&& fullscreenTui.isFollowingOutput === false
		&& typeof fullscreenTui.scrollToBottom === "function";
}

function isJumpToBottomButtonHit(tui: FullscreenViewportTui, event: FullscreenMouseEvent): boolean {
	const line = tui.previousScreen?.[event.y];
	if (!line) return false;
	const plain = stripTerminalSequences(line);
	const labelStart = plain.indexOf(FULLSCREEN_JUMP_TO_BOTTOM_LABEL);
	if (labelStart < 0) return false;
	const buttonStart = Math.max(0, labelStart - 1);
	const buttonEnd = labelStart + visibleWidth(FULLSCREEN_JUMP_TO_BOTTOM_LABEL) + 1;
	return event.x >= buttonStart && event.x < buttonEnd;
}

/**
 * Pi 0.84.3 consumes fullscreen mouse input before extension listeners run.
 * Wrap its selection handler so this fixed widget can provide hover and click
 * behavior without relying on terminal-controlled OSC 8 link decoration.
 */
function installJumpToBottomMouseHandler(
	tui: TUI,
	onHoverChange: (hovered: boolean) => void,
): (() => void) | undefined {
	const fullscreenTui = tui as FullscreenViewportTui;
	if (
		fullscreenTui.mode !== "fullscreen"
		|| typeof fullscreenTui.scrollToBottom !== "function"
		|| typeof fullscreenTui.handleSelectionMouseEvent !== "function"
	) {
		return undefined;
	}

	const originalHandler = fullscreenTui.handleSelectionMouseEvent;
	const owner = {};
	let pressed = false;
	const handler = (event: FullscreenMouseEvent) => {
		const hit = shouldShowFullscreenJumpToBottom(fullscreenTui)
			&& isJumpToBottomButtonHit(fullscreenTui, event);
		onHoverChange(hit);

		if ((event.button & 32) !== 0) {
			if (!hit && !pressed) originalHandler.call(fullscreenTui, event);
			return;
		}

		if (event.release) {
			const wasPressed = pressed;
			pressed = false;
			if (wasPressed && hit) fullscreenTui.scrollToBottom?.call(fullscreenTui);
			if (!wasPressed) originalHandler.call(fullscreenTui, event);
			return;
		}

		if ((event.button & 3) === 0 && hit) {
			pressed = true;
			return;
		}
		originalHandler.call(fullscreenTui, event);
	};

	try {
		fullscreenTui.handleSelectionMouseEvent = handler;
		fullscreenTui[FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER] = owner;
	} catch {
		try {
			fullscreenTui.handleSelectionMouseEvent = originalHandler;
		} catch {}
		return undefined;
	}
	if (fullscreenTui[FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER] !== owner) {
		try {
			fullscreenTui.handleSelectionMouseEvent = originalHandler;
		} catch {}
		return undefined;
	}

	return () => {
		if (fullscreenTui[FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER] === owner) {
			try {
				fullscreenTui.handleSelectionMouseEvent = originalHandler;
				fullscreenTui[FULLSCREEN_JUMP_TO_BOTTOM_MOUSE_HANDLER_OWNER] = undefined;
			} catch {}
		}
	};
}

class FullscreenJumpToBottomWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly restoreMouseHandler: (() => void) | undefined;
	private hovered = false;
	private disposed = false;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.restoreMouseHandler = installJumpToBottomMouseHandler(tui, (hovered) => {
			if (this.hovered === hovered) return;
			this.hovered = hovered;
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		if (
			this.disposed
			|| this.restoreMouseHandler === undefined
			|| width <= 0
			|| !shouldShowFullscreenJumpToBottom(this.tui)
		) return [];

		const label = ` ${FULLSCREEN_JUMP_TO_BOTTOM_LABEL} `;
		const clipped = truncateToWidth(label, width, width > 1 ? "…" : "");
		const background = this.hovered ? "selectedBg" : "userMessageBg";
		const button = this.theme.bg(background, this.theme.bold(clipped));
		const leftPadding = Math.max(0, Math.floor((width - visibleWidth(button)) / 2));
		return [`${" ".repeat(leftPadding)}${button}`];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.restoreMouseHandler?.();
	}
}

export function createFullscreenJumpToBottomWidget(
	tui: TUI,
	theme: Theme,
): Component & { dispose(): void } {
	return new FullscreenJumpToBottomWidget(tui, theme);
}

export function installFullscreenJumpToBottom(ctx: ExtensionContext): () => void {
	let widget: (Component & { dispose(): void }) | undefined;
	ctx.ui.setWidget(
		FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY,
		(tui, theme) => {
			widget?.dispose();
			widget = createFullscreenJumpToBottomWidget(tui, theme);
			return widget;
		},
		{ placement: "aboveEditor" },
	);

	return () => {
		widget?.dispose();
		widget = undefined;
		ctx.ui.setWidget(FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY, undefined);
	};
}
