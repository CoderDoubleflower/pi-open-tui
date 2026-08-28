import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	formatClaudeToolResult,
	formatClaudeToolUse,
	installClaudeToolRenderer,
	parseClaudeToolStatus,
} from "../extensions/open-tui/claude-tool-renderer.ts";
import {
	installAssistantPrefixes,
	PrefixComponent,
} from "../extensions/open-tui/output-prefix.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

class LiteralComponent implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class Markdown implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

class FakeContainer implements Component {
	children: Component[];

	constructor(children: Component[]) {
		this.children = children;
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
	invalidate(): void {}
}

test("PrefixComponent reserves Claude's two-column assistant gutter", () => {
	const component = new PrefixComponent(new LiteralComponent(["hello", "world"]), () => "●");
	assert.deepEqual(component.render(20).map(stripAnsi), ["● hello", "  world"]);
});

test("assistant prefixing happens at render time and preserves streaming Markdown children", () => {
	const markdown = new Markdown("hello");
	const instance = {
		lastMessage: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
		},
		hideThinkingBlock: false,
		contentContainer: new FakeContainer([markdown]),
	};
	const prototype = {
		render(this: typeof instance, width: number): string[] {
			return this.contentContainer.render(width);
		},
	};
	const cleanup = installAssistantPrefixes(() => theme, prototype);
	try {
		assert.deepEqual(prototype.render.call(instance, 30).map(stripAnsi), ["● hello"]);
		assert.equal(instance.contentContainer.children[0], markdown);
		markdown.setText("streamed");
		instance.lastMessage.content[0]!.text = "streamed";
		assert.deepEqual(prototype.render.call(instance, 30).map(stripAnsi), ["● streamed"]);
		assert.equal(instance.contentContainer.children[0], markdown);
	} finally {
		cleanup();
	}
});

test("Claude tool-use labels match native Pi tools", () => {
	assert.deepEqual(formatClaudeToolUse("read", { path: "/repo/src/a.ts" }, "/repo"), {
		name: "Read",
		detail: "src/a.ts",
	});
	assert.deepEqual(
		formatClaudeToolUse("read", { path: "/repo/src/a.ts", offset: 3, limit: 2 }, "/repo", true),
		{
			name: "Read",
			detail: "src/a.ts · lines 3-4",
		},
	);
	assert.deepEqual(formatClaudeToolUse("write", { path: "src/a.ts" }, "/repo"), {
		name: "Write",
		detail: "src/a.ts",
	});
	assert.deepEqual(formatClaudeToolUse("edit", { path: "src/a.ts" }, "/repo"), {
		name: "Update",
		detail: "src/a.ts",
	});
	assert.deepEqual(formatClaudeToolUse("edit", { path: "src/a.ts", oldText: "" }, "/repo"), {
		name: "Create",
		detail: "src/a.ts",
	});
	assert.deepEqual(formatClaudeToolUse("find", { pattern: "**/*.ts", path: "src" }, "/repo"), {
		name: "Search",
		detail: 'pattern: "**/*.ts", path: "src"',
	});
	assert.deepEqual(formatClaudeToolUse("grep", { pattern: "TODO" }, "/repo"), {
		name: "Grep",
		detail: 'pattern: "TODO"',
	});
});

test("Bash call summaries preserve Claude's multiline truncation rules", () => {
	assert.equal(formatClaudeToolUse("bash", { command: "one\ntwo\nthree" }).detail, "one\ntwo…");
	assert.equal(
		formatClaudeToolUse("bash", { command: "one\ntwo\nthree" }, undefined, true).detail,
		"one\ntwo\nthree",
	);
	assert.equal(
		formatClaudeToolUse("bash", { command: "x".repeat(161) }).detail,
		`${"x".repeat(160)}…`,
	);
});

test("Claude result summaries follow Read/Write/Search semantics", () => {
	assert.deepEqual(
		formatClaudeToolResult(
			"read",
			{ path: "src/a.ts" },
			{ isError: false, content: [{ type: "text", text: "one\ntwo" }] },
			"success",
			"/repo",
		),
		["Read 2 lines"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"write",
			{ path: "src/a.ts", content: "one\ntwo" },
			{ isError: false, content: [{ type: "text", text: "ok" }] },
			"success",
			"/repo",
		),
		["Wrote 2 lines to src/a.ts", "one", "two"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"find",
			{ pattern: "**/*.ts" },
			{ isError: false, content: [{ type: "text", text: "a.ts\nb.ts" }] },
			"success",
		),
		["Found 2 files (ctrl+o to expand)"],
	);
});

test("Bash queued, progress, and final result views stay distinct", () => {
	assert.deepEqual(formatClaudeToolResult("bash", {}, undefined, "pending"), ["Waiting…"]);
	assert.deepEqual(formatClaudeToolResult("bash", {}, { content: [] }, "running"), ["Running…"]);
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: "1\n2\n3\n4\n5\n6" }] },
			"running",
		),
		["2", "3", "4", "5", "6", "+1 lines"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: "1\n2\n3\n4\n5" }] },
			"success",
		),
		["1", "2", "3", "… +2 lines (ctrl+o to expand)"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: "(no output)" }] },
			"success",
		),
		["(No output)"],
	);
});

test("Bash output strips terminal styling and controls in every result state", () => {
	const coloredCommands = "\x1b[34m$ echo one\x1b[0m\n\x1b[34m$ echo two\x1b[0m";
	const result = { content: [{ type: "text", text: coloredCommands }] };
	assert.deepEqual(formatClaudeToolResult("bash", {}, result, "running"), [
		"$ echo one",
		"$ echo two",
	]);
	assert.deepEqual(formatClaudeToolResult("bash", {}, result, "success"), [
		"$ echo one",
		"$ echo two",
	]);
	assert.deepEqual(formatClaudeToolResult("bash", {}, result, "error", undefined, true), [
		"$ echo one",
		"$ echo two",
	]);
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: "\x1b[34m(no output)\x1b[0m" }] },
			"success",
		),
		["(No output)"],
	);
});

