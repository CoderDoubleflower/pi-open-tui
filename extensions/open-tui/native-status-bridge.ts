export interface NativeRetryStatus {
	attempt: number;
	maxRetries: number;
	seconds: number;
}

/**
 * Presentation data still consumed by the custom spinner.
 *
 * The previous native-status interception/bridge implementation was removed
 * together with the old native rendering path. This module intentionally keeps
 * only the shared data contract and Claude-style retry formatter so spinner.ts
 * does not depend on deleted runtime bridge code.
 */
export type NativeStatusPresentation =
	| {
		kind: "working";
		style: "working";
		message: string;
	}
	| {
		kind: "retry";
		style: "retry";
		retry: NativeRetryStatus | null;
	}
	| {
		kind: "retry" | "compaction" | "branchSummary";
		style: "system-requesting";
		message: "Compacting conversation…";
	};

export function formatClaudeRetryStatus(retry: NativeRetryStatus): string {
	return `Retrying in ${retry.seconds} ${retry.seconds === 1 ? "second" : "seconds"}… (attempt ${retry.attempt}/${retry.maxRetries})`;
}
