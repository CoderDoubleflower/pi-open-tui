import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	sanitizeSpinnerMessage,
	selectCurrentSpinnerTask,
	type SpinnerContentState,
	type SpinnerTask,
	type SpinnerTaskStatus,
} from "./spinner-content.ts";

export const SPINNER_OVERRIDE_EVENT = "open-tui:spinner:override:v1";
export const SPINNER_TASKS_EVENT = "open-tui:spinner:tasks:v1";

export type SpinnerEventScope = "agent" | "session";

export interface SpinnerOverrideEventV1 {
	version: 1;
	source: string;
	message: string | null;
	scope?: SpinnerEventScope;
}

export interface SpinnerTaskV1 {
	id: string | number;
	subject: string;
	activeForm?: string;
	status: SpinnerTaskStatus;
}

export interface SpinnerTasksEventV1 {
	version: 1;
	source: string;
	revision: number;
	tasks: SpinnerTaskV1[];
}

interface OverrideEntry {
	message: string;
	scope: SpinnerEventScope;
	sequence: number;
}

interface TaskEntry {
	revision: number;
	tasks: SpinnerTask[];
	sequence: number;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SOURCE_CODE_POINTS = 128;

export function parseSpinnerEventSource(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const source = value.trim();
	if (
		source.length === 0
		|| CONTROL_CHARACTER.test(source)
		|| Array.from(source).length > MAX_SOURCE_CODE_POINTS
	) return null;
	return source;
}

export function parseSpinnerEventScope(value: unknown): SpinnerEventScope | null {
	if (value === undefined || value === "agent") return "agent";
	return value === "session" ? "session" : null;
}

function parseTaskId(value: unknown): string | number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	return parseSpinnerEventSource(value);
}

function parseTask(value: unknown): SpinnerTask | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const id = parseTaskId(input.id);
	const subject = sanitizeSpinnerMessage(input.subject);
	const status = input.status;
	if (
		id === null
		|| subject === null
		|| (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "deleted")
	) return null;

	let activeForm: string | undefined;
	if (input.activeForm !== undefined) {
		activeForm = sanitizeSpinnerMessage(input.activeForm) ?? undefined;
		if (activeForm === undefined) return null;
	}
	return { id, subject, activeForm, status };
}

function newestValue<T extends { sequence: number }>(values: Iterable<T>): T | undefined {
	let newest: T | undefined;
	for (const value of values) {
		if (!newest || value.sequence > newest.sequence) newest = value;
	}
	return newest;
}

export class SpinnerEventStore {
	private readonly overrides = new Map<string, OverrideEntry>();
	private readonly taskSnapshots = new Map<string, TaskEntry>();
	private readonly unsubscribers: Array<() => void>;
	private readonly onChange: () => void;
	private sequence = 0;
	private disposed = false;

	constructor(events: ExtensionAPI["events"], onChange: () => void = () => {}) {
		this.onChange = onChange;
		this.unsubscribers = [
			events.on(SPINNER_OVERRIDE_EVENT, (data) => this.handleOverride(data)),
			events.on(SPINNER_TASKS_EVENT, (data) => this.handleTasks(data)),
		];
	}

	get content(): SpinnerContentState {
		const override = newestValue(this.overrides.values());
		const tasks = newestValue(this.taskSnapshots.values());
		return {
			overrideMessage: override?.message ?? null,
			currentTask: tasks ? selectCurrentSpinnerTask(tasks.tasks) : null,
		};
	}

	agentEnd(): void {
		let changed = false;
		for (const [source, entry] of this.overrides) {
			if (entry.scope !== "agent") continue;
			this.overrides.delete(source);
			changed = true;
		}
		if (changed) this.onChange();
	}

	resetSession(): void {
		const changed = this.overrides.size > 0 || this.taskSnapshots.size > 0;
		this.overrides.clear();
		this.taskSnapshots.clear();
		this.sequence = 0;
		if (changed) this.onChange();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.overrides.clear();
		this.taskSnapshots.clear();
	}

	private handleOverride(data: unknown): void {
		if (this.disposed || !data || typeof data !== "object" || Array.isArray(data)) return;
		const event = data as Record<string, unknown>;
		if (event.version !== 1) return;
		const source = parseSpinnerEventSource(event.source);
		const scope = parseSpinnerEventScope(event.scope);
		if (source === null || scope === null) return;

		if (event.message === null) {
			if (this.overrides.delete(source)) this.onChange();
			return;
		}
		const message = sanitizeSpinnerMessage(event.message);
		if (message === null) return;
		this.overrides.set(source, { message, scope, sequence: ++this.sequence });
		this.onChange();
	}

	private handleTasks(data: unknown): void {
		if (this.disposed || !data || typeof data !== "object" || Array.isArray(data)) return;
		const event = data as Record<string, unknown>;
		if (event.version !== 1 || !Number.isSafeInteger(event.revision) || (event.revision as number) < 0) return;
		const source = parseSpinnerEventSource(event.source);
		if (source === null || !Array.isArray(event.tasks)) return;
		const previous = this.taskSnapshots.get(source);
		const revision = event.revision as number;
		if (previous && revision <= previous.revision) return;
		const tasks = event.tasks.map(parseTask);
		if (tasks.some((task) => task === null)) return;
		this.taskSnapshots.set(source, {
			revision,
			tasks: tasks as SpinnerTask[],
			sequence: ++this.sequence,
		});
		this.onChange();
	}
}
