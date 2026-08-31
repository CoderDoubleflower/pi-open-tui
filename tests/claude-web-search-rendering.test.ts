import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	formatClaudeOpenAiToolResult,
	formatClaudeOpenAiToolUse,
	summarizeClaudeWebSearchCommands,
} from "../extensions/open-tui/claude-openai-tool.ts";
import { installClaudeToolRenderer } from "../extensions/open-tui/claude-tool-renderer.ts";
import { DEFAULT_TOOL_RENDERING_CONFIG } from "../extensions/open-tui/config.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

const identity = { kind: "web-search", name: "Web Search" } as const;

test("Web Search ignores empty command arrays and summarizes the active operation", () => {
	const args = {
		search_query: [],
		image_query: [],
		open: [],
		time: [{ utc_offset: "+00:00" }],
	};
	assert.equal(summarizeClaudeWebSearchCommands(args), "Time +00:00");
	assert.deepEqual(formatClaudeOpenAiToolUse(identity, args), {
		name: "Web Search",
		detail: "Time +00:00",
	});
	assert.equal(
		summarizeClaudeWebSearchCommands({
			search_query: [{ q: "OpenAI" }, { q: "Codex" }],
		}),
		"Search OpenAI (+1)",
	);
});

test("successful Web Search output stays available to the model but is hidden from the TUI", () => {
	const result = {
		isError: false,
		content: [
			{
				type: "text",
				text: "citeturn0time0 The time in UTC+00:00 is Aug 31, 2026",
			},
		],
	};
	assert.deepEqual(
		formatClaudeOpenAiToolResult(
			identity,
			{},
			result,
			"success",
			false,
			DEFAULT_TOOL_RENDERING_CONFIG,
		),
		[],
	);
	assert.deepEqual(
		formatClaudeOpenAiToolResult(
			identity,
			{},
			result,
			"running",
			false,
			DEFAULT_TOOL_RENDERING_CONFIG,
		),
		[],
	);
	assert.deepEqual(
		formatClaudeOpenAiToolResult(
			identity,
			{},
			{ isError: true, content: [{ type: "text", text: "provider failed\nstack" }] },
			"error",
			false,
			DEFAULT_TOOL_RENDERING_CONFIG,
		),
		["provider failed"],
	);
});

test("prototype renderer never prints empty arrays or internal citation markers", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	try {
		const webSearch = {
			toolName: "web_search",
			toolDefinition: { label: "Web Search" },
			args: {
				search_query: [],
				image_query: [],
				open: [],
				time: [{ utc_offset: "+00:00" }],
			},
			cwd: "/repo",
			expanded: false,
			isPartial: false,
			executionStarted: true,
			result: {
				isError: false,
				content: [{ type: "text", text: "citeturn0time0 raw result" }],
			},
			ui: { requestRender() {} },
		};
		const plain = prototype.render.call(webSearch, 100).map(stripAnsi).join("\n");
		assert.doesNotMatch(plain, /ORIGINAL/);
		assert.match(plain, /Web Search\(Time \+00:00\)/);
		assert.doesNotMatch(plain, /\[\]|turn0time0|cite/);
	} finally {
		cleanup();
	}
});
