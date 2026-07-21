import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { readGitStatus } from "./git.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";

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

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupEditor: (() => void) | undefined;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx);
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
			cleanupEditor = installEditor(pi, ctx);
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			cleanupEditor?.();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			cleanupEditor = undefined;
			requestFooterRender = undefined;
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: config.footerSegments.gitCommit,
			readTag: config.footerSegments.gitCommit,
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
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
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

		if (config.enabled && config.autoCollapseResources && isTuiContext(ctx)) {
			// ponytail: defer past showLoadedResources which runs after session_start handlers
			setTimeout(() => {
				if (!sessionLifecycle.isCurrent() || !active) return;
				ctx.ui.setToolsExpanded(false);
			}, 0);
		}

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
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
			const shouldCollapseResources = newConfig.autoCollapseResources
				&& (!config.autoCollapseResources || (!config.enabled && newConfig.enabled));
			saveConfig(newConfig);
			config = newConfig;
			if (lastCtx && wasEnabled !== newConfig.enabled) {
				if (newConfig.enabled) {
					applyUi(lastCtx);
				} else {
					uninstallUi(lastCtx);
				}
			}
			if (lastCtx && newConfig.enabled && shouldCollapseResources && isTuiContext(lastCtx)) {
				lastCtx.ui.setToolsExpanded(false);
			}
			requestFooterRender?.();
		},
	});
}
