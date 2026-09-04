import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpinnerConfig } from "./config.ts";
import {
	formatClaudeRetryStatus,
	type NativeStatusPresentation,
} from "./native-status-bridge.ts";
import { TURN_COMPLETION_VERBS } from "./spinner-completion-verbs.ts";
import { resolveSpinnerMessage } from "./spinner-content.ts";
import {
	SPINNER_MOUNTED_EVENT,
	SPINNER_UNMOUNTED_EVENT,
	TODO_SPINNER_SOURCE,
	SpinnerEventStore,
} from "./spinner-events.ts";
import {
	detectSpinnerPlatform,
	renderNativeSpinnerMessage,
	type SpinnerEnvironment,
	type SpinnerPlatform,
} from "./spinner-render.ts";
import {
	SpinnerStateMachine,
	type SpinnerClock,
	type SpinnerMessageEvent,
	type SpinnerRandom,
	type SpinnerRuntimeState,
	type SpinnerTokenUsage,
} from "./spinner-state.ts";
import { SpinnerSuffixStore } from "./spinner-suffix.ts";
import { resolveSpinnerVerbs } from "./spinner-verbs.ts";
import {
	createSpinnerWidget,
	SPINNER_WIDGET_KEY,
	type SpinnerWidgetSnapshot,
	type SpinnerWidgetSource,
} from "./spinner-widget.ts";

export interface SpinnerDependencies {
	clock: SpinnerClock;
	random: SpinnerRandom;
	environment: SpinnerEnvironment;
	getVerbs?: () => readonly string[];
}

export interface SpinnerInstallation {
	controller: SpinnerController;
	dispose(): void;
}

const defaultDependencies: SpinnerDependencies = {
	clock: { now: () => performance.now() },
	random: {
		pick<T>(items: readonly T[]): T {
			return items[Math.floor(Math.random() * items.length)]!;
		},
	},
	environment: { platform: process.platform, env: process.env },
};

function effortValue(level: string | null, reasoning: boolean): string | null {
	return reasoning && level && level !== "off" ? level : null;
}

function renderSignature(snapshot: SpinnerWidgetSnapshot): string {
	const stallBucket = snapshot.stalledIntensity >= 1 ? 2 : snapshot.stalledIntensity > 0 ? 1 : 0;
	return JSON.stringify([
		snapshot.phase,
		snapshot.active,
		snapshot.message,
		snapshot.visualMode,
		snapshot.retryMessage,
		snapshot.completionVerb,
		snapshot.completedDurationMs,
		snapshot.hasAttachedTodos,
		snapshot.reducedMotion,
		stallBucket,
	]);
}

interface NativeStatusState {
	token: object;
	presentation: NativeStatusPresentation;
}

interface RetryContinuationState {
	agentStartedAtMs: number | null;
	randomVerb: string;
	inputTokens: number;
	outputTokens: number;
	responseLength: number;
	displayedResponseLength: number;
}

export class SpinnerController implements SpinnerWidgetSource {
	readonly stateMachine: SpinnerStateMachine;
	private readonly getConfig: () => SpinnerConfig;
	private readonly dependencies: SpinnerDependencies;
	private readonly spinnerPlatform: SpinnerPlatform;
	private readonly eventStore: SpinnerEventStore;
	private readonly suffixStore: SpinnerSuffixStore;
	private requestRender: (() => void) | undefined;
	private lastRenderSignature = "";
	private completionVerb = "Worked";
	private nativeStatus: NativeStatusState | undefined;
	private retryContinuation: RetryContinuationState | undefined;
	private compactionContinuation: SpinnerRuntimeState | undefined;
	private disposed = false;

	constructor(
		events: ExtensionAPI["events"],
		getConfig: () => SpinnerConfig,
		dependencies: SpinnerDependencies,
	) {
		this.getConfig = getConfig;
		this.dependencies = dependencies;
		this.spinnerPlatform = detectSpinnerPlatform(dependencies.environment);
		this.eventStore = new SpinnerEventStore(events, () => this.refresh());
		this.suffixStore = new SpinnerSuffixStore(events, () => this.refresh());
		this.stateMachine = new SpinnerStateMachine({
			clock: dependencies.clock,
			random: dependencies.random,
			getVerbs: dependencies.getVerbs ?? (() => resolveSpinnerVerbs(this.getConfig())),
		});
	}

	get state() {
		return this.stateMachine.state;
	}

	get platform(): SpinnerPlatform {
		return this.spinnerPlatform;
	}

	initialize(): void {
		this.publish();
	}

	setRequestRender(requestRender: (() => void) | undefined): void {
		if (this.disposed && requestRender) return;
		this.requestRender = requestRender;
		if (requestRender) {
			this.lastRenderSignature = "";
			this.publish();
		}
	}

