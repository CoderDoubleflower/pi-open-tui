import {
	EXPAND_HINT,
	isObject,
	textOutputRaw,
	type ClaudeToolStatus,
	type ToolResultLike,
} from "./claude-tool-renderer-shared.ts";
import { stripAnsi, visibleWidth } from "./utils.ts";

const MAX_INPUT_VALUE_CHARS = 80;
const MCP_RESULT_LINES = 3;
const MCP_OUTPUT_WARNING_THRESHOLD_TOKENS = 10_000;
const MAX_FLAT_JSON_KEYS = 12;
const MAX_FLAT_JSON_CHARS = 5_000;
const MAX_JSON_PARSE_CHARS = 200_000;
const UNWRAP_MIN_STRING_LEN = 200;

export type ClaudeMcpToolKind = "gateway" | "namespace" | "direct" | "script";

export interface ClaudeMcpToolIdentity {
	kind: ClaudeMcpToolKind;
	serverName?: string;
	remoteToolName?: string;
}

export interface ClaudeMcpToolUse {
	name: string;
	detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value) && !Array.isArray(value);
}

function definitionLabel(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.label === "string" ? value.label : undefined;
}

function mcpLabelSubject(label: string | undefined): string | undefined {
	const match = /^MCP:\s*(.+)$/i.exec(label?.trim() ?? "");
	return match?.[1]?.trim() || undefined;
}

/** Decode the adapter's reversible `_HEX_` Unicode code-point escapes. */
function decodeMcpIdentifier(value: string): string {
	return value.replace(/_([0-9a-f]{2,6})_/gi, (match, hex: string) => {
		const codePoint = Number.parseInt(hex, 16);
		if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return match;
		try {
			return String.fromCodePoint(codePoint);
		} catch {
			return match;
		}
	});
}

function matchesMcpIdentifier(value: string, expected: string): boolean {
	return value === expected || decodeMcpIdentifier(value) === expected;
}

function deriveDirectServerName(toolName: string, remoteToolName: string): string | undefined {
	const emitted = toolName.startsWith("mcp__") ? toolName.slice("mcp__".length) : toolName;
	const remoteCandidates = new Set([
		remoteToolName,
		remoteToolName.replace(/\./g, "_"),
		remoteToolName.replace(/[.-]/g, "_"),
	]);

	for (const remoteCandidate of remoteCandidates) {
		if (matchesMcpIdentifier(emitted, remoteCandidate)) return undefined;
		const suffix = `_${remoteCandidate}`;
		if (emitted.endsWith(suffix)) {
			const prefix = emitted.slice(0, -suffix.length);
			return prefix ? decodeMcpIdentifier(prefix) : undefined;
		}

		const decoded = decodeMcpIdentifier(emitted);
		if (decoded.endsWith(suffix)) {
			const prefix = decoded.slice(0, -suffix.length);
			return prefix || undefined;
		}
	}
	return undefined;
}

export function identifyClaudeMcpTool(
	toolName: string,
	toolDefinition: unknown,
	argsValue: unknown,
): ClaudeMcpToolIdentity | undefined {
	const args = isRecord(argsValue) ? argsValue : {};
	const label = definitionLabel(toolDefinition);
	const labelSubject = mcpLabelSubject(label);
	const lower = toolName.toLowerCase();

	if (lower === "mcpscript" || label?.trim().toLowerCase() === "mcp script") {
		return { kind: "script" };
	}

	if (lower === "mcp") {
		return {
			kind: "gateway",
			serverName: typeof args.server === "string" ? args.server : undefined,
			remoteToolName: typeof args.tool === "string" ? args.tool : undefined,
		};
	}

	if (toolName.startsWith("mcp__")) {
		const emittedNamespace = toolName.slice("mcp__".length);
		if (labelSubject && matchesMcpIdentifier(emittedNamespace, labelSubject)) {
			return {
				kind: "namespace",
				serverName: labelSubject,
				remoteToolName: typeof args.tool === "string" ? args.tool : undefined,
			};
		}

		if (!labelSubject && typeof args.tool === "string") {
			return {
				kind: "namespace",
				serverName: decodeMcpIdentifier(emittedNamespace),
				remoteToolName: args.tool,
			};
		}
	}

	if (labelSubject) {
		return {
			kind: "direct",
			serverName: deriveDirectServerName(toolName, labelSubject),
			remoteToolName: labelSubject,
		};
	}

	return undefined;
}

function safeJsonStringify(value: unknown): string {
	try {
		const rendered = JSON.stringify(value);
		return rendered === undefined ? String(value) : rendered;
	} catch {
		return String(value);
	}
}

function formatInputEntries(value: unknown, expanded: boolean): string {
	const entries = isRecord(value) ? Object.entries(value) : value === undefined ? [] : [["args", value] as const];
	return entries
		.map(([key, entryValue]) => {
			let rendered = safeJsonStringify(entryValue);
			if (!expanded && rendered.length > MAX_INPUT_VALUE_CHARS) {
				rendered = `${rendered.slice(0, MAX_INPUT_VALUE_CHARS).trimEnd()}…`;
			}
			return `${key}: ${rendered}`;
		})
		.join(", ");
}

function parseGatewayArguments(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return { args: value };
	}
}

function mcpDisplayName(identity: ClaudeMcpToolIdentity): string {
	if (identity.kind === "script") return "MCP Script";
	if (identity.remoteToolName) {
		return identity.serverName
			? `${identity.serverName} - ${identity.remoteToolName} (MCP)`
			: `${identity.remoteToolName} (MCP)`;
	}
	return identity.serverName ? `${identity.serverName} (MCP)` : "MCP";
}

