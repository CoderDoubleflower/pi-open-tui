import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerClearCommand(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Start a new session (same as /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
