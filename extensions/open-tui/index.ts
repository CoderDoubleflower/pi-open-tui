import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerClearCommand } from "./clear-command.ts";
import { settleCompactionFailure } from "./compaction-lifecycle.ts";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { installFullscreenJumpToBottom } from "./fullscreen-scroll.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { installClaudeStyleMarkdown } from "./markdown.ts";
import { installOutputPrefixes } from "./output-prefix.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import {
	installSpinner,
	type SpinnerDependencies,
	type SpinnerInstallation,
} from "./spinner.ts";
import { TOKEN_COUNTER_FRAME_MS } from "./spinner-state.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import { registerTodoIntegration } from "./todo.ts";
import { installCompactUserMessages } from "./user-message.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";

export const SPINNER_CONTROLLER_TICK_INTERVAL_MS = TOKEN_COUNTER_FRAME_MS;
export const WORKING_FOOTER_TICK_INTERVAL_MS = 250;

function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const args = process.argv.slice(2);
	const nonInteractiveFlags = ["-p", "--print", "--help", "-h", "--version", "-v", "--list-models", "--export"];
	for (const arg of args) {
		if (nonInteractiveFlags.includes(arg)) return false;
		if (arg.startsWith("--mode")) return false;
	}
	return true;
}

function clearVisibleScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export function registerOpenTui(pi: ExtensionAPI, spinnerDependencies?: SpinnerDependencies) {
	registerClearCommand(pi);
	registerTodoIntegration(pi);

	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let spinnerTickTimer: ReturnType<typeof setInterval> | undefined;
	let workingFooterTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupJumpToBottom: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupEditor: (() => void) | undefined;
	let cleanupUserMessages: (() => void) | undefined;
	let cleanupMarkdown: (() => void) | undefined;
	let cleanupOutputPrefixes: (() => void) | undefined;
	let spinnerInstallation: SpinnerInstallation | undefined;
	let pendingUiChange: "install" | "uninstall" | undefined;
	let pendingSpinnerSync = false;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx, config.fullscreen.wheelScrollLines);
			cleanupJumpToBottom = installFullscreenJumpToBottom(ctx);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			cleanupEditor = installEditor(
				pi,
				ctx,
				() => config.editor.dynamicBorderColor,
				() => config.editor.autocompleteDirection,
			);
			cleanupUserMessages = installCompactUserMessages();
			cleanupMarkdown = installClaudeStyleMarkdown();
			cleanupOutputPrefixes = installOutputPrefixes(() => ctx.ui.theme);
			spinnerInstallation = installSpinner(pi.events, ctx, () => config.spinner, spinnerDependencies);
			active = true;
		}
	};

	const syncSpinner = (ctx: ExtensionContext) => {
		if (!active) return;
		if (config.spinner.enabled && !spinnerInstallation) {
			spinnerInstallation = installSpinner(pi.events, ctx, () => config.spinner, spinnerDependencies);
		} else if (!config.spinner.enabled && spinnerInstallation) {
			spinnerInstallation.dispose();
			spinnerInstallation = undefined;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			spinnerInstallation?.dispose();
			cleanupHeader?.();
			cleanupJumpToBottom?.();
			cleanupFooter?.();
			cleanupEditor?.();
			cleanupUserMessages?.();
			cleanupOutputPrefixes?.();
			cleanupMarkdown?.();
			cleanupHeader = undefined;
			cleanupJumpToBottom = undefined;
			cleanupFooter = undefined;
			cleanupEditor = undefined;
			cleanupUserMessages = undefined;
			cleanupOutputPrefixes = undefined;
			cleanupMarkdown = undefined;
			spinnerInstallation = undefined;
			requestFooterRender = undefined;
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = config.footerSegments;
		const scriptEnabled = config.footerScript !== null;
		if (!scriptEnabled && !segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: scriptEnabled || segs.gitCommit,
			readCounts: scriptEnabled || segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tickSpinner = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			spinnerInstallation?.controller.tick();
		};
		const renderFooter = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tickSpinner();
		renderFooter();
		spinnerTickTimer = setInterval(tickSpinner, SPINNER_CONTROLLER_TICK_INTERVAL_MS);
		workingFooterTimer = setInterval(renderFooter, WORKING_FOOTER_TICK_INTERVAL_MS);
		spinnerTickTimer.unref?.();
		workingFooterTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (spinnerTickTimer) {
			clearInterval(spinnerTickTimer);
			spinnerTickTimer = undefined;
		}
		if (workingFooterTimer) {
			clearInterval(workingFooterTimer);
			workingFooterTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		pendingUiChange = undefined;
		pendingSpinnerSync = false;
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));

		if (isInteractiveLaunch() && config.enabled) {
			clearVisibleScreen();
		}

		applyUi(ctx);

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		pendingUiChange = undefined;
		pendingSpinnerSync = false;
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		spinnerInstallation?.controller.agentStart(
			getThinkingLevel(),
			ctx.model?.reasoning === true,
		);
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.agentEnd();
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.turnStart();
	});

	pi.on("message_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_update", (event) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.messageUpdate(
			event.assistantMessageEvent,
			event.message.role === "assistant" ? event.message.usage : undefined,
		);
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.toolExecutionStart(event.toolCallId);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode);
			if (message) ctx.ui.notify(message, "info");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		spinnerInstallation?.controller.thinkingLevelSelect(
			event.level,
			ctx.model?.reasoning === true,
		);
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		if (event.message.role === "assistant") {
			spinnerInstallation?.controller.messageEnd(event.message.usage);
		}
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.toolExecutionEnd(event.toolCallId);
		refreshInteractiveState(ctx);
	});

	pi.on("session_before_compact", () => {
		if (!sessionLifecycle.isCurrent()) return;
		spinnerInstallation?.controller.beforeCompact();
		stopWorkingTimer();
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		settleCompactionFailure(state, event.willRetry);
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const wasEnabled = config.enabled;
			const wasSpinnerEnabled = config.spinner.enabled;
			saveConfig(newConfig);
			config = newConfig;
			if (lastCtx && wasEnabled !== newConfig.enabled) {
				// Both directions defer to onOverlayClosed: while the settings overlay
				// is open, pi core's setEditorComponent() steals focus from the overlay
				// and strands it without keyboard input.
				pendingUiChange = newConfig.enabled ? "install" : "uninstall";
			}
			if (lastCtx && wasEnabled === newConfig.enabled && wasSpinnerEnabled !== newConfig.spinner.enabled) {
				pendingSpinnerSync = true;
			} else {
				spinnerInstallation?.controller.refresh();
			}
			const gitNeeded = newConfig.footerScript !== null
				|| newConfig.footerSegments.gitBranch
				|| newConfig.footerSegments.gitStatus
				|| newConfig.footerSegments.gitCommit;
			if (lastCtx && gitNeeded) {
				void scheduleGitRefresh(lastCtx);
			} else {
				state.git = emptyGitStatus();
			}
			requestFooterRender?.();
		},
		onOverlayClosed: () => {
			if (!lastCtx) return;
			if (pendingUiChange !== undefined) {
				const change = pendingUiChange;
				pendingUiChange = undefined;
				pendingSpinnerSync = false;
				if (change === "uninstall") {
					uninstallUi(lastCtx);
				} else {
					applyUi(lastCtx);
				}
				return;
			}
			if (pendingSpinnerSync) {
				pendingSpinnerSync = false;
				syncSpinner(lastCtx);
			}
		},
	});
}

export default registerOpenTui;