	getWidgetSnapshot(): SpinnerWidgetSnapshot {
		const config = this.getConfig();
		const content = this.eventStore.content;
		const hasAttachedTodos = this.eventStore.hasTasks(TODO_SPINNER_SOURCE);
		const presentation = this.nativeStatus?.presentation;

		if (presentation?.style === "system-requesting") {
			return {
				phase: "running",
				active: true,
				message: presentation.message,
				visualMode: "system-requesting",
				completionVerb: this.completionVerb,
				completedDurationMs: null,
				hasAttachedTodos,
				reducedMotion: config.reducedMotion,
				stalledIntensity: 0,
			};
		}

		const forceRunning = presentation?.style === "retry" || this.retryContinuation !== undefined;
		const runtimeState: SpinnerRuntimeState = forceRunning && this.state.phase !== "running"
			? {
				...this.state,
				phase: "running",
				active: true,
				mode: "requesting",
				agentCompletedDurationMs: null,
				lastResponseAtMs: this.dependencies.clock.now(),
				stalledIntensity: 0,
			}
			: this.state;

		const baseMessage = resolveSpinnerMessage({
			overrideMessage: content.overrideMessage,
			currentTask: config.taskIntegration === "events" ? content.currentTask : null,
			randomVerb: runtimeState.randomVerb,
		});
		const retryMessage = presentation?.style === "retry"
			&& presentation.retry
			&& presentation.retry.attempt >= 4
			? formatClaudeRetryStatus(presentation.retry)
			: undefined;
		return {
			phase: runtimeState.phase,
			active: runtimeState.active,
			message: renderNativeSpinnerMessage({
				state: runtimeState,
				config,
				nowMs: this.dependencies.clock.now(),
				baseMessage,
				suffix: config.showSuffix ? this.suffixStore.suffix : null,
			}),
			visualMode: "default",
			retryMessage,
			completionVerb: this.completionVerb,
			completedDurationMs: runtimeState.agentCompletedDurationMs,
			hasAttachedTodos,
			reducedMotion: config.reducedMotion,
			stalledIntensity: config.showStall ? runtimeState.stalledIntensity : 0,
		};
	}

	nativeStatusStart(token: object, presentation: NativeStatusPresentation): void {
		if (this.disposed || presentation.style === "working") return;
		if (presentation.style === "system-requesting") {
			// Pi mounts the native compaction status before session_before_compact.
			// Capture the active row here so the later lifecycle hook cannot lose it.
			if (presentation.kind === "compaction") this.captureCompactionContinuation();
			this.retryContinuation = undefined;
			this.stateMachine.hide();
		} else {
			this.captureRetryContinuation();
		}
		this.nativeStatus = { token, presentation };
		this.publish();
	}

	nativeStatusUpdate(token: object, presentation: NativeStatusPresentation): void {
		if (this.disposed || this.nativeStatus?.token !== token) return;
		this.nativeStatus.presentation = presentation;
		this.publish();
	}

	nativeStatusEnd(token: object): void {
		if (this.disposed || this.nativeStatus?.token !== token) return;
		const wasRetry = this.nativeStatus.presentation.style === "retry";
		this.nativeStatus = undefined;
		this.publish();

		if (wasRetry && this.retryContinuation) {
			const continuation = this.retryContinuation;
			queueMicrotask(() => {
				if (
					this.disposed
					|| this.retryContinuation !== continuation
					|| this.nativeStatus !== undefined
					|| this.state.phase === "running"
				) return;
				this.retryContinuation = undefined;
				this.publish();
			});
		}
	}

	agentStart(level: string | null, reasoning: boolean): void {
		if (this.disposed) return;
		const continuation = this.retryContinuation;
		this.nativeStatus = undefined;
		this.retryContinuation = undefined;
		this.compactionContinuation = undefined;
		this.stateMachine.agentStart(effortValue(level, reasoning));
		if (continuation) this.restoreRetryContinuation(continuation);
		this.publish();
	}

	agentEnd(): void {
		if (this.disposed) return;
		const wasRunning = this.state.phase === "running" || this.compactionContinuation !== undefined;
		this.compactionContinuation = undefined;
		this.stateMachine.agentEnd();
		if (wasRunning) {
			this.completionVerb = this.dependencies.random.pick(TURN_COMPLETION_VERBS);
		}
		this.eventStore.agentEnd();
		this.suffixStore.agentEnd();
		this.publish();
	}

	turnStart(): void {
		this.update(() => this.stateMachine.turnStart());
	}

	messageUpdate(event: SpinnerMessageEvent, usage?: SpinnerTokenUsage): void {
		this.update(() => this.stateMachine.messageUpdate(event, usage));
	}

	messageEnd(usage?: SpinnerTokenUsage): void {
		this.update(() => this.stateMachine.messageEnd(usage));
	}

