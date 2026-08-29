import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { installClaudeToolGrouping } from "../extensions/open-tui/claude-tool-group.ts";
import { DEFAULT_TOOL_RENDERING_CONFIG } from "../extensions/open-tui/config.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

class FakeTool {
	toolName: string;
	args = {};
	isPartial = false;
	executionStarted = true;
	result = { isError: false };
	expanded = false;

	constructor(name: string) {
		this.toolName = name;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(): string[] {
		return ["", `● ${this.toolName}`];
	}

	invalidate(): void {}
}

test("adjacent tools are grouped and disabling grouping is reversible", () => {
	const config = { ...DEFAULT_TOOL_RENDERING_CONFIG };
	const container = new Container();
	const installation = installClaudeToolGrouping(
		() => theme,
		() => config,
		{
			containerPrototype: Container.prototype as never,
			isTool: (value): value is never => value instanceof FakeTool,
		},
	);

	try {
		container.addChild(new FakeTool("Read") as never);
		container.addChild(new FakeTool("Bash") as never);
		assert.equal(installation.groupCount(), 1);
		assert.equal(container.children.length, 1);
		assert.match(container.render(80).join("\n"), /Ran 2 tools/);

		config.groupToolCalls = false;
		installation.refresh();
		assert.equal(installation.groupCount(), 0);
		assert.equal(container.children.length, 2);
	} finally {
		installation.dispose();
	}
});