export function formatClaudeMcpToolUse(
	identity: ClaudeMcpToolIdentity,
	argsValue: unknown,
	expanded = false,
): ClaudeMcpToolUse {
	const args = isRecord(argsValue) ? argsValue : {};
	const remoteToolName = identity.remoteToolName;
	const name = mcpDisplayName(identity);

	if (remoteToolName && (identity.kind === "gateway" || identity.kind === "namespace")) {
		return {
			name,
			detail: formatInputEntries(parseGatewayArguments(args.args), expanded),
		};
	}

	return { name, detail: formatInputEntries(args, expanded) };
}

function parseJsonEntries(
	content: string,
	limits: { maxChars: number; maxKeys: number },
): [string, unknown][] | undefined {
	const trimmed = content.trim();
	if (!trimmed || trimmed.length > limits.maxChars || trimmed[0] !== "{") return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isRecord(parsed)) return undefined;
		const entries = Object.entries(parsed);
		if (entries.length === 0 || entries.length > limits.maxKeys) return undefined;
		return entries;
	} catch {
		return undefined;
	}
}

export function tryFlattenMcpJson(content: string): [string, string][] | undefined {
	const entries = parseJsonEntries(content, {
		maxChars: MAX_FLAT_JSON_CHARS,
		maxKeys: MAX_FLAT_JSON_KEYS,
	});
	if (!entries) return undefined;

	const result: [string, string][] = [];
	for (const [key, value] of entries) {
		if (typeof value === "string") {
			result.push([key, value]);
		} else if (value === null || typeof value === "number" || typeof value === "boolean") {
			result.push([key, String(value)]);
		} else if (isObject(value)) {
			const compact = safeJsonStringify(value);
			if (compact.length > 120) return undefined;
			result.push([key, compact]);
		} else {
			return undefined;
		}
	}
	return result;
}

export function tryUnwrapMcpTextPayload(
	content: string,
): { body: string; extras: [string, string][] } | undefined {
	const entries = parseJsonEntries(content, {
		maxChars: MAX_JSON_PARSE_CHARS,
		maxKeys: 4,
	});
	if (!entries) return undefined;

	let body: string | undefined;
	const extras: [string, string][] = [];
	for (const [key, value] of entries) {
		if (typeof value === "string") {
			const trimmed = value.trimEnd();
			const dominant = trimmed.length > UNWRAP_MIN_STRING_LEN
				|| (trimmed.includes("\n") && trimmed.length > 50);
			if (dominant) {
				if (body !== undefined) return undefined;
				body = trimmed;
				continue;
			}
			if (trimmed.length > 150) return undefined;
			extras.push([key, trimmed.replace(/\s+/g, " ")]);
		} else if (value === null || typeof value === "number" || typeof value === "boolean") {
			extras.push([key, String(value)]);
		} else {
			return undefined;
		}
	}
	return body === undefined ? undefined : { body, extras };
}

function visibleLines(value: string): string[] {
	if (!value) return [];
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	if (value.endsWith("\n")) lines.pop();
	return lines;
}

function formatMcpTextOutput(content: string): string[] {
	const unwrapped = tryUnwrapMcpTextPayload(content);
	if (unwrapped) {
		return [
			...(unwrapped.extras.length > 0
				? [unwrapped.extras.map(([key, value]) => `${key}: ${value}`).join(" · ")]
				: []),
			...visibleLines(unwrapped.body),
		];
	}

	const flat = tryFlattenMcpJson(content);
	if (flat) {
		const maxKeyWidth = Math.max(...flat.map(([key]) => visibleWidth(key)));
		return flat.flatMap(([key, value]) => {
			const keyPadding = " ".repeat(Math.max(0, maxKeyWidth - visibleWidth(key)));
			const valueLines = visibleLines(value);
			if (valueLines.length === 0) return [`${key}${keyPadding}: `];
			const continuationPadding = " ".repeat(maxKeyWidth + 2);
			return [
				`${key}${keyPadding}: ${valueLines[0]}`,
				...valueLines.slice(1).map((line) => `${continuationPadding}${line}`),
			];
		});
	}

	return visibleLines(content);
}

function collapseMcpResult(lines: string[], expanded: boolean): string[] {
	if (expanded || lines.length <= MCP_RESULT_LINES) return lines;
	const hidden = lines.length - MCP_RESULT_LINES;
	return [
		...lines.slice(0, MCP_RESULT_LINES),
		`… +${hidden} ${hidden === 1 ? "line" : "lines"} ${EXPAND_HINT}`,
	];
}

function estimateTextTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

export function formatClaudeMcpToolResult(
	resultValue: unknown,
	status: ClaudeToolStatus,
	expanded = false,
): string[] {
	if (status === "pending") return [];
	if (status === "running") return ["Running…"];

	const result = isRecord(resultValue) ? resultValue as ToolResultLike : undefined;
	const text = stripAnsi(textOutputRaw(result));
	const lines: string[] = [];
	const estimatedTokens = estimateTextTokens(text);
	if (estimatedTokens > MCP_OUTPUT_WARNING_THRESHOLD_TOKENS) {
		lines.push(`⚠ Large MCP response (~${estimatedTokens.toLocaleString("en-US")} tokens), this can fill up context quickly`);
	}
	lines.push(...formatMcpTextOutput(text));

	const imageCount = result?.content?.filter((block) => block.type === "image").length ?? 0;
	for (let index = 0; index < imageCount; index++) lines.push("[Image]");
	if (lines.length === 0) lines.push("(No content)");
	return collapseMcpResult(lines, expanded);
}