	toolExecutionStart(toolCallId: string): void {
		this.update(() => this.stateMachine.toolExecutionStart(toolCallId));
	}

	toolExecutionEnd(toolCallId: string): void {
		this.update(() => this.stateMachine.toolExecutionEnd(toolCallId));
	}

	thinkingLevelSelect(level: string | null, reasoning: boolean): void {
		this.update(() => this.stateMachine.setEffectiveEffort(level, reasoning));
	}

	tick(): void {
		this.update(() => this.stateMachine.tick());
	}

	refresh(): void {
		if (this.disposed) return;
		this.publish();
	}

	beforeCompact(): void {
		if (this.disposed) return;
		// Pre-request compaction stays inside the same agent run. Suspend rather
		// than destroy its spinner state so session_compact can resume the row.
		this.captureCompactionContinuation();
		this.retryContinuation = undefined;
		this.stateMachine.hide();
		this.publish();
	}

	afterCompact(resume = true): boolean {
		if (this.disposed) return false;
		const continuation = this.compactionContinuation;
		this.compactionContinuation = undefined;
		if (!resume || !continuation) {
			if (!resume) {
				this.eventStore.agentEnd();
				this.suffixStore.agentEnd();
			}
			this.publish();
			return false;
		}
		this.restoreCompactionContinuation(continuation);
		this.publish();
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.nativeStatus = undefined;
		this.retryContinuation = undefined;
		this.compactionContinuation = undefined;
		this.stateMachine.hide();
		this.eventStore.dispose();
		this.suffixStore.dispose();
		this.requestRender?.();
		this.requestRender = undefined;
		this.lastRenderSignature = "";
	}

	private captureCompactionContinuation(): void {
		if (this.compactionContinuation || this.state.phase !== "running") return;
		this.compactionContinuation = {
			...this.state,
			activeToolIds: new Set(this.state.activeToolIds),
		};
	}

	private restoreCompactionContinuation(continuation: SpinnerRuntimeState): void {
		const now = this.dependencies.clock.now();
		Object.assign(this.state, continuation);
		this.state.activeToolIds = new Set(continuation.activeToolIds);
		if (this.state.lastTokenAnimationAtMs !== null) this.state.lastTokenAnimationAtMs = now;
		if (this.state.lastResponseAtMs !== null) this.state.lastResponseAtMs = now;
		this.state.stalledIntensity = 0;
	}

	private captureRetryContinuation(): void {
		if (this.retryContinuation) return;
		this.retryContinuation = {
			agentStartedAtMs: this.state.agentStartedAtMs,
			randomVerb: this.state.randomVerb,
			inputTokens: this.state.inputTokens,
			outputTokens: this.state.outputTokens,
			responseLength: this.state.responseLength,
			displayedResponseLength: this.state.displayedResponseLength,
		};
	}

	private restoreRetryContinuation(continuation: RetryContinuationState): void {
		if (continuation.agentStartedAtMs !== null) this.state.agentStartedAtMs = continuation.agentStartedAtMs;
		if (continuation.randomVerb) this.state.randomVerb = continuation.randomVerb;
		this.state.completedInputTokens = continuation.inputTokens;
		this.state.completedOutputTokens = continuation.outputTokens;
		this.state.currentInputTokens = 0;
		this.state.currentOutputTokens = 0;
		this.state.inputTokens = continuation.inputTokens;
		this.state.outputTokens = continuation.outputTokens;
		this.state.responseLength = continuation.responseLength;
		this.state.displayedResponseLength = continuation.displayedResponseLength;
		this.state.lastTokenAnimationAtMs = this.dependencies.clock.now();
	}

	private update(change: () => void): void {
		if (this.disposed) return;
		change();
		this.publish();
	}

	private publish(): void {
		const signature = renderSignature(this.getWidgetSnapshot());
		if (signature === this.lastRenderSignature) return;
		this.lastRenderSignature = signature;
		this.requestRender?.();
	}
}

export function installSpinner(
	events: ExtensionAPI["events"],
	ctx: ExtensionContext,
	getConfig: () => SpinnerConfig,
	dependencies: SpinnerDependencies = defaultDependencies,
): SpinnerInstallation | undefined {
	if (!getConfig().enabled) return undefined;

	const controller = new SpinnerController(events, getConfig, dependencies);
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWidget(
		SPINNER_WIDGET_KEY,
		(tui, theme) => createSpinnerWidget(tui, theme, controller.platform, controller),
		{ placement: "aboveEditor" },
	);
	controller.initialize();
	events.emit(SPINNER_MOUNTED_EVENT, { version: 1 });

	let disposed = false;
	return {
		controller,
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.dispose();
			ctx.ui.setWidget(SPINNER_WIDGET_KEY, undefined);
			ctx.ui.setWorkingVisible(true);
			events.emit(SPINNER_UNMOUNTED_EVENT, { version: 1 });
		},
	};
}
