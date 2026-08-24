export interface CompactionWorkingState {
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

/**
 * Settle the visible working duration after a terminal compaction failure.
 * Overflow recovery keeps the state intact until the retrying agent starts.
 */
export function settleCompactionFailure(
	state: CompactionWorkingState,
	willRetry: boolean,
	nowMs = Date.now(),
): boolean {
	if (willRetry || state.workingSince === undefined) return false;
	state.lastDoneIn = Math.max(0, nowMs - state.workingSince);
	state.workingSince = undefined;
	return true;
}
