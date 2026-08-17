import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpinnerConfig } from "./config.ts";
import { resolveSpinnerMessage } from "./spinner-content.ts";
import { SpinnerEventStore } from "./spinner-events.ts";
import {
	createNativeSpinnerIndicator,
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

export class SpinnerController {
	readonly stateMachine: SpinnerStateMachine;
	private readonly ctx: ExtensionContext;
	private readonly getConfig: () => SpinnerConfig;
	private readonly dependencies: SpinnerDependencies;
	private readonly platform: SpinnerPlatform;
	private readonly eventStore: SpinnerEventStore;
	private readonly suffixStore: SpinnerSuffixStore;
	private lastMessage: string | undefined;
	private lastIndicator = "";
	private disposed = false;

	constructor(
		events: ExtensionAPI["events"],
		ctx: ExtensionContext,
		getConfig: () => SpinnerConfig,
		dependencies: SpinnerDependencies,
	) {
		this.ctx = ctx;
		this.getConfig = getConfig;
		this.dependencies = dependencies;
		this.platform = detectSpinnerPlatform(dependencies.environment);
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

	initialize(): void {
		this.publishIndicator();
	}

	agentStart(level: string | null, reasoning: boolean): void {
		if (this.disposed) return;
		this.stateMachine.agentStart(effortValue(level, reasoning));
		this.lastMessage = undefined;
		this.publish();
	}

	agentEnd(): void {
		if (this.disposed) return;
		this.stateMachine.agentEnd();
		this.eventStore.agentEnd();
		this.suffixStore.agentEnd();
		this.lastMessage = undefined;
		this.publishIndicator();
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
		this.ctx.ui.setWorkingMessage();
		this.ctx.ui.setWorkingIndicator();
		this.lastMessage = undefined;
		this.lastIndicator = "";
	}

	private update(change: () => void): void {
		if (this.disposed) return;
		change();
		this.publish();
	}

	private publish(): void {
		this.publishMessage();
		this.publishIndicator();
	}

	private publishMessage(): void {
		const config = this.getConfig();
		const content = this.eventStore.content;
		const baseMessage = resolveSpinnerMessage({
			overrideMessage: content.overrideMessage,
			currentTask: config.taskIntegration === "events" ? content.currentTask : null,
			randomVerb: this.state.randomVerb,
		});
		const message = renderNativeSpinnerMessage({
			state: this.state,
			config,
			nowMs: this.dependencies.clock.now(),
			baseMessage,
			suffix: config.showSuffix ? this.suffixStore.suffix : null,
		});
		if (message === undefined || message === this.lastMessage) return;
		this.lastMessage = message;
		this.ctx.ui.setWorkingMessage(message);
	}

	private publishIndicator(): void {
		const config = this.getConfig();
		const indicator = createNativeSpinnerIndicator(
			this.platform,
			config.reducedMotion,
			config.showStall ? this.state.stalledIntensity : 0,
			this.ctx.ui.theme,
		);
		const signature = JSON.stringify(indicator);
		if (signature === this.lastIndicator) return;
		this.lastIndicator = signature;
		this.ctx.ui.setWorkingIndicator(indicator);
	}
}

export function installSpinner(
	events: ExtensionAPI["events"],
	ctx: ExtensionContext,
	getConfig: () => SpinnerConfig,
	dependencies: SpinnerDependencies = defaultDependencies,
): SpinnerInstallation | undefined {
	if (!getConfig().enabled) return undefined;

	const controller = new SpinnerController(events, ctx, getConfig, dependencies);
	controller.initialize();

	let disposed = false;
	return {
		controller,
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.dispose();
		},
	};
}
