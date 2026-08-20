import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	installClaudeToolRenderer,
} from "../extensions/open-tui/claude-tool-renderer.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

test("native Claude tool renderer preserves one leading spacer line", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	try {
		const native = {
			toolName: "read",
			args: { path: "/repo/src/a.ts" },
			cwd: "/repo",
			expanded: false,
			isPartial: false,
			executionStarted: true,
			result: { isError: false, content: [{ type: "text", text: "one\ntwo" }] },
			ui: { requestRender() {} },
		};
		const lines = prototype.render.call(native, 80).map(stripAnsi);
		assert.equal(lines[0], "");
		assert.ok(lines[1]?.includes("● Read(src/a.ts)"));
		assert.ok(lines[2]?.includes("⎿  Read 2 lines"));
	} finally {
		cleanup();
	}
});
