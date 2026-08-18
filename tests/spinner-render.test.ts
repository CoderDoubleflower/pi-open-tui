import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	buildPingPongFrames,
	createNativeSpinnerIndicator,
	detectSpinnerPlatform,
	renderNativeSpinnerMessage,
} from "../extensions/open-tui/spinner-render.ts";
import {
	createSpinnerRuntimeState,
	type SpinnerMode,
	type SpinnerRuntimeState,
} from "../extensions/open-tui/spinner-state.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

function activeState(overrides: Partial<SpinnerRuntimeState> = {}): SpinnerRuntimeState {
	return {
		...createSpinnerRuntimeState(),
		active: true,
		agentStartedAtMs: 0,
		lastResponseAtMs: 0,
		randomVerb: "Working",
		...overrides,
	};
}

function render(
	state: SpinnerRuntimeState,
	options: { nowMs?: number; verbose?: boolean } = {},
): string {
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.verbose = options.verbose ?? true;
	return renderNativeSpinnerMessage({
		state,
		config,
		nowMs: options.nowMs ?? 31_000,
	}) ?? "";
}

test("renders one Claude-style token counter with direction derived from mode", () => {
	for (const mode of ["requesting", "thinking", "responding", "tool-input", "tool-use"] as SpinnerMode[]) {
		const message = render(activeState({
			mode,
			inputTokens: 4_800,
			outputTokens: 1_200,
			responseLength: 4_800,
			displayedResponseLength: 4_800,
		}));
		const arrow = mode === "requesting" ? "↑" : "↓";
		assert.match(message, /^Working…/);
		assert.match(message, new RegExp(`${arrow} 1\\.2k tokens`));
		assert.doesNotMatch(message, /4\.8k tokens/);
		assert.equal((message.match(/tokens/g) ?? []).length, 1);
	}
});

test("real provider usage is retained in state but not rendered as spinner token segments", () => {
	const message = render(activeState({
		mode: "responding",
		inputTokens: 4_800,
		outputTokens: 1_200,
	}));
	assert.equal(message, "Working… (31s)");
});

test("uses Claude-style compact token formatting", () => {
	assert.equal(
		render(activeState({
			mode: "responding",
			responseLength: 40_000,
			displayedResponseLength: 40_000,
		})),
		"Working… (31s · ↓ 10.0k tokens)",
	);
});

test("reduced motion snaps the visible token estimate to the streamed response length", () => {
	const state = activeState({
		mode: "responding",
		responseLength: 400,
		displayedResponseLength: 0,
	});
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.verbose = true;
	config.reducedMotion = true;
	assert.equal(
		renderNativeSpinnerMessage({ state, config, nowMs: 1_000 }),
		"Working… (1s · ↓ 100 tokens)",
	);
});

test("preserves thinking, hold, effort, and completed thought wording", () => {
	const state = activeState({ thinkingPhase: "thinking", effectiveEffort: "xhigh" });
	assert.match(render(state), /thinking with xhigh effort/);

	state.thinkingPhase = "holding-thinking";
	state.effectiveEffort = null;
	assert.match(render(state), /\(31s · thinking\)$/);

	state.thinkingPhase = "thought";
	state.thinkingActualDurationMs = 3_600;
	assert.match(render(state), /thought for 4s/);
});

test("orders native message metadata as timer, tokens, thinking", () => {
	const message = render(activeState({
		mode: "responding",
		inputTokens: 2_000,
		outputTokens: 1_200,
		responseLength: 4_800,
		displayedResponseLength: 4_800,
		thinkingPhase: "thinking",
		effectiveEffort: "high",
	}));
	assert.equal(
		message,
		"Working… (31s · ↓ 1.2k tokens · thinking with high effort)",
	);
});

test("uses the strict 30 second metadata gate", () => {
	const state = activeState({
		responseLength: 400,
		displayedResponseLength: 400,
	});
	assert.equal(render(state, { nowMs: 29_999, verbose: false }), "Working…");
	assert.equal(render(state, { nowMs: 30_000, verbose: false }), "Working…");
	assert.equal(
		render(state, { nowMs: 30_001, verbose: false }),
		"Working… (30s · ↑ 100 tokens)",
	);
	assert.equal(
		render(state, { nowMs: 65_000, verbose: false }),
		"Working… (1m 5s · ↑ 100 tokens)",
	);
});

test("verbose native message exposes metrics immediately", () => {
	assert.equal(
		render(activeState({
			mode: "responding",
			responseLength: 400,
			displayedResponseLength: 400,
		}), { nowMs: 1_000 }),
		"Working… (1s · ↓ 100 tokens)",
	);
});

