import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ClaudeToolBlinkController,
	installClaudeToolRenderer,
	type ToolPrototype,
} from "./claude-tool-renderer.ts";
import { stripAnsi } from "./utils.ts";

const ASSISTANT_DOT = "●";
const THINKING_MARK = "∴";
const PREFIX_GAP = " ";
const RGB_RESET = "\x1b[39m";

type PrefixKind = "thinking" | "text";

interface MutableContainer extends Component {
	children: Component[];
}

interface AssistantInternals {
	contentContainer?: unknown;
	hideThinkingBlock?: unknown;
	lastMessage?: unknown;
}

export interface AssistantPrototype {
	render(width: number): string[];
}

export interface OutputPrefixOptions {
	blink?: ClaudeToolBlinkController;
	assistantPrototype?: AssistantPrototype;
	toolPrototype?: ToolPrototype;
}

function rgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RGB_RESET}`;
}

function isComponent(value: unknown): value is Component {
	return !!value
		&& typeof value === "object"
		&& typeof (value as { render?: unknown }).render === "function"
		&& typeof (value as { invalidate?: unknown }).invalidate === "function";
}

function isMutableContainer(value: unknown): value is MutableContainer {
	if (!isComponent(value)) return false;
	const children = (value as unknown as { children?: unknown }).children;
	return Array.isArray(children) && children.every(isComponent);
}

function isMarkdownComponent(value: Component): boolean {
	return value.constructor.name === "Markdown"
		&& typeof (value as Component & { setText?: unknown }).setText === "function";
}

function hasVisibleText(line: string): boolean {
	return stripAnsi(line).trim().length > 0;
}

export class PrefixComponent implements Component {
	private readonly child: Component;
	private readonly getPrefix: () => string;
	private readonly slotWidth: number;

	constructor(child: Component, getPrefix: () => string) {
		this.child = child;
		this.getPrefix = getPrefix;
		this.slotWidth = visibleWidth(ASSISTANT_DOT + PREFIX_GAP);
	}

	render(width: number): string[] {
		if (width <= this.slotWidth) return this.child.render(width);

		const contentWidth = width - this.slotWidth;
		const lines = this.child.render(contentWidth);
		const firstTextLine = lines.findIndex(hasVisibleText);
		if (firstTextLine === -1) {
			return this.child.render(width);
		}

		return lines.map((line, index) => {
			let slot = " ".repeat(this.slotWidth);
			if (index === firstTextLine) {
				try {
					const prefix = this.getPrefix();
					const gap = Math.max(0, this.slotWidth - visibleWidth(prefix));
					slot = prefix + " ".repeat(gap);
				} catch {
					// Keep the reserved slot if a dynamically supplied theme is unavailable.
				}
			}
			return slot + line;
		});
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

function assistantBlockKinds(message: AssistantMessage, hideThinkingBlock: boolean): PrefixKind[] {
	const kinds: PrefixKind[] = [];
	for (let i = 0; i < message.content.length; i++) {
		const content = message.content[i]!;
		if (content.type === "text") {
			if (content.text.trim()) kinds.push("text");
			continue;
		}
		if (content.type !== "thinking") continue;

		let hasVisibleThinking = false;
		for (; i < message.content.length; i++) {
			const thinking = message.content[i]!;
			if (thinking.type !== "thinking") break;
			if (thinking.thinking.trim()) hasVisibleThinking = true;
		}
		i--;
		if (hasVisibleThinking && !hideThinkingBlock) kinds.push("thinking");
	}
	return kinds;
}

function thinkingPrefix(getTheme: () => Theme): string {
	const currentTheme = getTheme();
	return currentTheme.italic(currentTheme.fg("thinkingText", THINKING_MARK));
}

function renderAssistantWithPrefixes(
	component: AssistantInternals,
	message: AssistantMessage,
	getTheme: () => Theme,
	width: number,
	renderOriginal: (width: number) => string[],
): string[] {
	if (!isMutableContainer(component.contentContainer)) return renderOriginal(width);
	if (typeof component.hideThinkingBlock !== "boolean") return renderOriginal(width);

	const kinds = assistantBlockKinds(message, component.hideThinkingBlock);
	const markdownChildren = component.contentContainer.children.filter(isMarkdownComponent);
	if (markdownChildren.length !== kinds.length) return renderOriginal(width);

	const originalChildren = component.contentContainer.children;
	let markdownIndex = 0;
	component.contentContainer.children = component.contentContainer.children.map((child) => {
		if (!isMarkdownComponent(child)) return child;
		const kind = kinds[markdownIndex++];
		if (kind === "thinking") {
			return new PrefixComponent(child, () => thinkingPrefix(getTheme));
		}
		return new PrefixComponent(child, () => rgb(255, 255, 255, ASSISTANT_DOT));
	});

	try {
		return renderOriginal(width);
	} finally {
		component.contentContainer.children = originalChildren;
	}
}

export function installAssistantPrefixes(
	getTheme: () => Theme,
	prototype: AssistantPrototype = AssistantMessageComponent.prototype,
): () => void {
	const previousRender = prototype.render;
	const prefixedRender = function (this: AssistantInternals, width: number): string[] {
		const renderOriginal = (renderWidth: number) => previousRender.call(this, renderWidth);
		if (!this.lastMessage || typeof this.lastMessage !== "object") {
			return renderOriginal(width);
		}
		try {
			return renderAssistantWithPrefixes(
				this,
				this.lastMessage as AssistantMessage,
				getTheme,
				width,
				renderOriginal,
			);
		} catch {
			return renderOriginal(width);
		}
	};

	prototype.render = prefixedRender;
	return () => {
		if (prototype.render === prefixedRender) prototype.render = previousRender;
	};
}

export function installOutputPrefixes(
	getTheme: () => Theme,
	options: OutputPrefixOptions = {},
): () => void {
	const cleanupAssistant = installAssistantPrefixes(getTheme, options.assistantPrototype);
	const cleanupTools = installClaudeToolRenderer(getTheme, {
		blink: options.blink,
		prototype: options.toolPrototype,
	});
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		cleanupTools();
		cleanupAssistant();
	};
}

export { ClaudeToolBlinkController as ToolBlinkController } from "./claude-tool-renderer.ts";
