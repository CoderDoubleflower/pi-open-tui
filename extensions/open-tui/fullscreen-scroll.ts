import type { TUI } from "@earendil-works/pi-tui";

export const MIN_FULLSCREEN_WHEEL_SCROLL_LINES = 1;
export const MAX_FULLSCREEN_WHEEL_SCROLL_LINES = 10;
export const DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES = 4;

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

type FullscreenWheelTui = TUI & {
	mode?: string;
	wheelScrollLines?: number;
};

/**
 * Pi 0.84+ exposes wheelScrollLines as a constructor option on TuiAltScreen,
 * but coding-agent does not currently surface that option in user settings.
 * Keep the compatibility shim isolated here so it is easy to remove once Pi
 * exposes a public runtime setter/configuration path.
 */
export function applyFullscreenWheelScrollLines(tui: TUI, value: number): boolean {
	const fullscreenTui = tui as FullscreenWheelTui;
	if (fullscreenTui.mode !== "fullscreen" || typeof fullscreenTui.wheelScrollLines !== "number") {
		return false;
	}

	fullscreenTui.wheelScrollLines = normalizeFullscreenWheelScrollLines(value);
	return true;
}
