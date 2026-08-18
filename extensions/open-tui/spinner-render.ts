import type {
	Theme,
	ThemeColor,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { SpinnerConfig } from "./config.ts";
import { sanitizeSpinnerMessage } from "./spinner-content.ts";
import { sanitizeSpinnerSuffix } from "./spinner-suffix.ts";
import {
	shouldShowSpinnerMetrics,
	spinnerDisplayTokens,
	thoughtDurationSeconds,
	type SpinnerMode,
	type SpinnerRuntimeState,
} from "./spinner-state.ts";
import { formatDuration } from "./utils.ts";

export type SpinnerPlatform = "macos" | "ghostty" | "other";

export interface SpinnerEnvironment {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
}

export const SPINNER_GLYPHS: Record<SpinnerPlatform, readonly string[]> = {
	macos: ["·", "✢", "✳", "✶", "✻", "✽"],
	ghostty: ["·", "✢", "✳", "✶", "✻", "*"],
	other: ["·", "✢", "*", "✶", "✻", "✽"],
};

export interface NativeSpinnerMessageOptions {
	state: SpinnerRuntimeState;
	config: SpinnerConfig;
	nowMs: number;
	baseMessage?: string;
	suffix?: string | null;
}

const spinnerTokenFormatter = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
});

function formatSpinnerTokens(tokens: number): string {
	if (tokens < 1_000) return tokens.toString();
	return spinnerTokenFormatter.format(tokens).toLowerCase();
}

function spinnerTokenDirection(mode: SpinnerMode): "↑" | "↓" {
	return mode === "requesting" ? "↑" : "↓";
}

export function detectSpinnerPlatform(input: SpinnerEnvironment): SpinnerPlatform {
	if (
		input.env.TERM_PROGRAM?.toLowerCase() === "ghostty"
		|| input.env.GHOSTTY_RESOURCES_DIR !== undefined
	) {
		return "ghostty";
	}
	return input.platform === "darwin" ? "macos" : "other";
}

export function buildPingPongFrames(base: readonly string[]): string[] {
	return [...base, ...base.slice().reverse()];
}

function stallColor(intensity: number): ThemeColor {
	if (intensity >= 1) return "error";
	if (intensity > 0) return "warning";
	return "accent";
}

export function createNativeSpinnerIndicator(
	platform: SpinnerPlatform,
	reducedMotion: boolean,
	stalledIntensity: number,
	theme: Theme,
): WorkingIndicatorOptions {
	const color = stallColor(stalledIntensity);
	if (reducedMotion) {
		return { frames: [theme.fg(color, "●")] };
	}
	return {
		frames: buildPingPongFrames(SPINNER_GLYPHS[platform]).map((frame) => theme.fg(color, frame)),
		intervalMs: 120,
	};
}

function thinkingSegment(state: SpinnerRuntimeState, config: SpinnerConfig): string | null {
	if (!config.showThinking) return null;
	if (state.thinkingPhase === "thinking" || state.thinkingPhase === "holding-thinking") {
		return config.effortDisplay === "effective" && state.effectiveEffort
			? `thinking with ${state.effectiveEffort} effort`
			: "thinking";
	}
	if (state.thinkingPhase === "thought") {
		return `thought for ${thoughtDurationSeconds(state)}s`;
	}
	return null;
}

export function renderNativeSpinnerMessage(options: NativeSpinnerMessageOptions): string | undefined {
	const { state, config, nowMs } = options;
	if (!state.active) return undefined;

	const metadata: string[] = [];
	const suffix = config.showSuffix ? sanitizeSpinnerSuffix(options.suffix) : null;
	if (suffix) metadata.push(suffix);
	if (shouldShowSpinnerMetrics(state, nowMs, config.verbose)) {
		if (config.showTimer) {
			metadata.push(formatDuration(Math.max(0, nowMs - state.agentStartedAtMs!)));
		}
		if (config.showTokens) {
			const tokens = spinnerDisplayTokens(state, config.reducedMotion);
			if (tokens > 0) {
				metadata.push(`${spinnerTokenDirection(state.mode)} ${formatSpinnerTokens(tokens)} tokens`);
			}
		}
	}
	const thinking = thinkingSegment(state, config);
	if (thinking) metadata.push(thinking);

	const baseMessage = sanitizeSpinnerMessage(options.baseMessage)
		?? sanitizeSpinnerMessage(state.randomVerb)
		?? "Working";
	const message = `${baseMessage}…`;
	return metadata.length > 0 ? `${message} (${metadata.join(" · ")})` : message;
}
