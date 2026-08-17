import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseSpinnerEventScope,
	parseSpinnerEventSource,
	type SpinnerEventScope,
} from "./spinner-events.ts";

export const SPINNER_SUFFIX_EVENT = "open-tui:spinner:suffix:v1";
export const MAX_SPINNER_SUFFIX_CODE_POINTS = 64;

export interface SpinnerSuffixEventV1 {
	version: 1;
	source: string;
	suffix: string | null;
	scope?: SpinnerEventScope;
}

interface SuffixEntry {
	suffix: string;
	scope: SpinnerEventScope;
	sequence: number;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export function sanitizeSpinnerSuffix(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const suffix = value.trim();
	if (
		suffix.length === 0
		|| CONTROL_CHARACTER.test(suffix)
		|| Array.from(suffix).length > MAX_SPINNER_SUFFIX_CODE_POINTS
	) return null;
	return suffix;
}

export class SpinnerSuffixStore {
	private readonly entries = new Map<string, SuffixEntry>();
	private readonly unsubscribe: () => void;
	private readonly onChange: () => void;
	private sequence = 0;
	private disposed = false;

	constructor(events: ExtensionAPI["events"], onChange: () => void = () => {}) {
		this.onChange = onChange;
		this.unsubscribe = events.on(SPINNER_SUFFIX_EVENT, (data) => this.handle(data));
	}

	get suffix(): string | null {
		let newest: SuffixEntry | undefined;
		for (const entry of this.entries.values()) {
			if (!newest || entry.sequence > newest.sequence) newest = entry;
		}
		return newest?.suffix ?? null;
	}

	agentEnd(): void {
		let changed = false;
		for (const [source, entry] of this.entries) {
			if (entry.scope !== "agent") continue;
			this.entries.delete(source);
			changed = true;
		}
		if (changed) this.onChange();
	}

	resetSession(): void {
		const changed = this.entries.size > 0;
		this.entries.clear();
		this.sequence = 0;
		if (changed) this.onChange();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.entries.clear();
	}

	private handle(data: unknown): void {
		if (this.disposed || !data || typeof data !== "object" || Array.isArray(data)) return;
		const event = data as Record<string, unknown>;
		if (event.version !== 1) return;
		const source = parseSpinnerEventSource(event.source);
		const scope = parseSpinnerEventScope(event.scope);
		if (source === null || scope === null) return;

		if (event.suffix === null) {
			if (this.entries.delete(source)) this.onChange();
			return;
		}
		const suffix = sanitizeSpinnerSuffix(event.suffix);
		if (suffix === null) return;
		this.entries.set(source, { suffix, scope, sequence: ++this.sequence });
		this.onChange();
	}
}
