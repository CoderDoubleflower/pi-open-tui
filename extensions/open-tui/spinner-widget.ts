import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	buildPingPongFrames,
	SPINNER_GLYPHS,
	type SpinnerPlatform,
} from "./spinner-render.ts";
import type { SpinnerPhase } from "./spinner-state.ts";
import { formatDuration } from "./utils.ts";

export const SPINNER_WIDGET_KEY = "open-tui-spinner";
export const SPINNER_WIDGET_INTERVAL_MS = 120;
const CLAUDE_GLIMMER_INTERVAL_MS = 50;

// Claude Code's dark-theme system-spinner palette. Compaction switches to the
// system spinner before compact_start, and compact_start only changes message.
const CLAUDE_SYSTEM_BLUE = { r: 147, g: 165, b: 255 } as const;
const CLAUDE_SYSTEM_BLUE_SHIMMER = { r: 177, g: 195, b: 255 } as const;

export type SpinnerWidgetVisualMode = "default" | "system-requesting";

export interface SpinnerWidgetSnapshot {
	phase: SpinnerPhase;
	active: boolean;
	message?: string;
	visualMode?: SpinnerWidgetVisualMode;
	retryMessage?: string;
	completionVerb: string;
	completedDurationMs: number | null;
	hasAttachedTodos: boolean;
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

function withEditorGap(lines: string[], hasAttachedTodos: boolean): string[] {
	return hasAttachedTodos ? lines : [...lines, ""];
}

function rgb(text: string, color: { r: number; g: number; b: number }): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[39m`;
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

function renderClaudeSystemMessage(message: string, nowMs: number, reducedMotion: boolean): string {
	if (reducedMotion) return rgb(message, CLAUDE_SYSTEM_BLUE);
	const characters = Array.from(message);
	const cycleLength = characters.length + 20;
	const glimmerIndex = (Math.floor(nowMs / CLAUDE_GLIMMER_INTERVAL_MS) % cycleLength) - 10;
	return characters.map((character, index) =>
		Math.abs(index - glimmerIndex) <= 1
			? rgb(character, CLAUDE_SYSTEM_BLUE_SHIMMER)
			: rgb(character, CLAUDE_SYSTEM_BLUE)
	).join("");
}

function renderClaudeSystemGlyph(
	glyph: string,
	nowMs: number,
	reducedMotion: boolean,
): string {
	const rendered = rgb(reducedMotion ? "●" : glyph, CLAUDE_SYSTEM_BLUE);
	if (!reducedMotion) return rendered;
	// Claude reduced-motion spinner uses a 2s cycle: 1s visible, 1s dim.
	return Math.floor(nowMs / 1_000) % 2 === 0 ? rendered : dim(rendered);
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
		if (snapshot.phase !== "running" || snapshot.reducedMotion) return;
		frameIndex = (frameIndex + 1) % frames.length;
		tui.requestRender();
	}, SPINNER_WIDGET_INTERVAL_MS);
	animationTimer.unref?.();

	const glimmerTimer = setInterval(() => {
		if (disposed) return;
		const snapshot = source.getWidgetSnapshot();
		if (snapshot.phase !== "running" || snapshot.visualMode !== "system-requesting") return;
		tui.requestRender();
	}, CLAUDE_GLIMMER_INTERVAL_MS);
	glimmerTimer.unref?.();

	const component: Component & { dispose(): void } = {
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(animationTimer);
			clearInterval(glimmerTimer);
			source.setRequestRender(undefined);
		},
		invalidate() {},
		render(width: number): string[] {
			if (disposed || width <= 0) return [];

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
				return withEditorGap([line], snapshot.hasAttachedTodos);
			}
			if (!snapshot.message) return snapshot.hasAttachedTodos ? [] : ["", ""];

			const nowMs = performance.now();
			const glyph = frames[frameIndex] ?? frames[0] ?? "·";
			let line: string;
			if (snapshot.visualMode === "system-requesting") {
				const systemGlyph = renderClaudeSystemGlyph(glyph, nowMs, snapshot.reducedMotion);
				const systemMessage = renderClaudeSystemMessage(snapshot.message, nowMs, snapshot.reducedMotion);
				line = `${systemGlyph} ${systemMessage}`;
			} else {
				const normalGlyph = snapshot.reducedMotion ? "●" : glyph;
				const color = spinnerColor(snapshot.stalledIntensity);
				// Claude Code renders the normal spinner glyph and active verb with the same Claude/stall color.
				line = `${theme.fg(color, normalGlyph)} ${theme.fg(color, snapshot.message)}`;
			}

			const lines: string[] = [];
			if (snapshot.retryMessage) {
				// Claude renders API retry status as a dim MessageResponse line above
				// the still-running main spinner. The first three retries have no row.
				lines.push(truncateToWidth(theme.fg("dim", `  ⎿  ${snapshot.retryMessage}`), width, ellipsis));
			}
			lines.push(truncateToWidth(line, width, ellipsis));
			return withEditorGap(lines, snapshot.hasAttachedTodos);
		},
	};

	return component;
}
