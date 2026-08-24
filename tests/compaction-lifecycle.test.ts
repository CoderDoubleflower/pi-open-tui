import assert from "node:assert/strict";
import test from "node:test";
import { settleCompactionFailure } from "../extensions/open-tui/compaction-lifecycle.ts";

test("terminal compaction failure settles an active working duration", () => {
	const state = { workingSince: 1_000, lastDoneIn: undefined as number | undefined };
	assert.equal(settleCompactionFailure(state, false, 4_500), true);
	assert.equal(state.workingSince, undefined);
	assert.equal(state.lastDoneIn, 3_500);
});

test("overflow recovery preserves working state for the retry", () => {
	const state = { workingSince: 1_000, lastDoneIn: undefined as number | undefined };
	assert.equal(settleCompactionFailure(state, true, 4_500), false);
	assert.equal(state.workingSince, 1_000);
	assert.equal(state.lastDoneIn, undefined);
});

test("idle compaction failure does not synthesize a completion duration", () => {
	const state = { workingSince: undefined, lastDoneIn: 800 };
	assert.equal(settleCompactionFailure(state, false, 4_500), false);
	assert.equal(state.workingSince, undefined);
	assert.equal(state.lastDoneIn, 800);
});