test("Bash output removes terminal control families and normalizes redraw carriage returns", () => {
	const controlled = [
		"\x1b]0;fake-title\x07",
		"\x1b[2Jvisible\rupdated\r\nnext",
		"\x1bPignored dcs\x1b\\after-dcs",
		"\x9b31mc1-color\x9b0m\x9dignored title\x9cafter-c1",
	].join("\n");
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: controlled }] },
			"success",
			undefined,
			true,
		),
		["", "visibleupdated", "next", "after-dcs", "c1-colorafter-c1"],
	);
	assert.equal(stripAnsi("before\x1b]unterminated"), "before");
	assert.equal(stripAnsi("plain\t中文\nnext"), "plain\t中文\nnext");
	assert.equal(stripAnsi("before\x1b\nnext"), "before\nnext");
});

test("Bash collapsed output counts sanitized visible lines", () => {
	const output = Array.from(
		{ length: 5 },
		(_, index) => `\x1b[3${index}mline ${index + 1}\x1b[0m`,
	).join("\n");
	assert.deepEqual(
		formatClaudeToolResult(
			"bash",
			{},
			{ content: [{ type: "text", text: output }] },
			"success",
		),
		["line 1", "line 2", "line 3", "… +2 lines (ctrl+o to expand)"],
	);
});

test("Read and Write cover Claude's edge-case messages", () => {
	assert.deepEqual(
		formatClaudeToolResult(
			"read",
			{},
			{ content: [{ type: "text", text: "one\n" }] },
			"success",
		),
		["Read 1 line"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"read",
			{},
			{ content: [], details: { unchanged: true } },
			"success",
		),
		["Unchanged since last read"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"read",
			{},
			{ content: [{ type: "image", data: "YQ==", mimeType: "image/png" }] },
			"success",
		),
		["Read image (1B)"],
	);
	assert.deepEqual(
		formatClaudeToolResult("write", { path: "empty.txt", content: "" }, {}, "success"),
		["Wrote 0 lines to empty.txt", "(No content)"],
	);
	const content = Array.from({ length: 12 }, (_, index) => String(index + 1)).join("\n");
	const preview = formatClaudeToolResult("write", { path: "many.txt", content }, {}, "success");
	assert.equal(preview.at(-1), "… +2 lines (ctrl+o to expand)");
});

test("Edit results include changed-line counts and the actual diff", () => {
	assert.deepEqual(
		formatClaudeToolResult(
			"edit",
			{},
			{ content: [], details: { diff: "@@\n-old\n+new" } },
			"success",
		),
		["Added 1 line, removed 1 line", "@@", "-old", "+new"],
	);
});

test("Search results count matches, hide Pi notices, and expand to content", () => {
	const grepResult = {
		content: [{ type: "text", text: "a.ts:1: one\na.ts-2- context\nb.ts:3: two" }],
	};
	assert.deepEqual(formatClaudeToolResult("grep", {}, grepResult, "success"), [
		"Found 2 lines (ctrl+o to expand)",
	]);
	assert.deepEqual(
		formatClaudeToolResult("grep", {}, grepResult, "success", undefined, true),
		["Found 2 lines", "a.ts:1: one", "a.ts-2- context", "b.ts:3: two"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"find",
			{},
			{
				content: [{ type: "text", text: "a.ts\nb.ts\n\n[2 results limit reached]" }],
				details: { resultLimitReached: 2 },
			},
			"success",
		),
		["Found 2 files (ctrl+o to expand)"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"find",
			{},
			{ content: [{ type: "text", text: "No files found matching pattern" }] },
			"success",
		),
		["Found 0 files"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"ls",
			{},
			{ content: [{ type: "text", text: "(empty directory)" }] },
			"success",
		),
		["Found 0 entries"],
	);
});

test("collapsed tool errors use Claude's concise per-tool labels", () => {
	assert.deepEqual(
		formatClaudeToolResult(
			"read",
			{},
			{ content: [{ type: "text", text: "ENOENT: no such file" }] },
			"error",
		),
		["File not found"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"edit",
			{},
			{ content: [{ type: "text", text: "old text did not match" }] },
			"error",
		),
		["Error editing file"],
	);
	assert.deepEqual(
		formatClaudeToolResult(
			"grep",
			{},
			{ content: [{ type: "text", text: "bad regex" }] },
			"error",
		),
		["Error searching files"],
	);
});

test("tool status uses Claude unresolved/success/error state model", () => {
	assert.equal(parseClaudeToolStatus({ isPartial: true, executionStarted: false }), "pending");
	assert.equal(parseClaudeToolStatus({ isPartial: true, executionStarted: true }), "running");
	assert.equal(
		parseClaudeToolStatus({ isPartial: false, executionStarted: true, result: { isError: false } }),
		"success",
	);
	assert.equal(
		parseClaudeToolStatus({ isPartial: false, executionStarted: true, result: { isError: true } }),
		"error",
	);
});

test("native tools use Claude chrome while extension tools keep their renderer", () => {
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
		const nativeLines = prototype.render.call(native, 80).map(stripAnsi);
		assert.ok(nativeLines.some((line) => line.includes("● Read(src/a.ts)")));
		assert.ok(nativeLines.some((line) => line.includes("⎿  Read 2 lines")));

		const custom = { ...native, toolName: "my_extension_tool" };
		assert.deepEqual(prototype.render.call(custom, 80), ["ORIGINAL"]);
	} finally {
		cleanup();
	}
});
