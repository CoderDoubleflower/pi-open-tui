import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SPINNER_OVERRIDE_EVENT,
	SPINNER_TASKS_EVENT,
	type SpinnerOverrideEventV1,
	type SpinnerTasksEventV1,
} from "../extensions/open-tui/spinner-events.ts";
import {
	SPINNER_SUFFIX_EVENT,
	type SpinnerSuffixEventV1,
} from "../extensions/open-tui/spinner-suffix.ts";

const SOURCE = "spinner-provider-example";

export default function spinnerProviderExample(pi: ExtensionAPI): void {
	let revision = 0;
	let delayNextProviderRequestMs = 0;

	const emitOverride = (message: string | null, scope: "agent" | "session" = "agent") => {
		const event: SpinnerOverrideEventV1 = { version: 1, source: SOURCE, message, scope };
		pi.events.emit(SPINNER_OVERRIDE_EVENT, event);
	};

	const emitTask = (completed: boolean) => {
		const event: SpinnerTasksEventV1 = {
			version: 1,
			source: SOURCE,
			revision: ++revision,
			tasks: [{
				id: "example-task",
				subject: "Validate spinner provider",
				activeForm: "Validating spinner provider",
				status: completed ? "completed" : "in_progress",
			}],
		};
		pi.events.emit(SPINNER_TASKS_EVENT, event);
	};

	const clearTasks = () => {
		const event: SpinnerTasksEventV1 = {
			version: 1,
			source: SOURCE,
			revision: ++revision,
			tasks: [],
		};
		pi.events.emit(SPINNER_TASKS_EVENT, event);
	};

	const emitSuffix = (suffix: string | null, scope: "agent" | "session" = "agent") => {
		const event: SpinnerSuffixEventV1 = { version: 1, source: SOURCE, suffix, scope };
		pi.events.emit(SPINNER_SUFFIX_EVENT, event);
	};

	pi.on("before_provider_request", async () => {
		const delayMs = delayNextProviderRequestMs;
		delayNextProviderRequestMs = 0;
		if (delayMs === 0) return;
		await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
	});

	pi.registerCommand("spinner-provider", {
		description: "Publish example open-tui spinner provider events",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "reset") {
				emitOverride(null);
				emitSuffix(null);
				clearTasks();
				delayNextProviderRequestMs = 0;
				ctx.ui.notify("Spinner showcase state reset", "info");
				return;
			}
			if (input === "combo") {
				emitOverride(null);
				emitTask(false);
				emitSuffix("workspace");
				ctx.ui.notify("Next run will show task + suffix", "info");
				return;
			}
			if (input === "stall") {
				delayNextProviderRequestMs = 6_000;
				ctx.ui.notify("Next provider request will pause for 6 seconds", "info");
				return;
			}
			if (input === "suffix-clear") {
				emitSuffix(null);
				ctx.ui.notify("Spinner suffix cleared", "info");
				return;
			}
			if (input.startsWith("suffix-session ")) {
				emitSuffix(input.slice("suffix-session ".length), "session");
				return;
			}
			if (input.startsWith("suffix ")) {
				emitSuffix(input.slice("suffix ".length));
				return;
			}
			if (input === "clear") {
				emitOverride(null);
				ctx.ui.notify("Spinner override cleared", "info");
				return;
			}
			if (input === "task") {
				emitTask(false);
				ctx.ui.notify("Spinner task snapshot published", "info");
				return;
			}
			if (input === "complete") {
				emitTask(true);
				ctx.ui.notify("Spinner task completed", "info");
				return;
			}
			if (input.startsWith("session ")) {
				emitOverride(input.slice("session ".length), "session");
				return;
			}
			if (input.length > 0) {
				emitOverride(input);
				return;
			}
			ctx.ui.notify(
				"Usage: /spinner-provider <reset|combo|stall|message|session message|clear|task|complete|suffix text|suffix-session text|suffix-clear>",
				"info",
			);
		},
	});
}
