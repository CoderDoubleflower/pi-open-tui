import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	EDIT_DIFF_ADDED_BACKGROUND,
	EDIT_DIFF_REMOVED_BACKGROUND,
	formatClaudeMcpToolResult,
	formatClaudeMcpToolUse,
	identifyClaudeMcpTool,
	installClaudeToolRenderer,
} from "../extensions/open-tui/claude-tool-renderer.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

const diffTheme = {
	...theme,
	fg: (name: string, text: string) => {
		const color = name === "text" ? 255 : name === "toolDiffAdded" ? 2 : name === "toolDiffRemoved" ? 1 : 8;
		return `\x1b[38;5;${color}m${text}\x1b[39m`;
	},
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

test("Bash lifecycle stays in the Claude renderer and sanitizes result payloads", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	try {
		const base = {
			toolName: "bash",
			args: { command: "echo one" },
			cwd: "/repo",
			expanded: false,
			ui: { requestRender() {} },
		};
		const states = [
			{ ...base, isPartial: true, executionStarted: false },
			{
				...base,
				isPartial: true,
				executionStarted: true,
				result: { isError: false, content: [{ type: "text", text: "\x1b[34mrunning\x1b[0m" }] },
			},
			{
				...base,
				isPartial: false,
				executionStarted: true,
				result: {
					isError: false,
					content: [{ type: "text", text: "\x1b[34m$ echo one\x1b[0m\n\x1b[2J$ echo two" }],
				},
			},
			{
				...base,
				isPartial: false,
				executionStarted: true,
				result: { isError: true, content: [{ type: "text", text: "\x1b[31mfailed\x1b[0m" }] },
			},
		];

		for (const state of states) {
			const lines = prototype.render.call(state, 80);
			const plain = lines.map(stripAnsi).join("\n");
			assert.doesNotMatch(plain, /ORIGINAL/);
			assert.equal((plain.match(/Bash\(/g) ?? []).length, 1);
			assert.match(plain, /⎿/);
			assert.doesNotMatch(lines.join("\n"), /\x1b\[(?:2J|3[14]m)/);
		}
	} finally {
		cleanup();
	}
});

test("multiline Bash headings keep a two-column continuation gutter", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	const render = (command: string, expanded: boolean, width: number) => {
		const bash = {
			toolName: "bash",
			args: { command },
			cwd: "/repo",
			expanded,
			isPartial: false,
			executionStarted: true,
			result: { isError: false, content: [{ type: "text", text: "Success" }] },
			ui: { requestRender() {} },
		};
		return prototype.render.call(bash, width);
	};

	try {
		const heredoc = [
			"apply_patch <<'PATCH'",
			"*** Begin Patch",
			"*** Update File: src/example.ts",
			"PATCH",
		].join("\n");
		const collapsed = render(heredoc, false, 80).map((line) => stripAnsi(line).trimEnd());
		const collapsedResultIndex = collapsed.findIndex((line) => line.includes("⎿"));
		assert.equal(collapsed[1], "● Bash(apply_patch <<'PATCH'");
		assert.equal(collapsed[2], "  *** Begin Patch…)");
		assert.equal(collapsedResultIndex, 3);

		const expanded = render(heredoc, true, 80).map((line) => stripAnsi(line).trimEnd());
		const expandedResultIndex = expanded.findIndex((line) => line.includes("⎿"));
		const expandedHeading = expanded.slice(1, expandedResultIndex);
		assert.equal(expandedHeading[0], "● Bash(apply_patch <<'PATCH'");
		assert.deepEqual(expandedHeading.slice(1), [
			"  *** Begin Patch",
			"  *** Update File: src/example.ts",
			"  PATCH)",
		]);

		const width = 24;
		const narrow = render(`printf '%s' ${"value".repeat(40)}`, false, width);
		const narrowPlain = narrow.map((line) => stripAnsi(line).trimEnd());
		const narrowResultIndex = narrowPlain.findIndex((line) => line.includes("⎿"));
		const narrowHeading = narrowPlain.slice(1, narrowResultIndex);
		assert.equal((narrowHeading.join("\n").match(/Bash\(/g) ?? []).length, 1);
		assert.ok(narrowHeading.length > 1);
		assert.ok(narrowHeading.slice(1).every((line) => line.startsWith("  ")));
		assert.ok(narrow.every((line) => visibleWidth(line) <= width));
		assert.ok(narrowHeading.at(-1)?.endsWith("…)") ?? false);
	} finally {
		cleanup();
	}
});

test("successful edit diffs paint added and removed rows to the available width", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => diffTheme, { prototype });
	try {
		const edit = {
			toolName: "edit",
			args: { path: "/repo/src/a.ts" },
			cwd: "/repo",
			expanded: false,
			isPartial: false,
			executionStarted: true,
			result: {
				isError: false,
				content: [{ type: "text", text: "Successfully replaced 1 block" }],
				details: {
					diff: " 1 unchanged\n-2 old value\n+2 new value\n 3 unchanged",
				},
			},
			ui: { requestRender() {} },
		};
		const width = 48;
		const lines = prototype.render.call(edit, width);
		const removed = lines.find((line) => stripAnsi(line).includes("-2 old value"));
		const added = lines.find((line) => stripAnsi(line).includes("+2 new value"));
		const context = lines.find((line) => stripAnsi(line).includes(" 1 unchanged"));

		assert.ok(removed);
		assert.ok(added);
		assert.ok(context);
		assert.ok(removed.startsWith(`     ${EDIT_DIFF_REMOVED_BACKGROUND}`));
		assert.ok(added.startsWith(`     ${EDIT_DIFF_ADDED_BACKGROUND}`));
		assert.match(removed, /\x1b\[38;5;255m-2 old value\x1b\[39m/);
		assert.match(added, /\x1b\[38;5;255m\+2 new value\x1b\[39m/);
		assert.doesNotMatch(removed, /\x1b\[38;5;1m/);
		assert.doesNotMatch(added, /\x1b\[38;5;2m/);
		assert.equal(stripAnsi(removed).length, width);
		assert.equal(stripAnsi(added).length, width);
		assert.doesNotMatch(context, /\x1b\[48;5;(?:22|52)m/);
	} finally {
		cleanup();
	}
});

test("MCP gateway calls use Claude Code's server - tool title and compact arguments", () => {
	const identity = identifyClaudeMcpTool(
		"mcp",
		{ label: "MCP" },
		{ server: "github", tool: "create_issue", args: { title: "Bug", labels: ["ui"] } },
	);
	assert.deepEqual(identity, {
		kind: "gateway",
		serverName: "github",
		remoteToolName: "create_issue",
	});
	assert.deepEqual(
		formatClaudeMcpToolUse(identity!, {
			server: "github",
			tool: "create_issue",
			args: { title: "Bug", labels: ["ui"] },
		}),
		{
			name: "github - create_issue (MCP)",
			detail: 'title: "Bug", labels: ["ui"]',
		},
	);
});

test("MCP namespace and direct tools are detected without importing the adapter", () => {
	assert.deepEqual(
		identifyClaudeMcpTool(
			"mcp__my_20_server",
			{ label: "MCP: my server" },
			{ tool: "search" },
		),
		{ kind: "namespace", serverName: "my server", remoteToolName: "search" },
	);
	assert.deepEqual(
		identifyClaudeMcpTool(
			"github_create_issue",
			{ label: "MCP: create_issue" },
			{ title: "Bug" },
		),
		{ kind: "direct", serverName: "github", remoteToolName: "create_issue" },
	);
	assert.deepEqual(
		identifyClaudeMcpTool(
			"create_issue",
			{ label: "MCP: create_issue" },
			{ title: "Bug" },
		),
		{ kind: "direct", serverName: undefined, remoteToolName: "create_issue" },
	);
	assert.deepEqual(
		identifyClaudeMcpTool(
			"mcp___5f00__53d1__4e2d__repo_search",
			{ label: "MCP: repo.search" },
			{ query: "renderer" },
		),
		{ kind: "direct", serverName: "开发中", remoteToolName: "repo.search" },
	);
});

test("MCP Script uses the same Claude framing while retaining its own title", () => {
	const identity = identifyClaudeMcpTool(
		"mcpScript",
		{ label: "MCP Script" },
		{ code: "return await mcp.call('github', 'search', {})" },
	);
	assert.deepEqual(identity, { kind: "script" });
	assert.equal(
		formatClaudeMcpToolUse(identity!, { code: "return 1" }).name,
		"MCP Script",
	);
});

test("MCP arguments and results follow Claude's collapsed/expanded behavior", () => {
	const identity = { kind: "direct", remoteToolName: "publish" } as const;
	const collapsedUse = formatClaudeMcpToolUse(identity, { body: "x".repeat(120) });
	assert.ok(collapsedUse.detail.endsWith("…"));
	assert.ok(
		collapsedUse.detail.length
			< formatClaudeMcpToolUse(identity, { body: "x".repeat(120) }, true).detail.length,
	);

	const result = {
		isError: false,
		content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }],
	};
	assert.deepEqual(formatClaudeMcpToolResult(result, "success"), [
		"one",
		"two",
		"three",
		"… +2 lines (ctrl+o to expand)",
	]);
	assert.deepEqual(formatClaudeMcpToolResult(result, "success", true), [
		"one",
		"two",
		"three",
		"four",
		"five",
	]);
	assert.deepEqual(
		formatClaudeMcpToolResult({ isError: false, content: [{ type: "image", data: "abc" }] }, "success"),
		["[Image]"],
	);
	assert.deepEqual(formatClaudeMcpToolResult({ isError: false, content: [] }, "success"), ["(No content)"]);
});

test("prototype renderer intercepts adapter direct tools by label and preserves fallback", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	try {
		const mcpDirect = {
			toolName: "github_create_issue",
			toolDefinition: { label: "MCP: create_issue" },
			args: { title: "Bug" },
			cwd: "/repo",
			expanded: false,
			isPartial: false,
			executionStarted: true,
			result: {
				isError: false,
				content: [{ type: "text", text: '{"number":12,"state":"open"}' }],
			},
			ui: { requestRender() {} },
		};
		const lines = prototype.render.call(mcpDirect, 120).map(stripAnsi);
		assert.equal(lines[0], "");
		assert.ok(lines[1]?.includes('● github - create_issue (MCP)(title: "Bug")'));
		assert.ok(lines[2]?.includes("⎿  number: 12"));

		const unrelated = {
			...mcpDirect,
			toolName: "third_party_tool",
			toolDefinition: { label: "Third party" },
		};
		assert.deepEqual(prototype.render.call(unrelated, 120), ["ORIGINAL"]);
	} finally {
		cleanup();
	}
});
