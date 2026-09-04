import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_RENDERING_CONFIG } from "../extensions/open-tui/config.ts";
import {
	installClaudeToolRenderer,
	isClaudeRenderableTool,
} from "../extensions/open-tui/claude-tool-renderer.ts";
import {
	identifyCodexSubagentTool,
	parseCodexSubagentToolDetails,
	renderCodexSubagentTool,
} from "../extensions/open-tui/codex-subagent-renderer.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

const subagentConfig = DEFAULT_TOOL_RENDERING_CONFIG.subagents;

function snapshot(overrides: Record<string, any> = {}): Record<string, any> {
	const now = Date.now();
	return {
		id: "agent_1",
		taskName: "inspect_api",
		profileName: "explorer",
		profileDescription: "Read-only exploration",
		message: "Inspect src/api",
		status: "running",
		finalOutput: "",
		stderr: "",
		model: "openai/gpt-test",
		effort: "high",
		tools: ["read", "grep"],
		cwd: "/repo",
		usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: 0.001, turns: 1 },
		activities: [
			{ id: "a1", kind: "tool", name: "grep", summary: "/authorize/ in src", status: "completed", startedAt: now - 3_000, endedAt: now - 2_000 },
			{ id: "a2", kind: "tool", name: "read", summary: "src/auth.ts", status: "running", startedAt: now - 1_000 },
		],
		startedAt: now - 5_000,
		updatedAt: now,
		...overrides,
	};
}

function richTool(overrides: Record<string, any> = {}): Record<string, any> {
	return {
		toolName: "spawn_agent",
		args: { agent_type: "explorer", task_name: "inspect_api", message: "Inspect src/api" },
		expanded: false,
		isPartial: false,
		executionStarted: true,
		result: {
			isError: false,
			content: [{ type: "text", text: '{"agent_id":"agent_1","nickname":"inspect_api"}' }],
			details: {
				action: "spawn",
				snapshots: [snapshot()],
			},
		},
		ui: { requestRender() {} },
		...overrides,
	};
}

function plain(lines: string[] | undefined): string {
	return (lines ?? []).map(stripAnsi).join("\n");
}

test("recognizes Codex-style subagent tools by conventional tool names", () => {
	assert.equal(identifyCodexSubagentTool("spawn_agent"), "spawn");
	assert.equal(identifyCodexSubagentTool("send_input"), "send");
	assert.equal(identifyCodexSubagentTool("wait_agent"), "wait");
	assert.equal(identifyCodexSubagentTool("close_agent"), "close");
	assert.equal(identifyCodexSubagentTool("list_agents"), "list");
	assert.equal(identifyCodexSubagentTool("read"), undefined);
	assert.equal(isClaudeRenderableTool(richTool()), true);
});

test("renders rich Claude-style progress without requiring a package marker", () => {
	const compact = plain(renderCodexSubagentTool(richTool(), theme, 160, subagentConfig));
	assert.match(compact, /● explorer \(inspect_api\)/);
	assert.match(compact, /⎿\s+✻ Read\(src\/auth\.ts\)/);
	assert.match(compact, /2 tool uses/);
	assert.match(compact, /120 tokens/);
	assert.match(compact, /Grep\(\/authorize\/ in src\)/);
	assert.match(compact, /Ctrl\+O to expand details/);

	const done = snapshot({
		status: "completed",
		finalOutput: "Found two issues.",
		completedAt: Date.now(),
		activities: snapshot().activities.map((item: Record<string, any>) => ({ ...item, status: "completed", endedAt: Date.now() })),
	});
	const expandedTool = richTool({
		expanded: true,
		result: {
			isError: false,
			content: [{ type: "text", text: "done" }],
			details: { action: "spawn", snapshots: [done] },
		},
	});
	const expanded = plain(renderCodexSubagentTool(expandedTool, theme, 160, subagentConfig));
	assert.match(expanded, /● Done/);
	assert.match(expanded, /Progress/);
	assert.match(expanded, /Configuration/);
	assert.match(expanded, /model: openai\/gpt-test/);
	assert.match(expanded, /Prompt/);
	assert.match(expanded, /Inspect src\/api/);
	assert.match(expanded, /Response/);
	assert.match(expanded, /Found two issues/);
});

