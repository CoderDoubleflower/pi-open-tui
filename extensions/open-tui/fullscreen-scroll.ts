import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

export const MIN_FULLSCREEN_WHEEL_SCROLL_LINES = 1;
export const MAX_FULLSCREEN_WHEEL_SCROLL_LINES = 10;
export const DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES = 4;
export const FULLSCREEN_JUMP_TO_BOTTOM_WIDGET_KEY = "open-tui:jump-to-bottom";
export const FULLSCREEN_JUMP_TO_BOTTOM_URL = "pi-open-tui://jump-to-bottom";
export const FULLSCREEN_JUMP_TO_BOTTOM_LABEL = "Jump to bottom (ctrl+End) ↓";

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

type FullscreenViewportTui = TUI & {
	mode?: string;
	wheelScrollLines?: number;
	isFollowingOutput?: boolean;
	scrollToBottom?: () => void;
	openUrl?: (url: string) => void;
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

function osc8Link(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * Pi 0.84.3 does not expose mouse handlers on extension components, but its
 * fullscreen renderer activates OSC 8 links through the TUI's openUrl callback.
 * Intercept one private URL and preserve normal link handling for every other URL.
 */
function installJumpToBottomUrlHandler(tui: TUI): (() => void) | undefined {
	const fullscreenTui = tui as FullscreenViewportTui;
	if (fullscreenTui.mode !== "fullscreen" || typeof fullscreenTui.scrollToBottom !== "function") {
		return undefined;
	}

	const originalOpenUrl = fullscreenTui.openUrl;
	const handler = (url: string) => {
		if (url === FULLSCREEN_JUMP_TO_BOTTOM_URL) {
			fullscreenTui.scrollToBottom?.call(fullscreenTui);
			return;
		}
		originalOpenUrl?.call(fullscreenTui, url);
	};

	try {
		fullscreenTui.openUrl = handler;
	} catch {
		return undefined;
	}
	if (fullscreenTui.openUrl !== handler) return undefined;

	return () => {
		if (fullscreenTui.openUrl === handler) {
			fullscreenTui.openUrl = originalOpenUrl;
		}
	};
}

class FullscreenJumpToBottomWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly restoreOpenUrl: (() => void) | undefined;
	private disposed = false;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.restoreOpenUrl = installJumpToBottomUrlHandler(tui);
	}

	render(width: number): string[] {
		if (
			this.disposed
			|| this.restoreOpenUrl === undefined
			|| width <= 0
			|| !shouldShowFullscreenJumpToBottom(this.tui)
		) return [];

		const label = ` ${FULLSCREEN_JUMP_TO_BOTTOM_LABEL} `;
		const clipped = truncateToWidth(label, width, width > 1 ? "…" : "");
		const button = this.theme.bg("userMessageBg", this.theme.bold(clipped));
		const linked = osc8Link(FULLSCREEN_JUMP_TO_BOTTOM_URL, button);
		const leftPadding = Math.max(0, Math.floor((width - visibleWidth(linked)) / 2));
		return [`${" ".repeat(leftPadding)}${linked}`];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.restoreOpenUrl?.();
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
