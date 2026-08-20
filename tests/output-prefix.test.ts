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
	constructor(private readonly lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class Markdown implements Component {
	constructor(private text: string) {}
	setText(text: string): void {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

class FakeContainer implements Component {
	constructor(public children: Component[]) {}
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
	assert.deepEqual(formatClaudeToolUse("write", { path: "src/a.ts" }, "/repo"), {
		name: "Write",
		detail: "src/a.ts",
	});
	assert.deepEqual(formatClaudeToolUse("edit", { path: "src/a.ts" }, "/repo"), {
		name: "Update",
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
		["Found 2 files"],
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
