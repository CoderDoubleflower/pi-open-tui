import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	buildPingPongFrames,
	SPINNER_GLYPHS,
	type SpinnerPlatform,
} from "./spinner-render.ts";

export const SPINNER_WIDGET_KEY = "open-tui-spinner";
export const SPINNER_WIDGET_INTERVAL_MS = 120;

export interface SpinnerWidgetSnapshot {
	active: boolean;
	message?: string;
	reducedMotion: boolean;
	stalledIntensity: number;
}

export interface SpinnerWidgetSource {
	getWidgetSnapshot(): SpinnerWidgetSnapshot;
	setRequestRender(requestRender: (() => void) | undefined): void;
}

function spinnerColor(stalledIntensity: number): ThemeColor {
	if (stalledIntensity >= 1) return "error";
	if (stalledIntensity > 0) return "warning";
	return "accent";
}

export function createSpinnerWidget(
	tui: TUI,
	theme: Theme,
	platform: SpinnerPlatform,
	source: SpinnerWidgetSource,
): Component & { dispose(): void } {
	const frames = buildPingPongFrames(SPINNER_GLYPHS[platform]);
	let frameIndex = 0;
	let disposed = false;

	const requestRender = () => {
		if (!disposed) tui.requestRender();
	};
	source.setRequestRender(requestRender);

	const animationTimer = setInterval(() => {
		if (disposed) return;
		const snapshot = source.getWidgetSnapshot();
		if (!snapshot.active || snapshot.reducedMotion) return;
		frameIndex = (frameIndex + 1) % frames.length;
		tui.requestRender();
	}, SPINNER_WIDGET_INTERVAL_MS);
	animationTimer.unref?.();

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(animationTimer);
			source.setRequestRender(undefined);
		},
		invalidate() {},
		render(width: number): string[] {
			if (disposed || width <= 0) return [];
			const snapshot = source.getWidgetSnapshot();
			if (!snapshot.active || !snapshot.message) return [];

			const glyph = snapshot.reducedMotion
				? "●"
				: frames[frameIndex] ?? frames[0] ?? "·";
			const color = spinnerColor(snapshot.stalledIntensity);
			const line = `${theme.fg(color, glyph)} ${theme.fg("muted", snapshot.message)}`;
			return [truncateToWidth(line, width, theme.fg("dim", "..."))];
		},
	};
}
