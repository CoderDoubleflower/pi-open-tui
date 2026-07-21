import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import type { IconGlyphs } from "./icons.ts";
import { resolveGlyphs, resolveIconMode, runtimeSymbol } from "./icons.ts";
import type { GitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import {
	alignRight,
	cacheHitColor,
	effortColor,
	fmtTokens,
	formatCwd,
	formatDuration,
	formatProviderLabel,
	providerColor,
	sanitizeStatus,
	stressColor,
} from "./utils.ts";
import type { FooterState, ModelMeta, UsageTotals } from "./state.ts";
import { getUsageTotals } from "./state.ts";

function renderBar(theme: Theme, pct: number, barWidth: number, ascii: boolean): string {
	const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const empty = barWidth - filled;
	const color = stressColor(pct);
	const filledCell = ascii ? "#" : "█";
	const emptyCell = ascii ? "-" : "░";
	return (
		theme.fg("dim", "[") +
		theme.fg(color, filledCell.repeat(filled)) +
		theme.fg("dim", emptyCell.repeat(empty)) +
		theme.fg("dim", "]")
	);
}

function renderGitSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
): string {
	const parts: string[] = [];
	if (segments.gitBranch) {
		if (git.branch) {
			parts.push(theme.fg("mdLink", glyphs.git));
			parts.push(theme.fg("success", git.branch));
		} else if (git.commit?.detached) {
			parts.push(theme.fg("mdLink", glyphs.git));
			parts.push(theme.fg("success", "HEAD"));
			if (segments.gitCommit && git.commit.oid) {
				const shortHash = git.commit.oid.slice(0, 7);
				const tag = git.commit.tag ? ` ${git.commit.tag}` : "";
				parts.push(theme.fg("success", `(${shortHash}${tag})`));
			}
		}
	}

	if (segments.gitStatus) {
		const statusIcons: string[] = [];
		const addStatus = (count: number, glyph: string, color: ThemeColor) => {
			if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count > 1 ? count : ""}`));
		};
		addStatus(git.conflicted, glyphs.conflicted, "error");
		addStatus(git.stashed, glyphs.stashed, "muted");
		addStatus(git.deleted, glyphs.deleted, "error");
		addStatus(git.renamed, glyphs.renamed, "warning");
		addStatus(git.modified, glyphs.modified, "warning");
		addStatus(git.staged, glyphs.staged, "success");
		addStatus(git.untracked, glyphs.untracked, "muted");

		if (git.ahead > 0 && git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
		} else if (git.ahead > 0) {
			statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
		} else if (git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
		}

		const statusBlock = statusIcons.join(" ");
		if (statusBlock) {
			parts.push(`${theme.fg("dim", "[")}${statusBlock}${theme.fg("dim", "]")}`);
		}
	}

	return parts.join(" ");
}

function renderRuntimeSegment(
	theme: Theme,
	runtime: RuntimeInfo | null,
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	if (!runtime) return "";
	const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
	const version = runtime.version ? theme.fg("muted", runtime.version) : "";
	const label = [symbol, version].filter(Boolean).join(" ");
	return label;
}

function renderTimerSegment(theme: Theme, state: FooterState, glyphs: IconGlyphs): string {
	if (state.workingSince !== undefined) {
		return `${theme.fg("accent", glyphs.working)} ${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - state.workingSince))}`;
	}
	if (state.lastDoneIn !== undefined) {
		return `${theme.fg("success", glyphs.done)} ${theme.fg("success", "done")} ${theme.fg("text", formatDuration(state.lastDoneIn))}`;
	}
	return "";
}

function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	width: number,
	glyphs: IconGlyphs,
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextTokens = contextUsage?.tokens ?? 0;
	const contextPct = contextUsage?.percent ?? 0;

	// ponytail: render 0% bar once we know the window — keeps the right side
	// populated instead of collapsing everything left in an empty session.
	if (contextWindow <= 0) return "";

	const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
	const ctxText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
	const contextIcon = theme.fg(stressColor(contextPct), glyphs.context);
	const reserved = visibleWidth(contextIcon) + visibleWidth(pctText) + visibleWidth(ctxText) + 5 + 2;
	const barWidth = Math.max(6, Math.min(16, width - reserved));
	return `${contextIcon} ${renderBar(theme, contextPct, barWidth, resolveIconMode(iconMode) === "ascii")} ${pctText} ${theme.fg("dim", "·")} ${ctxText}`;
}

function renderStatsBlock(
	theme: Theme,
	totals: UsageTotals,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
): string {
	const stats: string[] = [];
	if (segments.tokens) {
		stats.push(theme.fg("accent", `${glyphs.input} ${fmtTokens(totals.input)}`));
		stats.push(theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`));
		// ponytail: hide cache-hit rate when the provider never reported cache
		// tokens — avoids a misleading "0%" on providers without prompt caching.
		const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
		if (hasCacheTokens && totals.latestCacheHitRate !== undefined) {
			stats.push(theme.fg(cacheHitColor(totals.latestCacheHitRate), `${glyphs.cacheHit} ${totals.latestCacheHitRate.toFixed(1)}%`));
		}
	}
	if (segments.cost) {
		stats.push(theme.fg("warning", `${glyphs.cost} $${totals.cost.toFixed(3)}`));
	}

	return stats.join(` ${theme.fg("dim", "|")} `);
}

