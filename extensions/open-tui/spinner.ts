import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpinnerConfig } from "./config.ts";
import { resolveSpinnerMessage } from "./spinner-content.ts";
import { SpinnerEventStore } from "./spinner-events.ts";
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

export class SpinnerController implements SpinnerWidgetSource {
	readonly stateMachine: SpinnerStateMachine;
	private readonly getConfig: () => SpinnerConfig;
	private readonly dependencies: SpinnerDependencies;
	private readonly spinnerPlatform: SpinnerPlatform;
	private readonly eventStore: SpinnerEventStore;
	private readonly suffixStore: SpinnerSuffixStore;
	private requestRender: (() => void) | undefined;
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
	}

	getWidgetSnapshot(): SpinnerWidgetSnapshot {
		const config = this.getConfig();
		const content = this.eventStore.content;
		const baseMessage = resolveSpinnerMessage({
			overrideMessage: content.overrideMessage,
			currentTask: config.taskIntegration === "events" ? content.currentTask : null,
			randomVerb: this.state.randomVerb,
		});
		return {
			active: this.state.active,
			message: renderNativeSpinnerMessage({
				state: this.state,
				config,
				nowMs: this.dependencies.clock.now(),
				baseMessage,
				suffix: config.showSuffix ? this.suffixStore.suffix : null,
			}),
			reducedMotion: config.reducedMotion,
			stalledIntensity: config.showStall ? this.state.stalledIntensity : 0,
		};
	}

	agentStart(level: string | null, reasoning: boolean): void {
		if (this.disposed) return;
		this.stateMachine.agentStart(effortValue(level, reasoning));
		this.publish();
	}

	agentEnd(): void {
		if (this.disposed) return;
		this.stateMachine.agentEnd();
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
		this.agentEnd();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stateMachine.agentEnd();
		this.eventStore.dispose();
		this.suffixStore.dispose();
		this.requestRender?.();
		this.requestRender = undefined;
	}

	private update(change: () => void): void {
		if (this.disposed) return;
		change();
		this.publish();
	}

	private publish(): void {
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

	let disposed = false;
	return {
		controller,
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.dispose();
			ctx.ui.setWidget(SPINNER_WIDGET_KEY, undefined);
			ctx.ui.setWorkingVisible(true);
		},
	};
}
