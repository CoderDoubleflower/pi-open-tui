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

const STALL_THRESHOLD_MS = 1000;
const MIN_STREAM_UPDATES = 2;
const MIN_MEASUREMENT_MS = 200;

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
	firstOutputMs: number | null;
	streamUpdateCount: number;
	inStall: boolean;
}

interface MessageMeasurement {
	outputTokens: number;
	durationMs: number;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	measurements: MessageMeasurement[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
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

interface MeasuredTurn {
	telemetry: TurnTelemetry;
	measuredOutputTokens: number;
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
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: MeasuredTurn[] = [];

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
			measurements: [],
			generationMs: 0,
			stallMs: 0,
			stallCount: 0,
		};
	}

	private startMessage(message: AgentMessage): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		const now = this.now();
		this.turn.currentMessage = {
			startMs: now,
			lastUpdateMs: now,
			firstOutputMs: null,
			streamUpdateCount: 0,
			inStall: false,
		};
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
		if (current.firstOutputMs === null) {
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			current.streamUpdateCount = 1;
			current.lastUpdateMs = now;
			return;
		}

		current.streamUpdateCount++;

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
			const endMs = this.now();
			turn.generationMs += endMs - current.startMs;
			if (current.firstOutputMs === null && message.usage.output > 0) {
				turn.firstTokenMs ??= endMs;
			}
			const measurementMs = current.firstOutputMs === null ? 0 : endMs - current.firstOutputMs;
			if (
				message.usage.output > 0 &&
				current.streamUpdateCount >= MIN_STREAM_UPDATES &&
				measurementMs >= MIN_MEASUREMENT_MS
			) {
				turn.measurements.push({ outputTokens: message.usage.output, durationMs: measurementMs });
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message);
	}

	private endTurnAndCollect(): TurnTelemetry | undefined {
		const result = this.endTurn();
		if (result && this.agentStartMs !== null) this.agentTurns.push(result);
		return result?.telemetry;
	}

	private endTurn(): MeasuredTurn | undefined {
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

		const measuredOutputTokens = turn.measurements.reduce((sum, measurement) => sum + measurement.outputTokens, 0);
		const measuredMs = turn.measurements.reduce((sum, measurement) => sum + measurement.durationMs, 0);
		const measurementMs = measuredMs > 0 ? measuredMs : null;
		const tps = measurementMs === null
			? null
			: round(measuredOutputTokens / (measurementMs / 1000), 1);
		const validCost = Number.isFinite(costUsd) && costUsd > 0;
		const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
		return {
			telemetry: {
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
			},
			measuredOutputTokens,
		};
	}

	private endAgent(): TurnTelemetry | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.agentStartMs = null;
		this.agentTurns = [];
		if (startMs === null || turns.length === 0) return;

		const outputTokens = turns.reduce((sum, turn) => sum + turn.telemetry.outputTokens, 0);
		const inputTokens = turns.reduce((sum, turn) => sum + turn.telemetry.inputTokens, 0);
		const totalTokens = turns.reduce((sum, turn) => sum + turn.telemetry.totalTokens, 0);
		const costUsd = turns.reduce((sum, turn) => sum + turn.telemetry.costUsd, 0);
		const stallMs = turns.reduce((sum, turn) => sum + turn.telemetry.stallMs, 0);
		const stallCount = turns.reduce((sum, turn) => sum + turn.telemetry.stallCount, 0);
		const measuredOutputTokens = turns.reduce((sum, turn) => sum + turn.measuredOutputTokens, 0);
		const measuredMs = turns.reduce((sum, turn) => sum + (turn.telemetry.measurementMs ?? 0), 0);
		const measurementMs = measuredMs > 0 ? measuredMs : null;
		const tps = measurementMs === null
			? null
			: round(measuredOutputTokens / (measurementMs / 1000), 1);
		const validRate = costUsd > 0 && totalTokens > 0;
		return {
			tps,
			ttftMs: turns[0]!.telemetry.ttftMs,
			totalMs: this.now() - startMs,
			inputTokens,
			outputTokens,
			stallMs,
			stallCount,
			rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1_000_000), 2) : null,
			generationMs: turns.reduce((sum, turn) => sum + turn.telemetry.generationMs, 0),
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
		parts.push(theme.fg("accent", `${glyphs.input} ${fmtTokens(telemetry.inputTokens)}`));
		parts.push(theme.fg("success", `${glyphs.output} ${fmtTokens(telemetry.outputTokens)}`));
	}
	if (config.stalls && telemetry.stallMs > 0) {
		parts.push(theme.fg("warning", `${glyphs.stall} stall ${telemetry.stallCount}x / ${formatTurnDuration(telemetry.stallMs)}`));
	}
	if (config.cost && telemetry.rateUsdPerMTokens !== null) {
		parts.push(theme.fg("warning", `${glyphs.cost} $${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}