function renderExtensionStatusLines(
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	glyphs: IconGlyphs,
	width: number,
): string[] {
	const statuses = Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return [];

	const separator = ` ${theme.fg("dim", "|")} `;
	const statusText = statuses.map((status) => theme.fg("muted", status)).join(separator);
	const line = `${theme.fg("mdLink", glyphs.extensions)} ${statusText}`;
	return wrapTextWithAnsi(line, width);
}

export interface FooterHooks {
	setRequestRender: (fn: (() => void) | undefined) => void;
	scheduleGitRefresh: () => void;
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: FooterHooks,
): () => void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		const unsubBranch = footerData.onBranchChange(() => {
			hooks.scheduleGitRefresh();
			tui.requestRender();
		});

		return {
			dispose() {
				unsubBranch();
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const segments = config.footerSegments;
				const meta = getModelMeta();

				const totals = getUsageTotals(ctx);

				const leftParts: string[] = [];
				if (segments.cwd) {
					leftParts.push(`${theme.fg("mdLink", glyphs.cwd)} ${theme.fg("accent", formatCwd(ctx.sessionManager.getCwd()))}`);
				}
				const gitSeg = renderGitSegment(theme, state.git, glyphs, segments);
				if (gitSeg) leftParts.push(gitSeg);
				if (segments.runtime) {
					const runtimeSeg = renderRuntimeSegment(theme, state.runtime, config.icons.mode);
					if (runtimeSeg) leftParts.push(runtimeSeg);
				}
				const timerSeg = renderTimerSegment(theme, state, glyphs);
				if (timerSeg) leftParts.push(timerSeg);

				let rightBlock = "";
				if (segments.context) {
					rightBlock = renderContextBar(theme, ctx, width, glyphs, config.icons.mode);
				}

				const line1 = alignRight(leftParts.join(" "), rightBlock, width, theme);

				const modelParts: string[] = [];
				modelParts.push(theme.fg("mdLink", glyphs.model));
				if (meta.provider && meta.provider !== "Unknown") {
					modelParts.push(theme.fg(providerColor(ctx.model?.provider ?? "none"), meta.provider));
				}
				modelParts.push(theme.fg("text", meta.model));
				if (meta.effort && meta.effort !== "off") {
					modelParts.push(theme.fg(effortColor(meta.effort), `${glyphs.thinking} ${meta.effort}`));
				}
				const modelBlock = modelParts.join(theme.fg("dim", " · "));

				const statsBlock = renderStatsBlock(
					theme,
					totals,
					glyphs,
					segments,
				);

				const line2 = alignRight(modelBlock, statsBlock, width, theme);

				const mainLines = [line1, line2]
					.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				return [
					...mainLines,
					...renderExtensionStatusLines(
						theme,
						footerData.getExtensionStatuses(),
						glyphs,
						width,
					),
				];
			},
		};
	});

	return () => {
		ctx.ui.setFooter(undefined);
	};
}
