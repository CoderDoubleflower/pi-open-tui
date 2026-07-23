import type {
	AgentSettledEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { IconMode, TelemetryConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";
import { fmtTokens, formatDuration } from "./utils.ts";

const STALL_THRESHOLD_MS = 500;
const MIN_STREAM_MS = 1;
const MIN_STREAM_UPDATES = 5;
const MIN_INTER_CHUNK_MS = 1;
const MIN_GENERATION_MS = 200;
const STALL_DOMINANCE_RATIO = 0.85;
const MAX_PLAUSIBLE_TPS = 10_000;

type TelemetryEvent =
	| AgentStartEvent
	| AgentSettledEvent
	| TurnStartEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| TurnEndEvent;
type AgentMessage = MessageStartEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface MessageTiming {
	startMs: number;
	lastUpdateMs: number;
	firstUpdateSeen: boolean;
	streamUpdateCount: number;
	firstStreamUpdateMs: number | null;
	lastStreamUpdateMs: number | null;
	inStall: boolean;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	generationMs: number;
	streamMs: number;
	streamIntervals: number;
	streamUpdateCount: number;
	stallMs: number;
	stallCount: number;
	isToolCall: boolean;
	modelKey: string | null;
}

export interface TurnTelemetry {
	tps: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	stallMs: number;
	stallCount: number;
	rateUsdPerMTokens: number | null;
	generationMs: number;
	totalTokens: number;
	costUsd: number;
	measurementMs: number | null;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export class TurnTelemetryTracker {
	private readonly now: () => number;
	private readonly tpsCaps = new Map<string, number>();
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnTelemetry[] = [];

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	handle(event: TelemetryEvent): TurnTelemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
				}
				return;
			case "agent_settled":
				return this.endAgent();
			case "turn_start":
				this.startTurn();
				return;
			case "message_start":
				this.startMessage(event.message);
				return;
			case "message_update":
				this.updateMessage(event);
				return;
			case "message_end":
				this.endMessage(event.message);
				return;
			case "tool_execution_start":
				if (this.turn) this.turn.isToolCall = true;
				return;
			case "turn_end":
				return this.endTurnAndCollect();
		}
	}

	private startTurn(): void {
		this.turn = {
			startMs: this.now(),
			firstTokenMs: null,
			currentMessage: null,
			messages: [],
			generationMs: 0,
			streamMs: 0,
			streamIntervals: 0,
			streamUpdateCount: 0,
			stallMs: 0,
			stallCount: 0,
			isToolCall: false,
			modelKey: null,
		};
	}

	private startMessage(message: AgentMessage): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		const now = this.now();
		this.turn.currentMessage = {
			startMs: now,
			lastUpdateMs: now,
			firstUpdateSeen: false,
			streamUpdateCount: 0,
			firstStreamUpdateMs: null,
			lastStreamUpdateMs: null,
			inStall: false,
		};
		this.turn.modelKey ??= `${message.provider}:${message.model}`;
	}

	private updateMessage(event: MessageUpdateEvent): void {
		const turn = this.turn;
		const current = turn?.currentMessage;
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) return;
		if (streamEvent.delta.length === 0) return;
		const message = event.message;
		if (!turn || !current || !isAssistantMessage(message)) return;

		const now = this.now();
		if (!current.firstUpdateSeen) {
			current.firstUpdateSeen = true;
			turn.firstTokenMs ??= now;
			current.lastUpdateMs = now;
			return;
		}

		current.streamUpdateCount++;
		current.firstStreamUpdateMs ??= now;
		current.lastStreamUpdateMs = now;

		const gap = now - current.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!current.inStall) turn.stallCount++;
			current.inStall = true;
			turn.stallMs += gap;
		} else {
			current.inStall = false;
		}
		current.lastUpdateMs = now;
	}

	private endMessage(message: AgentMessage): void {
		const turn = this.turn;
		if (!turn || !isAssistantMessage(message)) return;

		const current = turn.currentMessage;
		if (current) {
			turn.generationMs += this.now() - current.startMs;
			turn.streamUpdateCount += current.streamUpdateCount;
			turn.streamIntervals += Math.max(0, current.streamUpdateCount - 1);
			// Sum per-message spans so tool execution between messages never enters TPS.
			if (current.firstStreamUpdateMs !== null && current.lastStreamUpdateMs !== null) {
				turn.streamMs += current.lastStreamUpdateMs - current.firstStreamUpdateMs;
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message);
		turn.modelKey ??= `${message.provider}:${message.model}`;
	}

	private endTurnAndCollect(): TurnTelemetry | undefined {
		const telemetry = this.endTurn();
		if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
		return telemetry;
	}

	private endTurn(): TurnTelemetry | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return;

		const endMs = this.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let totalTokens = 0;
		let costUsd = 0;
		for (const message of turn.messages) {
			inputTokens += message.usage.input;
			outputTokens += message.usage.output;
			totalTokens += message.usage.totalTokens;
			costUsd += message.usage.cost.total;
		}
		if (![inputTokens, outputTokens, totalTokens, costUsd].every(Number.isFinite)) {
			throw new Error("Invalid assistant usage in turn telemetry");
		}
		if (outputTokens <= 0 || !turn.modelKey) return;

		const streamMs = turn.streamUpdateCount > 0 ? turn.streamMs : null;
		const averageGapMs = turn.streamIntervals > 0 ? turn.streamMs / turn.streamIntervals : 0;
		let tps: number | null = null;
		let measurementMs: number | null = null;
		let primary = false;
		if (
			streamMs !== null &&
			streamMs >= MIN_STREAM_MS &&
			turn.streamUpdateCount >= MIN_STREAM_UPDATES &&
			averageGapMs >= MIN_INTER_CHUNK_MS &&
			turn.stallMs < streamMs &&
			streamMs - turn.stallMs >= MIN_GENERATION_MS &&
			turn.stallMs < streamMs - turn.stallMs
		) {
			measurementMs = streamMs - turn.stallMs;
			tps = round(outputTokens / (measurementMs / 1000), 1);
			primary = true;
		} else if (turn.streamUpdateCount >= 2 && turn.generationMs >= MIN_GENERATION_MS) {
			let activeMs = turn.generationMs - turn.stallMs;
			if (activeMs < MIN_GENERATION_MS || turn.stallMs > turn.generationMs * STALL_DOMINANCE_RATIO) {
				activeMs = turn.generationMs - turn.stallMs / 2;
			}
			measurementMs = Math.max(activeMs, MIN_GENERATION_MS);
			tps = round(outputTokens / (measurementMs / 1000), 1);
		}

		if (tps !== null && tps > MAX_PLAUSIBLE_TPS) {
			tps = null;
			measurementMs = null;
			primary = false;
		}
		if (primary && tps !== null) {
			this.tpsCaps.set(turn.modelKey, Math.max(tps, this.tpsCaps.get(turn.modelKey) ?? 0));
		}
		if (turn.isToolCall && tps !== null) {
			tps = this.tpsCaps.has(turn.modelKey)
				? Math.min(tps, this.tpsCaps.get(turn.modelKey)!)
				: null;
			if (tps === null) measurementMs = null;
		}

		const validCost = Number.isFinite(costUsd) && costUsd > 0;
		const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
		return {
			tps,
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: endMs - turn.startMs,
			inputTokens,
			outputTokens,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			rateUsdPerMTokens: validCost && validTokens
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs: turn.generationMs,
			totalTokens,
			costUsd: validCost ? costUsd : 0,
			measurementMs,
		};
	}

	private endAgent(): TurnTelemetry | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.agentStartMs = null;
		this.agentTurns = [];
		if (startMs === null || turns.length === 0) return;

		const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
		const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
		const stallMs = turns.reduce((sum, turn) => sum + turn.stallMs, 0);
		const stallCount = turns.reduce((sum, turn) => sum + turn.stallCount, 0);
		const measuredTurns = turns.filter((turn) => turn.measurementMs !== null);
		const measuredOutputTokens = measuredTurns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const measurementMs = measuredTurns.length > 0
			? measuredTurns.reduce((sum, turn) => sum + turn.measurementMs!, 0)
			: null;
		const tps =
			measurementMs !== null && measurementMs >= MIN_GENERATION_MS
				? round(measuredOutputTokens / (measurementMs / 1000), 1)
				: null;
		const boundedTps = tps !== null && tps <= MAX_PLAUSIBLE_TPS ? tps : null;
		const validRate = costUsd > 0 && totalTokens > 0;
		return {
			tps: boundedTps,
			ttftMs: turns[0]!.ttftMs,
			totalMs: this.now() - startMs,
			inputTokens,
			outputTokens,
			stallMs,
			stallCount,
			rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1_000_000), 2) : null,
			generationMs: turns.reduce((sum, turn) => sum + turn.generationMs, 0),
			totalTokens,
			costUsd,
			measurementMs,
		};
	}
}

function formatTurnDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

export function formatTurnTelemetry(
	telemetry: TurnTelemetry,
	theme: Theme,
	config: TelemetryConfig,
	iconMode: IconMode,
): string {
	const glyphs = resolveGlyphs(iconMode);
	const parts: string[] = [];
	if (config.tps) {
		const value = telemetry.tps === null ? "—" : `${telemetry.tps.toFixed(1)} tok/s`;
		parts.push(theme.fg(telemetry.tps === null ? "muted" : "accent", `${glyphs.speed} TPS ${value}`));
	}
	if (config.ttft) {
		parts.push(theme.fg("text", `${glyphs.latency} TTFT ${formatTurnDuration(telemetry.ttftMs)}`));
	}
	if (config.duration) {
		parts.push(theme.fg("success", `${glyphs.done} ${formatTurnDuration(telemetry.totalMs)}`));
	}
	if (config.tokens) {
		parts.push(theme.fg("accent", `${glyphs.input} in ${fmtTokens(telemetry.inputTokens)}`));
		parts.push(theme.fg("success", `${glyphs.output} out ${fmtTokens(telemetry.outputTokens)}`));
	}
	if (config.stalls && telemetry.stallMs > 0) {
		parts.push(theme.fg("warning", `${glyphs.stall} stall ${telemetry.stallCount}x / ${formatTurnDuration(telemetry.stallMs)}`));
	}
	if (config.cost && telemetry.rateUsdPerMTokens !== null) {
		parts.push(theme.fg("warning", `${glyphs.cost} $${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}
