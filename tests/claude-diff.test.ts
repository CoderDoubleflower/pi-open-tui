import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	buildClaudeDiffPreview,
	parseApplyPatchPreview,
	parseClaudeDiff,
	renderClaudeDiffPreviewSync,
} from "../extensions/open-tui/claude-diff.ts";
import { DEFAULT_TOOL_RENDERING_CONFIG } from "../extensions/open-tui/config.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

test("apply_patch preview preserves file operations and paths", () => {
	const files = parseApplyPatchPreview([
		"*** Begin Patch",
		"*** Update File: src/a.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
		"*** Add File: src/b.ts",
		"+hello",
		"*** End Patch",
	].join("\n"));

	assert.deepEqual(files.map(({ operation, path }) => ({ operation, path })), [
		{ operation: "update", path: "src/a.ts" },
		{ operation: "add", path: "src/b.ts" },
	]);
});

test("rich diff parser reports hunks and line counts", () => {
	const document = parseClaudeDiff("@@ -1,2 +1,2 @@\n-old\n+new\n same");
	assert.equal(document.additions, 1);
	assert.equal(document.removals, 1);
	assert.equal(document.hunks, 1);

	const lines = renderClaudeDiffPreviewSync({
		key: "test",
		files: [{ path: "src/a.ts", operation: "update", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n same" }],
	}, {
		width: 60,
		expanded: false,
		theme,
		config: DEFAULT_TOOL_RENDERING_CONFIG,
	}).map(stripAnsi);

	assert.ok(lines.some((line) => line.includes("+1") && line.includes("-1")));
	assert.ok(lines.some((line) => line.includes("-old")));
	assert.ok(lines.some((line) => line.includes("+new")));
});

test("edit and write previews are available during the call phase", () => {
	const edit = buildClaudeDiffPreview(
		"edit",
		{ path: "src/a.ts", old_string: "old", new_string: "new" },
		undefined,
		"/repo",
		true,
	);
	const write = buildClaudeDiffPreview(
		"write",
		{ path: "src/new.ts", content: "one\ntwo" },
		undefined,
		"/repo",
		true,
	);

	assert.match(edit?.files[0]?.diff ?? "", /-old/);
	assert.equal(write?.files[0]?.operation, "add");
});

test("collapsed diff output respects the configured line cap", () => {
	const diff = ["@@ -1,6 +1,6 @@", "-one", "+ONE", " two", " three", " four", " five"].join("\n");
	const lines = renderClaudeDiffPreviewSync({ key: "cap", files: [{ path: "a.ts", diff }] }, {
		width: 60,
		expanded: false,
		theme,
		config: { ...DEFAULT_TOOL_RENDERING_CONFIG, diffCollapsedLines: 4 },
	}).map(stripAnsi);
	assert.ok(lines.some((line) => line.includes("+3 diff lines")));
});
