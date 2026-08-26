import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GitStatus } from "./git.ts";
import { emptyGitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import { fmtTokens, formatProviderLabel } from "./utils.ts";

export interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	sessionStartEpoch: number;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

interface UsageCacheEntry {
	sessionManager: ExtensionContext["sessionManager"];
	assistantUsageKey: string;
	totals: UsageTotals;
}

let usageCache: UsageCacheEntry | undefined;
let usageCacheDirty = true;

/**
 * Build a cache key from finalized assistant usage only.
 *
 * Pi emits lifecycle updates for user, tool-result, and custom messages as well,
 * but those entries must not advance the displayed cache-hit snapshot. Usage is
 * therefore refreshed only when a completed assistant response adds or changes
 * provider-reported usage.
 */
function assistantUsageKey(ctx: ExtensionContext): string {
	const parts: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		parts.push(JSON.stringify([
			entry.id ?? null,
			entry.timestamp ?? null,
			usage?.input ?? null,
			usage?.output ?? null,
			usage?.cacheRead ?? null,
			usage?.cacheWrite ?? null,
			usage?.cost?.total ?? null,
		]));
	}
	return parts.join("|");
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const sessionManager = ctx.sessionManager;
	if (usageCache && usageCache.sessionManager === sessionManager && !usageCacheDirty) {
		return usageCache.totals;
	}

	const key = assistantUsageKey(ctx);
	usageCacheDirty = false;
	if (
		usageCache
		&& usageCache.sessionManager === sessionManager
		&& usageCache.assistantUsageKey === key
	) {
		return usageCache.totals;
	}

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const m = entry.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			totals.input += u.input ?? 0;
			totals.output += u.output ?? 0;
			totals.cacheRead += u.cacheRead ?? 0;
			totals.cacheWrite += u.cacheWrite ?? 0;
			totals.cost += u.cost?.total ?? 0;
			const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			if (promptTokens > 0) {
				totals.latestCacheHitRate = ((u.cacheRead ?? 0) / promptTokens) * 100;
			}
		}
	}
	usageCache = { sessionManager, assistantUsageKey: key, totals };
	return totals;
}

/**
 * Mark usage for revalidation on the next footer render.
 *
 * Revalidation keeps the existing snapshot when only non-assistant entries were
 * appended, matching Pi's behavior of updating cache-hit data after a complete
 * assistant response rather than after every message lifecycle event.
 */
export function invalidateUsageCache(): void {
	usageCacheDirty = true;
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		runtime: null,
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
