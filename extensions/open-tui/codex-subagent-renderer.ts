import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentRenderingConfig } from "./config.ts";
import { asString, isObject } from "./claude-tool-renderer-shared.ts";

/**
 * Codex-style multi-agent tools shared by the v1/v2 interfaces. Matching is
 * intentionally convention-based: tool name plus argument/result shape. It
 * does not know which extension registered the tool.
 */
export type CodexSubagentAction = "spawn" | "send" | "wait" | "close" | "list";
export type CodexSubagentStatus = "starting" | "running" | "completed" | "errored" | "interrupted" | "closed";
type CodexSubagentActivityStatus = "running" | "completed" | "errored";

const TOOL_ACTIONS: Readonly<Record<string, CodexSubagentAction>> = {
	spawn_agent: "spawn",
	send_input: "send",
	wait_agent: "wait",
	close_agent: "close",
	list_agents: "list",
};

export const CODEX_SUBAGENT_TOOL_NAMES = new Set(Object.keys(TOOL_ACTIONS));

interface CodexSubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface CodexSubagentActivity {
	id: string;
	kind: "tool" | "message" | "system";
	name: string;
	summary: string;
	status: CodexSubagentActivityStatus;
	startedAt: number;
	endedAt?: number;
}

export interface CodexSubagentSnapshot {
	id: string;
	taskName: string;
	profileName: string;
	profileDescription?: string;
	message: string;
	status: CodexSubagentStatus;
	finalOutput: string;
	stderr: string;
	error?: string;
	model?: string;
	effort?: string;
	tools: "none" | string[];
	cwd: string;
	usage: CodexSubagentUsage;
	activities: CodexSubagentActivity[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

/** Rich, presentation-neutral metadata optionally supplied by a tool. */
export interface CodexSubagentToolDetails {
	action: CodexSubagentAction;
	snapshots: CodexSubagentSnapshot[];
	timedOut?: boolean;
	message?: string;
	previousSnapshot?: CodexSubagentSnapshot;
}

export interface CodexSubagentToolComponentLike {
	toolName?: unknown;
	args?: unknown;
	result?: unknown;
	expanded?: unknown;
	isPartial?: unknown;
}

type CodexWireStatus =
	| "pending_init"
	| "starting"
	| "running"
	| "interrupted"
	| "shutdown"
	| "closed"
	| "not_found"
	| { completed: string | null }
	| { errored: string };

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numeric(value: unknown): number {
	return finiteNumber(value) ?? 0;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = optionalString(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function activityStatus(value: unknown): CodexSubagentActivityStatus | undefined {
	if (value === "running") return "running";
	if (value === "completed" || value === "done" || value === "success") return "completed";
	if (value === "errored" || value === "error" || value === "failed") return "errored";
	return undefined;
}

function agentStatus(value: unknown): CodexSubagentStatus | undefined {
	if (value === "starting" || value === "pending_init") return "starting";
	if (value === "running") return "running";
	if (value === "completed" || value === "done" || value === "success") return "completed";
	if (value === "errored" || value === "error" || value === "failed") return "errored";
	if (value === "interrupted") return "interrupted";
	if (value === "closed" || value === "shutdown") return "closed";
	if (isObject(value)) {
		if (Object.prototype.hasOwnProperty.call(value, "completed")) return "completed";
		if (typeof value.errored === "string") return "errored";
	}
	return undefined;
}

function parseUsage(value: unknown): CodexSubagentUsage {
	const record = isObject(value) ? value : {};
	return {
		input: numeric(record.input ?? record.input_tokens ?? record.inputTokens),
		output: numeric(record.output ?? record.output_tokens ?? record.outputTokens),
		cacheRead: numeric(record.cacheRead ?? record.cache_read ?? record.cache_read_tokens ?? record.cacheReadTokens),
		cacheWrite: numeric(record.cacheWrite ?? record.cache_write ?? record.cache_write_tokens ?? record.cacheWriteTokens),
		cost: numeric(record.cost),
		turns: numeric(record.turns),
	};
}

function parseActivity(value: unknown, index: number): CodexSubagentActivity | undefined {
	if (!isObject(value)) return undefined;
	const kindValue = value.kind;
	const kind = kindValue === "message" || kindValue === "system" || kindValue === "tool" ? kindValue : "tool";
	const name = firstString(value, ["name", "tool_name", "toolName"]);
	if (!name) return undefined;
	const startedAt = firstNumber(value, ["startedAt", "started_at"]) ?? 0;
	const endedAt = firstNumber(value, ["endedAt", "ended_at"]);
	return {
		id: firstString(value, ["id", "tool_call_id", "toolCallId"]) ?? `${kind}:${name}:${index}`,
		kind,
		name,
		summary: firstString(value, ["summary", "detail", "description"]) ?? name,
		status: activityStatus(value.status) ?? (endedAt !== undefined ? "completed" : "running"),
		startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
	};
}

function parseSnapshot(value: unknown): CodexSubagentSnapshot | undefined {
	if (!isObject(value)) return undefined;
	const id = firstString(value, ["id", "agent_id", "agentId", "target"]);
	if (!id) return undefined;
	const statusValue = value.status ?? value.agent_status ?? value.agentStatus;
	const status = agentStatus(statusValue);
	if (!status) return undefined;
	const taskName = firstString(value, ["taskName", "task_name", "agent_name", "agentName", "nickname"]) ?? id;
	const profileName = firstString(value, ["profileName", "profile_name", "agent_type", "agentType", "role"]) ?? "agent";
	const rawActivities = Array.isArray(value.activities)
		? value.activities
		: Array.isArray(value.progress)
			? value.progress
			: [];
	const activities = rawActivities
		.map((activity, index) => parseActivity(activity, index))
		.filter((item): item is CodexSubagentActivity => item !== undefined);
	if (activities.length !== rawActivities.length) return undefined;
	const tools = value.tools === "none"
		? "none"
		: Array.isArray(value.tools)
			? value.tools.filter((item): item is string => typeof item === "string")
			: [];
	const startedAt = firstNumber(value, ["startedAt", "started_at"])
		?? firstNumber(value, ["updatedAt", "updated_at", "completedAt", "completed_at"])
		?? Date.now();
	const updatedAt = firstNumber(value, ["updatedAt", "updated_at"]) ?? startedAt;
	const completedAt = firstNumber(value, ["completedAt", "completed_at"]);
	const profileDescription = firstString(value, ["profileDescription", "profile_description"]);
	const error = firstString(value, ["error", "last_error"])
		?? (isObject(statusValue) && typeof statusValue.errored === "string" ? statusValue.errored : undefined);
	const completedMessage = isObject(statusValue) && typeof statusValue.completed === "string" ? statusValue.completed : undefined;
	return {
		id,
		taskName,
		profileName,
		...(profileDescription ? { profileDescription } : {}),
		message: firstString(value, ["message", "prompt", "task"]) ?? "",
		status,
		finalOutput: firstString(value, ["finalOutput", "final_output", "output", "response"]) ?? completedMessage ?? "",
		stderr: firstString(value, ["stderr", "process_log", "processLog"]) ?? "",
		...(error ? { error } : {}),
		...(firstString(value, ["model"]) ? { model: firstString(value, ["model"]) } : {}),
		...(firstString(value, ["effort", "reasoning_effort", "reasoningEffort"])
			? { effort: firstString(value, ["effort", "reasoning_effort", "reasoningEffort"]) }
			: {}),
		tools,
		cwd: firstString(value, ["cwd", "working_directory", "workingDirectory"]) ?? "",
		usage: parseUsage(value.usage),
		activities,
		startedAt,
		updatedAt,
		...(completedAt !== undefined ? { completedAt } : {}),
	};
}

export function identifyCodexSubagentTool(toolName: unknown): CodexSubagentAction | undefined {
	const normalized = asString(toolName)?.toLowerCase();
	return normalized ? TOOL_ACTIONS[normalized] : undefined;
}

export function isCodexSubagentToolName(toolName: unknown): boolean {
	return identifyCodexSubagentTool(toolName) !== undefined;
}

/**
 * Parse optional rich metadata by structure only. `action` may be omitted
 * because the tool name already identifies it. No package name or marker is
 * accepted as an identity signal.
 */
export function parseCodexSubagentToolDetails(
	result: unknown,
	expectedAction: CodexSubagentAction,
): CodexSubagentToolDetails | undefined {
	if (!isObject(result) || !isObject(result.details)) return undefined;
	const details = result.details;
	if (details.action !== undefined && details.action !== expectedAction) return undefined;
	const rawSnapshots = Array.isArray(details.snapshots)
		? details.snapshots
		: Array.isArray(details.agents)
			? details.agents
			: undefined;
	if (!rawSnapshots) return undefined;
	const snapshots = rawSnapshots.map(parseSnapshot).filter((item): item is CodexSubagentSnapshot => item !== undefined);
	if (snapshots.length !== rawSnapshots.length) return undefined;
	const rawPrevious = details.previousSnapshot ?? details.previous_snapshot;
	const previousSnapshot = rawPrevious === undefined ? undefined : parseSnapshot(rawPrevious);
	if (rawPrevious !== undefined && !previousSnapshot) return undefined;
	return {
		action: expectedAction,
		snapshots,
		...(typeof (details.timedOut ?? details.timed_out) === "boolean"
			? { timedOut: Boolean(details.timedOut ?? details.timed_out) }
			: {}),
		...(typeof details.message === "string" ? { message: details.message } : {}),
		...(previousSnapshot ? { previousSnapshot } : {}),
	};
}

function resultText(result: unknown): string {
	if (!isObject(result)) return "";
	if (typeof result.text === "string") return result.text;
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((block): block is Record<string, unknown> => isObject(block))
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("\n")
		.trim();
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
	let candidate = text.trim();
	if (!candidate) return undefined;
	const fenced = candidate.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
	if (fenced) candidate = fenced[1]!.trim();
	try {
		const parsed: unknown = JSON.parse(candidate);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseStandardPayload(result: unknown): Record<string, unknown> | undefined {
	if (!isObject(result)) return undefined;
	const directKeys = ["agent_id", "nickname", "submission_id", "status", "timed_out", "previous_status", "agents"];
	if (directKeys.some((key) => Object.prototype.hasOwnProperty.call(result, key))) return result;
	return parseJsonText(resultText(result));
}

function parseWireStatus(value: unknown): CodexWireStatus | undefined {
	if (
		value === "pending_init"
		|| value === "starting"
		|| value === "running"
		|| value === "interrupted"
		|| value === "shutdown"
		|| value === "closed"
		|| value === "not_found"
	) return value;
	if (!isObject(value)) return undefined;
	if (Object.prototype.hasOwnProperty.call(value, "completed")) {
		return { completed: typeof value.completed === "string" ? value.completed : null };
	}
	if (typeof value.errored === "string") return { errored: value.errored };
	return undefined;
}

function formatCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatSubagentDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const minuteRest = minutes % 60;
	return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function friendlyToolName(name: string): string {
	const known: Record<string, string> = {
		read: "Read",
		write: "Write",
		edit: "Edit",
		grep: "Grep",
		find: "Find",
		ls: "List",
		bash: "Bash",
		shell_command: "Shell",
		powershell: "PowerShell",
		apply_patch: "Update",
		web_search: "WebSearch",
	};
	return known[name] ?? name;
}

function formatActivity(activity: CodexSubagentActivity): string {
	const name = friendlyToolName(activity.name);
	return activity.summary && activity.summary !== activity.name ? `${name}(${activity.summary})` : name;
}

function terminalStatusLabel(status: CodexSubagentStatus): string {
	switch (status) {
		case "starting": return "initializing";
		case "running": return "running";
		case "completed": return "completed";
		case "errored": return "failed";
		case "interrupted": return "interrupted";
		case "closed": return "stopped";
	}
}

function statusColor(status: CodexSubagentStatus): "success" | "error" | "warning" | "dim" | "muted" | "accent" {
	switch (status) {
		case "completed": return "success";
		case "errored": return "error";
		case "interrupted": return "warning";
		case "closed": return "dim";
		case "starting": return "muted";
		case "running": return "accent";
	}
}

function statusGlyph(status: CodexSubagentStatus): string {
	switch (status) {
		case "starting": return "○";
		case "running": return "✻";
		case "completed":
		case "errored":
		case "interrupted":
			return "●";
		case "closed": return "○";
	}
}

function firstLine(value: string, max = 140): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function summaryParts(snapshot: CodexSubagentSnapshot, config: SubagentRenderingConfig): string[] {
	const parts: string[] = [];
	if (config.showToolActivity) {
		const toolUses = snapshot.activities.filter((item) => item.kind === "tool").length;
		if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
	}
	if (config.showUsage) {
		const totalTokens = snapshot.usage.input + snapshot.usage.output;
		if (totalTokens > 0) parts.push(`${formatCount(totalTokens)} tokens`);
	}
	if (config.showElapsed) {
		parts.push(formatSubagentDuration((snapshot.completedAt ?? Date.now()) - snapshot.startedAt));
	}
	return parts;
}

function detailedUsage(snapshot: CodexSubagentSnapshot): string {
	const parts: string[] = [];
	if (snapshot.usage.turns) parts.push(`${snapshot.usage.turns} turn${snapshot.usage.turns === 1 ? "" : "s"}`);
	if (snapshot.usage.input) parts.push(`↑${formatCount(snapshot.usage.input)}`);
	if (snapshot.usage.output) parts.push(`↓${formatCount(snapshot.usage.output)}`);
	if (snapshot.usage.cacheRead) parts.push(`R${formatCount(snapshot.usage.cacheRead)}`);
	if (snapshot.usage.cacheWrite) parts.push(`W${formatCount(snapshot.usage.cacheWrite)}`);
	if (snapshot.usage.cost) parts.push(`$${snapshot.usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function currentActivity(snapshot: CodexSubagentSnapshot, previousSnapshot?: CodexSubagentSnapshot): string {
	if (snapshot.status === "closed" && previousSnapshot) {
		return `Stopped · was ${terminalStatusLabel(previousSnapshot.status)}`;
	}
	switch (snapshot.status) {
		case "starting": return "Initializing…";
		case "running": {
			const activity = [...snapshot.activities].reverse().find((item) => item.kind === "tool");
			return activity ? formatActivity(activity) : "Initializing…";
		}
		case "completed": return "Done";
		case "errored": return snapshot.error ? `Failed: ${firstLine(snapshot.error)}` : "Failed";
		case "interrupted": return "Interrupted";
		case "closed": return "Stopped";
	}
}

function agentIdentity(snapshot: CodexSubagentSnapshot, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(snapshot.profileName))
		+ theme.fg("muted", " (")
		+ theme.fg("text", snapshot.taskName)
		+ theme.fg("muted", ")");
}

function singleStatusLine(
	snapshot: CodexSubagentSnapshot,
	theme: Theme,
	config: SubagentRenderingConfig,
	previousSnapshot?: CodexSubagentSnapshot,
): string {
	const stats = summaryParts(snapshot, config);
	const suffix = stats.length > 0 ? ` (${stats.join(" · ")})` : "";
	return theme.fg("dim", "  ⎿  ")
		+ theme.fg(statusColor(snapshot.status), `${statusGlyph(snapshot.status)} ${currentActivity(snapshot, previousSnapshot)}`)
		+ theme.fg("dim", suffix);
}

function treeHeader(snapshot: CodexSubagentSnapshot, isLast: boolean, theme: Theme, config: SubagentRenderingConfig): string {
	const stats = summaryParts(snapshot, config);
	return theme.fg("dim", `${isLast ? "└─" : "├─"} `)
		+ agentIdentity(snapshot, theme)
		+ (stats.length > 0 ? theme.fg("dim", ` · ${stats.join(" · ")}`) : "");
}

function treeStatus(
	snapshot: CodexSubagentSnapshot,
	isLast: boolean,
	theme: Theme,
	previousSnapshot?: CodexSubagentSnapshot,
): string {
	return theme.fg("dim", isLast ? "   ⎿  " : "│  ⎿  ")
		+ theme.fg(statusColor(snapshot.status), `${statusGlyph(snapshot.status)} ${currentActivity(snapshot, previousSnapshot)}`);
}

function addRecentCollapsedActivity(
	container: Container,
	snapshot: CodexSubagentSnapshot,
	theme: Theme,
	config: SubagentRenderingConfig,
): void {
	if (snapshot.status !== "running" || !config.showToolActivity) return;
	const count = Math.max(0, config.collapsedActivityItems - 1);
	if (count === 0) return;
	const recent = snapshot.activities.filter((item) => item.kind === "tool").slice(-count - 1, -1);
	for (const activity of recent) {
		container.addChild(new Text(theme.fg("dim", `     ${formatActivity(activity)}`), 0, 0));
	}
}

function addProgressSection(
	container: Container,
	snapshot: CodexSubagentSnapshot,
	theme: Theme,
	config: SubagentRenderingConfig,
): void {
	if (!config.showToolActivity || snapshot.activities.length === 0) return;
	const visible = snapshot.activities.slice(-config.expandedActivityItems);
	const hidden = Math.max(0, snapshot.activities.length - visible.length);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", theme.bold("     Progress")), 0, 0));
	if (hidden > 0) {
		container.addChild(new Text(theme.fg("dim", `       … +${hidden} earlier activit${hidden === 1 ? "y" : "ies"}`), 0, 0));
	}
	for (let index = 0; index < visible.length; index++) {
		const activity = visible[index]!;
		const latest = index === visible.length - 1;
		const marker = latest ? "› " : "  ";
		const color = activity.status === "errored" ? "error" : latest && activity.status === "running" ? "text" : "dim";
		const elapsed = activity.endedAt ? ` · ${formatSubagentDuration(activity.endedAt - activity.startedAt)}` : "";
		container.addChild(new Text(
			theme.fg("dim", `     ${marker}`) + theme.fg(color, formatActivity(activity)) + theme.fg("dim", elapsed),
			0,
			0,
		));
	}
}

function addMetadataSection(container: Container, snapshot: CodexSubagentSnapshot, theme: Theme): void {
	const tools = snapshot.tools === "none" ? "none" : snapshot.tools.join(", ") || "none";
	const settings = [
		snapshot.model ? `model: ${snapshot.model}` : "model: default",
		snapshot.effort ? `effort: ${snapshot.effort}` : "effort: default",
		`tools: ${tools}`,
		`cwd: ${snapshot.cwd}`,
	].join(" · ");
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", theme.bold("     Configuration")), 0, 0));
	container.addChild(new Text(theme.fg("dim", `       ${settings}`), 0, 0));
	const usage = detailedUsage(snapshot);
	if (usage) container.addChild(new Text(theme.fg("dim", `       usage: ${usage}`), 0, 0));
}

function addMarkdownSection(container: Container, title: string, content: string, theme: Theme, error = false): void {
	if (!content.trim()) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg(error ? "error" : "dim", theme.bold(`     ${title}`)), 0, 0));
	container.addChild(new Markdown(content, 7, 0, getMarkdownTheme()));
}

function hasExpandableDetails(snapshot: CodexSubagentSnapshot): boolean {
	return Boolean(
		snapshot.profileDescription
			|| snapshot.message
			|| snapshot.model
			|| snapshot.effort
			|| snapshot.activities.length > 0
			|| snapshot.finalOutput
			|| snapshot.error
			|| snapshot.stderr,
	);
}

function snapshotComponent(
	snapshot: CodexSubagentSnapshot,
	expanded: boolean,
	includeTitle: boolean,
	isLast: boolean,
	theme: Theme,
	config: SubagentRenderingConfig,
	previousSnapshot?: CodexSubagentSnapshot,
): Container {
	const container = new Container();
	if (includeTitle) {
		container.addChild(new Text(treeHeader(snapshot, isLast, theme, config), 0, 0));
		container.addChild(new Text(treeStatus(snapshot, isLast, theme, previousSnapshot), 0, 0));
	} else {
		container.addChild(new Text(singleStatusLine(snapshot, theme, config, previousSnapshot), 0, 0));
	}
	if (!expanded) {
		addRecentCollapsedActivity(container, snapshot, theme, config);
		return container;
	}
	if (snapshot.profileDescription) container.addChild(new Text(theme.fg("dim", `     ${snapshot.profileDescription}`), 0, 0));
	addProgressSection(container, snapshot, theme, config);
	addMetadataSection(container, snapshot, theme);
	addMarkdownSection(container, "Prompt", snapshot.message, theme);
	if (snapshot.error) addMarkdownSection(container, "Error", snapshot.error, theme, true);
	else if (snapshot.finalOutput) addMarkdownSection(container, "Response", snapshot.finalOutput, theme);
	if (snapshot.stderr) addMarkdownSection(container, "Process log", snapshot.stderr, theme, true);
	return container;
}

function targetList(args: Record<string, unknown>): string {
	if (Array.isArray(args.ids)) {
		const ids = args.ids.filter((value): value is string => typeof value === "string");
		if (ids.length <= 2) return ids.join(", ") || "subagents";
		return `${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
	}
	return "subagents";
}

function renderSubagentCall(action: CodexSubagentAction, args: Record<string, unknown>, theme: Theme): Text {
	const dot = theme.fg("accent", "● ");
	if (action === "spawn") {
		const profile = typeof args.agent_type === "string" ? args.agent_type : "default";
		const taskName = typeof args.task_name === "string" ? args.task_name : "subagent";
		return new Text(
			dot + theme.fg("toolTitle", theme.bold(profile)) + theme.fg("muted", " (") + theme.fg("text", taskName) + theme.fg("muted", ")"),
			0,
			0,
		);
	}
	if (action === "send") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Message")) + theme.fg("muted", ` (${String(args.target ?? "subagent")})`), 0, 0);
	}
	if (action === "wait") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Wait")) + theme.fg("muted", ` (${targetList(args)})`), 0, 0);
	}
	if (action === "close") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Stop")) + theme.fg("muted", ` (${String(args.target ?? "subagent")})`), 0, 0);
	}
	return new Text(dot + theme.fg("toolTitle", theme.bold("Subagents")), 0, 0);
}

function renderSubagentResult(
	details: CodexSubagentToolDetails,
	expanded: boolean,
	theme: Theme,
	config: SubagentRenderingConfig,
	isPartial: boolean,
): Container {
	const container = new Container();
	if (details.message) container.addChild(new Text(theme.fg("error", `  ⎿  ${details.message}`), 0, 0));
	if (details.snapshots.length === 0) {
		if (!details.message) container.addChild(new Text(theme.fg("dim", "  ⎿  No subagents"), 0, 0));
		return container;
	}
	const includeTitle = details.action === "wait" || details.action === "list" || details.snapshots.length > 1;
	for (let index = 0; index < details.snapshots.length; index++) {
		if (index > 0 && expanded) container.addChild(new Spacer(1));
		container.addChild(snapshotComponent(
			details.snapshots[index]!,
			expanded,
			includeTitle,
			index === details.snapshots.length - 1,
			theme,
			config,
			details.action === "close" ? details.previousSnapshot : undefined,
		));
	}
	if (details.timedOut) container.addChild(new Text(theme.fg("warning", "  ⎿  Wait timed out · agents are still running"), 0, 0));
	else if (isPartial && details.action === "wait") container.addChild(new Text(theme.fg("dim", "  ⎿  Waiting for an agent update…"), 0, 0));
	if (!expanded && config.showExpandHint && details.snapshots.some(hasExpandableDetails)) {
		container.addChild(new Text(theme.fg("dim", "     Ctrl+O to expand details"), 0, 0));
	}
	return container;
}


type StatusColor = "success" | "error" | "warning" | "dim" | "muted" | "accent";

function wireStatusPresentation(status: CodexWireStatus): { label: string; color: StatusColor; output?: string } {
	if (typeof status === "string") {
		switch (status) {
			case "pending_init":
			case "starting":
				return { label: "Initializing…", color: "muted" };
			case "running":
				return { label: "Running", color: "accent" };
			case "interrupted":
				return { label: "Interrupted", color: "warning" };
			case "shutdown":
			case "closed":
				return { label: "Stopped", color: "dim" };
			case "not_found":
				return { label: "Not found", color: "warning" };
		}
	}
	if ("completed" in status) {
		return {
			label: "Done",
			color: "success",
			...(status.completed ? { output: status.completed } : {}),
		};
	}
	return { label: `Failed: ${firstLine(status.errored)}`, color: "error", output: status.errored };
}

function targetFromArgs(args: Record<string, unknown>): string {
	return typeof args.target === "string" && args.target ? args.target : "subagent";
}

function addWireStatusLine(
	container: Container,
	prefix: string,
	identity: string,
	status: CodexWireStatus,
	theme: Theme,
	expanded: boolean,
): void {
	const presentation = wireStatusPresentation(status);
	container.addChild(new Text(
		theme.fg("dim", prefix)
			+ theme.fg("text", identity)
			+ theme.fg("dim", " · ")
			+ theme.fg(presentation.color, presentation.label),
		0,
		0,
	));
	if (expanded && presentation.output) {
		container.addChild(new Text(theme.fg("dim", "   ⎿  ") + theme.fg("text", firstLine(presentation.output, 240)), 0, 0));
	}
}

function renderStandardCodexResult(
	action: CodexSubagentAction,
	payload: Record<string, unknown>,
	args: Record<string, unknown>,
	theme: Theme,
	expanded: boolean,
): Container | undefined {
	const container = new Container();
	if (action === "spawn") {
		const id = firstString(payload, ["agent_id", "agentId", "id", "task_name", "taskName"]);
		if (!id) return undefined;
		const nickname = firstString(payload, ["nickname"]);
		const subject = nickname && nickname !== id ? `${nickname} · ${id}` : id;
		container.addChild(new Text(theme.fg("dim", "  ⎿  ") + theme.fg("success", "Started") + theme.fg("dim", ` · ${subject}`), 0, 0));
		return container;
	}
	if (action === "send") {
		const submissionId = firstString(payload, ["submission_id", "submissionId", "id"]);
		if (!submissionId) return undefined;
		container.addChild(new Text(
			theme.fg("dim", "  ⎿  ") + theme.fg("success", "Message submitted") + theme.fg("dim", ` · ${submissionId}`),
			0,
			0,
		));
		return container;
	}
	if (action === "wait") {
		const timedOut = payload.timed_out === true || payload.timedOut === true;
		if (isObject(payload.status)) {
			const entries = Object.entries(payload.status);
			if (entries.length === 0) {
				container.addChild(new Text(
					theme.fg(timedOut ? "warning" : "dim", timedOut ? "  ⎿  Wait timed out · agents are still running" : "  ⎿  No agent updates"),
					0,
					0,
				));
				return container;
			}
			for (let index = 0; index < entries.length; index++) {
				const [target, rawStatus] = entries[index]!;
				const status = parseWireStatus(rawStatus);
				if (!status) return undefined;
				addWireStatusLine(container, index === entries.length - 1 ? "└─ " : "├─ ", target, status, theme, expanded);
			}
			if (timedOut) container.addChild(new Text(theme.fg("warning", "  ⎿  Wait timed out · remaining agents are still running"), 0, 0));
			return container;
		}
		const message = firstString(payload, ["message"]);
		if (!message || typeof (payload.timed_out ?? payload.timedOut) !== "boolean") return undefined;
		container.addChild(new Text(
			theme.fg("dim", "  ⎿  ") + theme.fg(timedOut ? "warning" : "text", message),
			0,
			0,
		));
		return container;
	}
	if (action === "close") {
		const status = parseWireStatus(payload.previous_status ?? payload.previousStatus);
		if (!status) return undefined;
		const presentation = wireStatusPresentation(status);
		container.addChild(new Text(
			theme.fg("dim", "  ⎿  ")
				+ theme.fg("success", "Closed")
				+ theme.fg("dim", ` · ${targetFromArgs(args)} was `)
				+ theme.fg(presentation.color, presentation.label),
			0,
			0,
		));
		return container;
	}
	if (!Array.isArray(payload.agents)) return undefined;
	if (payload.agents.length === 0) {
		container.addChild(new Text(theme.fg("dim", "  ⎿  No live agents"), 0, 0));
		return container;
	}
	for (let index = 0; index < payload.agents.length; index++) {
		const agent = payload.agents[index];
		if (!isObject(agent)) return undefined;
		const name = firstString(agent, ["agent_name", "agentName", "task_name", "taskName", "nickname", "agent_id", "agentId", "id"]);
		if (!name) return undefined;
		const type = firstString(agent, ["agent_type", "agentType", "profile_name", "profileName", "role"]);
		const status = parseWireStatus(agent.agent_status ?? agent.agentStatus ?? agent.status);
		if (!status) return undefined;
		const identity = type ? `${type} (${name})` : name;
		addWireStatusLine(container, index === payload.agents.length - 1 ? "└─ " : "├─ ", identity, status, theme, expanded);
		const lastTask = firstString(agent, ["last_task_message", "lastTaskMessage"]);
		if (expanded && lastTask) {
			container.addChild(new Text(theme.fg("dim", "   ⎿  ") + theme.fg("text", firstLine(lastTask, 240)), 0, 0));
		}
	}
	return container;
}

export function renderCodexSubagentTool(
	tool: CodexSubagentToolComponentLike,
	theme: Theme,
	width: number,
	config: SubagentRenderingConfig,
): string[] | undefined {
	const action = identifyCodexSubagentTool(tool.toolName);
	if (!action || !config.enabled) return undefined;
	const details = parseCodexSubagentToolDetails(tool.result, action);
	const payload = details ? undefined : parseStandardPayload(tool.result);
	const args = isObject(tool.args) ? tool.args : {};
	const standard = payload
		? renderStandardCodexResult(action, payload, args, theme, tool.expanded === true)
		: undefined;
	if (tool.result !== undefined && !details && !standard) return undefined;
	const container = new Container();
	container.addChild(renderSubagentCall(action, args, theme));
	if (details) {
		container.addChild(renderSubagentResult(details, tool.expanded === true, theme, config, tool.isPartial === true));
	} else if (standard) {
		container.addChild(standard);
	}
	return ["", ...container.render(Math.max(1, width))];
}
