export const MIN_THINKING_VISIBLE_MS = 2_000;
export const THOUGHT_VISIBLE_MS = 2_000;
export const STALL_DELAY_MS = 3_000;
export const STALL_RAMP_MS = 2_000;

export type SpinnerMode =
	| "requesting"
	| "thinking"
	| "responding"
	| "tool-input"
	| "tool-use";

export type ThinkingPhase = "none" | "thinking" | "holding-thinking" | "thought";

export interface SpinnerClock {
	now(): number;
}

export interface SpinnerRandom {
	pick<T>(items: readonly T[]): T;
}

export interface SpinnerRuntimeState {
	active: boolean;
	mode: SpinnerMode;
	agentStartedAtMs: number | null;
	turnStartedAtMs: number | null;
	randomVerb: string;
	inputTokens: number;
	outputTokens: number;
	completedInputTokens: number;
	completedOutputTokens: number;
	currentInputTokens: number;
	currentOutputTokens: number;
	lastResponseAtMs: number | null;
	activeToolIds: Set<string>;
	thinkingStartedAtMs: number | null;
	thinkingEndedAtMs: number | null;
	thinkingActualDurationMs: number | null;
	thinkingPhase: ThinkingPhase;
	thinkingPhaseUntilMs: number | null;
	effectiveEffort: string | null;
	stalledIntensity: number;
}

export type SpinnerMessageEvent =
	| { type: "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" | "toolcall_end" }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; delta: string }
	| { type: "start" | "done" | "error" };

export interface SpinnerTokenUsage {
	input?: number;
	output?: number;
}

export interface SpinnerStateOptions {
	clock: SpinnerClock;
	random: SpinnerRandom;
	getVerbs: () => readonly string[];
}

export function createSpinnerRuntimeState(): SpinnerRuntimeState {
	return {
		active: false,
		mode: "requesting",
		agentStartedAtMs: null,
		turnStartedAtMs: null,
		randomVerb: "",
		inputTokens: 0,
		outputTokens: 0,
		completedInputTokens: 0,
		completedOutputTokens: 0,
		currentInputTokens: 0,
		currentOutputTokens: 0,
		lastResponseAtMs: null,
		activeToolIds: new Set(),
		thinkingStartedAtMs: null,
		thinkingEndedAtMs: null,
		thinkingActualDurationMs: null,
		thinkingPhase: "none",
		thinkingPhaseUntilMs: null,
		effectiveEffort: null,
		stalledIntensity: 0,
	};
}

export function shouldShowSpinnerMetrics(
	state: SpinnerRuntimeState,
	nowMs: number,
	verbose: boolean,
): boolean {
	return state.agentStartedAtMs !== null
		&& (verbose || nowMs - state.agentStartedAtMs > 30_000);
}

export function thoughtDurationSeconds(state: SpinnerRuntimeState): number | null {
	if (state.thinkingActualDurationMs === null) return null;
	return Math.max(1, Math.round(state.thinkingActualDurationMs / 1_000));
}

export class SpinnerStateMachine {
	private runtimeState = createSpinnerRuntimeState();
	private readonly options: SpinnerStateOptions;

	constructor(options: SpinnerStateOptions) {
		this.options = options;
	}

	get state(): SpinnerRuntimeState {
		return this.runtimeState;
	}

	agentStart(effectiveEffort: string | null = null): void {
		const now = this.options.clock.now();
		this.runtimeState = {
			...createSpinnerRuntimeState(),
			active: true,
			agentStartedAtMs: now,
			lastResponseAtMs: now,
			randomVerb: this.options.random.pick(this.options.getVerbs()),
			effectiveEffort,
		};
	}

	agentEnd(): void {
		this.runtimeState = createSpinnerRuntimeState();
	}

	turnStart(): void {
		const now = this.options.clock.now();
		if (this.hasCurrentTokenUsage()) this.finalizeCurrentTokenUsage();
		this.runtimeState.mode = "requesting";
		this.runtimeState.turnStartedAtMs = now;
		this.runtimeState.lastResponseAtMs = now;
		this.runtimeState.stalledIntensity = 0;
		this.runtimeState.currentInputTokens = 0;
		this.runtimeState.currentOutputTokens = 0;
		this.syncTokenTotals();
	}

	messageUpdate(event: SpinnerMessageEvent, usage?: SpinnerTokenUsage): void {
		this.updateCurrentTokenUsage(usage);
		switch (event.type) {
			case "thinking_start":
				this.startThinking();
				break;
			case "thinking_delta":
				this.runtimeState.mode = "thinking";
				if (event.delta.length > 0) {
					if (this.runtimeState.thinkingPhase !== "thinking") this.startThinking();
					this.recordDelta(event.delta);
				}
				break;
			case "thinking_end":
				this.endThinking();
				break;
			case "text_start":
				this.runtimeState.mode = "responding";
				break;
			case "text_delta":
				this.runtimeState.mode = "responding";
				this.recordDelta(event.delta);
				break;
			case "toolcall_start":
				this.runtimeState.mode = "tool-input";
				break;
			case "toolcall_delta":
				this.runtimeState.mode = "tool-input";
				this.recordDelta(event.delta);
				break;
		}
	}