test("accepts structurally compatible snake_case rich metadata", () => {
	const result = {
		isError: false,
		content: [{ type: "text", text: "{}" }],
		details: {
			snapshots: [{
				agent_id: "agent_2",
				task_name: "review_tests",
				agent_type: "reviewer",
				agent_status: "pending_init",
				started_at: Date.now(),
				updated_at: Date.now(),
			}],
		},
	};
	const parsed = parseCodexSubagentToolDetails(result, "spawn");
	assert.equal(parsed?.snapshots[0]?.taskName, "review_tests");
	assert.equal(parsed?.snapshots[0]?.status, "starting");
});

test("renders standard Codex JSON outputs when no rich details exist", () => {
	const spawn = richTool({
		result: {
			isError: false,
			content: [{ type: "text", text: '{"agent_id":"agent_9","nickname":"scan_api"}' }],
		},
	});
	assert.match(plain(renderCodexSubagentTool(spawn, theme, 160, subagentConfig)), /Started · scan_api · agent_9/);

	const wait = richTool({
		toolName: "wait_agent",
		args: { ids: ["agent_9", "agent_10"] },
		expanded: true,
		result: {
			isError: false,
			content: [{
				type: "text",
				text: JSON.stringify({
					status: {
						agent_9: { completed: "finished scan" },
						agent_10: "running",
					},
					timed_out: false,
				}),
			}],
		},
	});
	const rendered = plain(renderCodexSubagentTool(wait, theme, 160, subagentConfig));
	assert.match(rendered, /├─ agent_9 · Done/);
	assert.match(rendered, /finished scan/);
	assert.match(rendered, /└─ agent_10 · Running/);

	const spawnV2 = richTool({
		result: {
			isError: false,
			content: [{ type: "text", text: '{"task_name":"scan_api","nickname":"scanner"}' }],
		},
	});
	assert.match(plain(renderCodexSubagentTool(spawnV2, theme, 160, subagentConfig)), /Started · scanner · scan_api/);

	const waitV2 = richTool({
		toolName: "wait_agent",
		args: {},
		result: {
			isError: false,
			content: [{ type: "text", text: '{"message":"No mailbox updates","timed_out":true}' }],
		},
	});
	assert.match(plain(renderCodexSubagentTool(waitV2, theme, 160, subagentConfig)), /No mailbox updates/);

	const list = richTool({
		toolName: "list_agents",
		args: {},
		expanded: true,
		result: {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({
				agents: [{
					agent_name: "review_tests",
					agent_status: "running",
					last_task_message: "Review timeout handling",
				}],
			}) }],
		},
	});
	const listed = plain(renderCodexSubagentTool(list, theme, 160, subagentConfig));
	assert.match(listed, /review_tests · Running/);
	assert.match(listed, /Review timeout handling/);
});

test("renders multi-agent rich waits as a task tree", () => {
	const waitTool = richTool({
		toolName: "wait_agent",
		args: { ids: ["inspect_api", "review_tests"] },
		result: {
			isError: false,
			content: [{ type: "text", text: "waiting" }],
			details: {
				action: "wait",
				snapshots: [
					snapshot({ status: "completed", finalOutput: "done", completedAt: Date.now() }),
					snapshot({ id: "agent_2", taskName: "review_tests", profileName: "reviewer" }),
				],
			},
		},
	});
	const rendered = plain(renderCodexSubagentTool(waitTool, theme, 160, subagentConfig));
	assert.match(rendered, /├─ explorer \(inspect_api\)/);
	assert.match(rendered, /│\s+⎿\s+● Done/);
	assert.match(rendered, /└─ reviewer \(review_tests\)/);
});

test("prototype integration falls back for malformed results or disabled rendering", () => {
	const prototype = {
		render(_width: number): string[] {
			return ["ORIGINAL"];
		},
	};
	const cleanup = installClaudeToolRenderer(() => theme, { prototype });
	try {
		assert.doesNotMatch(plain(prototype.render.call(richTool(), 120)), /ORIGINAL/);
		const malformed = richTool({ result: { isError: false, content: [{ type: "text", text: "not json" }], details: { snapshots: "wrong" } } });
		assert.equal(plain(prototype.render.call(malformed, 120)), "ORIGINAL");
	} finally {
		cleanup();
	}

	const disabledPrototype = { render(_width: number): string[] { return ["ORIGINAL"]; } };
	const disabledConfig = {
		...DEFAULT_TOOL_RENDERING_CONFIG,
		subagents: { ...subagentConfig, enabled: false },
	};
	const cleanupDisabled = installClaudeToolRenderer(() => theme, {
		prototype: disabledPrototype,
		getConfig: () => disabledConfig,
	});
	try {
		assert.equal(plain(disabledPrototype.render.call(richTool(), 120)), "ORIGINAL");
	} finally {
		cleanupDisabled();
	}
});
