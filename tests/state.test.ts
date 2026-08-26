import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageTotals, invalidateUsageCache } from "../extensions/open-tui/state.ts";

interface TestUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function assistantEntry(id: string, usage: TestUsage): Record<string, unknown> {
	return {
		id,
		timestamp: id,
		type: "message",
		message: { role: "assistant", usage },
	};
}

test("usage cache advances only after finalized assistant usage changes", () => {
	const entries: Array<Record<string, unknown>> = [
		assistantEntry("assistant-1", {
			input: 100,
			output: 40,
			cacheRead: 100,
			cacheWrite: 0,
			cost: { total: 0.1 },
		}),
	];
	const sessionManager = { getEntries: () => entries };
	const ctx = { sessionManager } as unknown as ExtensionContext;

	invalidateUsageCache();
	const initial = getUsageTotals(ctx);
	assert.equal(initial.latestCacheHitRate, 50);

	entries.push({
		id: "user-1",
		timestamp: "user-1",
		type: "message",
		message: { role: "user", content: "continue" },
	});
	invalidateUsageCache();
	assert.strictEqual(getUsageTotals(ctx), initial);

	entries.push({
		id: "tool-1",
		timestamp: "tool-1",
		type: "message",
		message: {
			role: "toolResult",
			usage: {
				input: 999,
				output: 999,
				cacheRead: 999,
				cacheWrite: 999,
				cost: { total: 9.99 },
			},
		},
	});
	invalidateUsageCache();
	assert.strictEqual(getUsageTotals(ctx), initial);

	entries.push(assistantEntry("assistant-2", {
		input: 50,
		output: 20,
		cacheRead: 150,
		cacheWrite: 0,
		cost: { total: 0.2 },
	}));

	// Streaming/message-update renders do not invalidate usage, so the previous
	// completed response remains visible until assistant message_end.
	assert.strictEqual(getUsageTotals(ctx), initial);

	invalidateUsageCache();
	const completed = getUsageTotals(ctx);
	assert.notStrictEqual(completed, initial);
	assert.deepEqual(completed, {
		input: 150,
		output: 60,
		cacheRead: 250,
		cacheWrite: 0,
		cost: 0.30000000000000004,
		latestCacheHitRate: 75,
	});
});
