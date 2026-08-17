import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerClearCommand } from "../extensions/open-tui/clear-command.ts";

test("registers /clear as an alias for starting a new session", async () => {
	let commandName: string | undefined;
	let description: string | undefined;
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;

	const pi = {
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			commandName = name;
			description = options.description;
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerClearCommand(pi);

	assert.equal(commandName, "clear");
	assert.equal(description, "Start a new session (same as /new)");
	assert.ok(handler);

	const calls: unknown[] = [];
	const ctx = {
		async newSession(options?: unknown) {
			calls.push(options);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	await handler("", ctx);
	assert.deepEqual(calls, [undefined]);
});
