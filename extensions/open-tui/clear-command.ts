import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoIntegration } from "./todo.ts";

export function registerClearCommand(pi: ExtensionAPI): void {
	registerTodoIntegration(pi);

	pi.registerCommand("clear", {
		description: "Start a new session (same as /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