	messageEnd(usage?: SpinnerTokenUsage): void {
		if (this.runtimeState.thinkingPhase === "thinking") this.endThinking();
		this.finalizeCurrentTokenUsage(usage);
	}

	toolExecutionStart(toolCallId: string): void {
		this.runtimeState.activeToolIds.add(toolCallId);
		this.runtimeState.mode = "tool-use";
		this.runtimeState.stalledIntensity = 0;
	}

	toolExecutionEnd(toolCallId: string): void {
		const removed = this.runtimeState.activeToolIds.delete(toolCallId);
		if (removed && this.runtimeState.activeToolIds.size === 0) {
			this.runtimeState.lastResponseAtMs = this.options.clock.now();
			this.runtimeState.stalledIntensity = 0;
		}
	}

	setEffectiveEffort(level: string | null, reasoning: boolean): void {
		this.runtimeState.effectiveEffort = reasoning && level && level !== "off" ? level : null;
	}

	tick(): void {
		const now = this.options.clock.now();
		this.advanceThinking(now);
		this.runtimeState.stalledIntensity = this.calculateStallIntensity(now);
	}

	private startThinking(): void {
		const now = this.options.clock.now();
		this.runtimeState.mode = "thinking";
		this.runtimeState.thinkingStartedAtMs = now;
		this.runtimeState.thinkingEndedAtMs = null;
		this.runtimeState.thinkingActualDurationMs = null;
		this.runtimeState.thinkingPhase = "thinking";
		this.runtimeState.thinkingPhaseUntilMs = null;
	}

	private endThinking(): void {
		const startedAt = this.runtimeState.thinkingStartedAtMs;
		if (startedAt === null || this.runtimeState.thinkingPhase !== "thinking") return;
		const now = this.options.clock.now();
		const duration = now - startedAt;
		this.runtimeState.thinkingEndedAtMs = now;
		this.runtimeState.thinkingActualDurationMs = duration;
		if (duration < MIN_THINKING_VISIBLE_MS) {
			this.runtimeState.thinkingPhase = "holding-thinking";
			this.runtimeState.thinkingPhaseUntilMs = startedAt + MIN_THINKING_VISIBLE_MS;
		} else {
			this.runtimeState.thinkingPhase = "thought";
			this.runtimeState.thinkingPhaseUntilMs = now + THOUGHT_VISIBLE_MS;
		}
	}

	private recordDelta(delta: string): void {
		if (delta.length === 0) return;
		this.runtimeState.lastResponseAtMs = this.options.clock.now();
		this.runtimeState.stalledIntensity = 0;
	}

	private advanceThinking(now: number): void {
		const phaseUntil = this.runtimeState.thinkingPhaseUntilMs;
		if (
			this.runtimeState.thinkingPhase === "holding-thinking"
			&& phaseUntil !== null
			&& now >= phaseUntil
		) {
			this.runtimeState.thinkingPhase = "thought";
			this.runtimeState.thinkingPhaseUntilMs = phaseUntil + THOUGHT_VISIBLE_MS;
		}
		if (
			this.runtimeState.thinkingPhase === "thought"
			&& now >= this.runtimeState.thinkingPhaseUntilMs!
		) {
			this.runtimeState.thinkingPhase = "none";
			this.runtimeState.thinkingPhaseUntilMs = null;
		}
	}

	private updateCurrentTokenUsage(usage: SpinnerTokenUsage | undefined): void {
		const state = this.runtimeState;
		if (usage) {
			const input = normalizeTokenCount(usage.input);
			const output = normalizeTokenCount(usage.output);
			if (input !== null) state.currentInputTokens = Math.max(state.currentInputTokens, input);
			if (output !== null) state.currentOutputTokens = Math.max(state.currentOutputTokens, output);
		}
		this.syncTokenTotals();
	}

	private finalizeCurrentTokenUsage(usage?: SpinnerTokenUsage): void {
		this.updateCurrentTokenUsage(usage);
		const state = this.runtimeState;
		state.completedInputTokens = state.inputTokens;
		state.completedOutputTokens = state.outputTokens;
		state.currentInputTokens = 0;
		state.currentOutputTokens = 0;
		this.syncTokenTotals();
	}

	private hasCurrentTokenUsage(): boolean {
		const state = this.runtimeState;
		return state.currentInputTokens > 0
			|| state.currentOutputTokens > 0;
	}

	private syncTokenTotals(): void {
		const state = this.runtimeState;
		state.inputTokens = state.completedInputTokens + state.currentInputTokens;
		state.outputTokens = state.completedOutputTokens + state.currentOutputTokens;
	}

	private calculateStallIntensity(now: number): number {
		const state = this.runtimeState;
		if (!state.active || state.activeToolIds.size > 0 || state.lastResponseAtMs === null) return 0;
		return Math.min(1, Math.max(0, (now - state.lastResponseAtMs - STALL_DELAY_MS) / STALL_RAMP_MS));
	}
}

function normalizeTokenCount(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: null;
}
