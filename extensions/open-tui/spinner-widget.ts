import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	installNativeStatusBridge,
	type NativeStatusSink,
} from "./native-status-bridge.ts";
import {
	buildPingPongFrames,
	SPINNER_GLYPHS,
	type SpinnerPlatform,
} from "./spinner-render.ts";
import type { SpinnerPhase } from "./spinner-state.ts";
import { formatDuration } from "./utils.ts";

export const SPINNER_WIDGET_KEY = "open-tui-spinner";
export const SPINNER_WIDGET_INTERVAL_MS = 120;
const MAX_NATIVE_STATUS_BRIDGE_ATTEMPTS = 8;

export interface SpinnerWidgetSnapshot {
	phase: SpinnerPhase;
	active: boolean;
	message?: string;
	completionVerb: string;
	completedDurationMs: number | null;
	hasAttachedTodos: boolean;
	reducedMotion: boolean;
	stalledIntensity: number;
}

export interface SpinnerWidgetSource extends NativeStatusSink {
	getWidgetSnapshot(): SpinnerWidgetSnapshot;
	setRequestRender(requestRender: (() => void) | undefined): void;
}

function spinnerColor(stalledIntensity: number): ThemeColor {
	if (stalledIntensity >= 1) return "error";
	if (stalledIntensity > 0) return "warning";
	return "accent";
}

function withEditorGap(line: string, hasAttachedTodos: boolean): string[] {
	return hasAttachedTodos ? [line] : [line, ""];
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
	let bridgeAttempts = 0;
	let cleanupNativeStatusBridge: (() => void) | undefined;

	const requestRender = () => {
		if (!disposed) tui.requestRender();
	};
	source.setRequestRender(requestRender);

	const animationTimer = setInterval(() => {
		if (disposed) return;
		const snapshot = source.getWidgetSnapshot();
		if (snapshot.phase !== "running" || snapshot.reducedMotion) return;
		frameIndex = (frameIndex + 1) % frames.length;
		tui.requestRender();
	}, SPINNER_WIDGET_INTERVAL_MS);
	animationTimer.unref?.();

	const component: Component & { dispose(): void } = {
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(animationTimer);
			cleanupNativeStatusBridge?.();
			cleanupNativeStatusBridge = undefined;
			source.setRequestRender(undefined);
		},
		invalidate() {},
		render(width: number): string[] {
			if (disposed || width <= 0) return [];
			if (!cleanupNativeStatusBridge && bridgeAttempts < MAX_NATIVE_STATUS_BRIDGE_ATTEMPTS) {
				bridgeAttempts++;
				cleanupNativeStatusBridge = installNativeStatusBridge(tui, component, source);
			}

			const snapshot = source.getWidgetSnapshot();
			if (snapshot.phase === "hidden") return [];

			const ellipsis = theme.fg("dim", "...");
			if (snapshot.phase === "idle") {
				const duration = formatDuration(snapshot.completedDurationMs ?? 0);
				const line = truncateToWidth(
					theme.fg("dim", `✻ ${snapshot.completionVerb || "Worked"} for ${duration}`),
					width,
					ellipsis,
				);
				return withEditorGap(line, snapshot.hasAttachedTodos);
			}
			if (!snapshot.message) return snapshot.hasAttachedTodos ? [] : ["", ""];

			const glyph = snapshot.reducedMotion
				? "●"
				: frames[frameIndex] ?? frames[0] ?? "·";
			const color = spinnerColor(snapshot.stalledIntensity);
			const line = `${theme.fg(color, glyph)} ${theme.fg("muted", snapshot.message)}`;
			return withEditorGap(truncateToWidth(line, width, ellipsis), snapshot.hasAttachedTodos);
		},
	};

	return component;
}