test("honors native message segment and effort display switches", () => {
	const state = activeState({
		mode: "responding",
		inputTokens: 400,
		outputTokens: 100,
		responseLength: 400,
		displayedResponseLength: 400,
		thinkingPhase: "thinking",
		effectiveEffort: "high",
	});
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.verbose = true;
	config.showTimer = false;
	config.showTokens = false;
	config.effortDisplay = "off";
	assert.equal(renderNativeSpinnerMessage({ state, config, nowMs: 31_000 }), "Working… (thinking)");
	config.showThinking = false;
	assert.equal(renderNativeSpinnerMessage({ state, config, nowMs: 31_000 }), "Working…");
});

test("renders a resolved task or override base with exactly one ellipsis", () => {
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	assert.equal(renderNativeSpinnerMessage({
		state: activeState(),
		config,
		nowMs: 0,
		baseMessage: "正在检查...",
	}), "正在检查…");
});

test("orders suffix before timer, tokens, and thinking", () => {
	const state = activeState({
		mode: "responding",
		inputTokens: 2_000,
		outputTokens: 1_200,
		responseLength: 4_800,
		displayedResponseLength: 4_800,
		thinkingPhase: "thinking",
		effectiveEffort: "high",
	});
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	config.verbose = true;
	assert.equal(renderNativeSpinnerMessage({
		state,
		config,
		nowMs: 31_000,
		suffix: "workspace",
	}), "Working… (workspace · 31s · ↓ 1.2k tokens · thinking with high effort)");
});

test("suffix visibility is independent from the main message", () => {
	const state = activeState();
	const config = structuredClone(DEFAULT_CONFIG.spinner);
	assert.equal(renderNativeSpinnerMessage({
		state,
		config,
		nowMs: 0,
		baseMessage: "Fixing authentication",
		suffix: "项目 🔍",
	}), "Fixing authentication… (项目 🔍)");
	config.showSuffix = false;
	assert.equal(renderNativeSpinnerMessage({
		state,
		config,
		nowMs: 0,
		baseMessage: "Fixing authentication",
		suffix: "项目 🔍",
	}), "Fixing authentication…");
});

test("detects Ghostty before macOS", () => {
	assert.equal(detectSpinnerPlatform({ platform: "darwin", env: { TERM_PROGRAM: "Ghostty" } }), "ghostty");
	assert.equal(detectSpinnerPlatform({ platform: "darwin", env: {} }), "macos");
	assert.equal(detectSpinnerPlatform({ platform: "linux", env: {} }), "other");
});

test("builds native ping-pong frames with repeated endpoints", () => {
	assert.deepEqual(buildPingPongFrames(["a", "b", "c"]), ["a", "b", "c", "c", "b", "a"]);
	const indicator = createNativeSpinnerIndicator("macos", false, 0, theme);
	assert.equal(indicator.intervalMs, 120);
	assert.equal(indicator.frames?.length, 12);
	assert.equal(indicator.frames?.[0], "<accent>·</accent>");
	assert.equal(indicator.frames?.[5], "<accent>✽</accent>");
	assert.equal(indicator.frames?.[6], "<accent>✽</accent>");
	assert.equal(indicator.frames?.[11], "<accent>·</accent>");
});

test("uses platform-specific native indicator glyphs", () => {
	assert.equal(createNativeSpinnerIndicator("ghostty", false, 0, theme).frames?.[5], "<accent>*</accent>");
	assert.equal(createNativeSpinnerIndicator("other", false, 0, theme).frames?.[2], "<accent>*</accent>");
});

test("reduced motion uses one static native indicator frame", () => {
	assert.deepEqual(createNativeSpinnerIndicator("other", true, 0, theme), {
		frames: ["<accent>●</accent>"],
	});
});

test("stall state recolors only the native indicator", () => {
	assert.equal(createNativeSpinnerIndicator("other", false, 0, theme).frames?.[0], "<accent>·</accent>");
	assert.equal(createNativeSpinnerIndicator("other", false, 0.5, theme).frames?.[0], "<warning>·</warning>");
	assert.equal(createNativeSpinnerIndicator("other", false, 1, theme).frames?.[0], "<error>·</error>");
});

test("native message leaves width handling to Pi", () => {
	const verb = "正在仔细检查整个代码库中的实现细节";
	assert.equal(render(activeState({ randomVerb: verb }), { nowMs: 0, verbose: false }), `${verb}…`);
});

test("inactive state does not publish a working message", () => {
	assert.equal(renderNativeSpinnerMessage({
		state: createSpinnerRuntimeState(),
		config: DEFAULT_CONFIG.spinner,
		nowMs: 0,
	}), undefined);
});
