export type SpinnerTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface SpinnerTask {
	id: string | number;
	subject: string;
	activeForm?: string;
	status: SpinnerTaskStatus;
}

export interface SpinnerContentState {
	overrideMessage: string | null;
	currentTask: SpinnerTask | null;
}

export const MAX_SPINNER_MESSAGE_CODE_POINTS = 256;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const TRAILING_ELLIPSIS = /(?:(?:\.{3})|…)+$/u;

export function sanitizeSpinnerMessage(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let message = value.trim();
	if (message.length === 0 || CONTROL_CHARACTER.test(message)) return null;
	message = message.replace(TRAILING_ELLIPSIS, "").trimEnd();
	if (message.length === 0) return null;
	return Array.from(message).slice(0, MAX_SPINNER_MESSAGE_CODE_POINTS).join("");
}

export function selectCurrentSpinnerTask(tasks: readonly SpinnerTask[]): SpinnerTask | null {
	return tasks.find((task) => task.status === "in_progress") ?? null;
}

export function resolveSpinnerMessage(input: {
	overrideMessage: string | null;
	currentTask: SpinnerTask | null;
	randomVerb: string;
}): string {
	return sanitizeSpinnerMessage(input.overrideMessage)
		?? sanitizeSpinnerMessage(input.currentTask?.activeForm)
		?? sanitizeSpinnerMessage(input.currentTask?.subject)
		?? sanitizeSpinnerMessage(input.randomVerb)
		?? "Working";
}
