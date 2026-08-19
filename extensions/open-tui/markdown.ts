import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "./utils.ts";

interface MutableContainer extends Component {
	children: Component[];
}

interface AssistantInternals {
	contentContainer?: unknown;
	isStreaming?: boolean;
}

export interface AssistantPrototype {
	updateContent(message: AssistantMessage, isStreaming?: boolean): void;
}

type MarkdownToken = {
	type?: string;
	text?: string;
	raw?: string;
	tokens?: MarkdownToken[];
};

type RenderToken = (
	this: MarkdownInternals,
	token: MarkdownToken,
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

type RenderInlineTokens = (
	this: MarkdownInternals,
	tokens: MarkdownToken[],
	styleContext?: unknown,
) => string;

interface MarkdownInternals {
	renderToken?: RenderToken;
	renderInlineTokens?: RenderInlineTokens;
}

type PatchedMarkdownPrototype = MarkdownInternals;

interface PrototypePatch {
	previousRenderToken?: RenderToken;
	patchedRenderToken?: RenderToken;
	previousRenderInlineTokens?: RenderInlineTokens;
	patchedRenderInlineTokens?: RenderInlineTokens;
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

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDestination(text: string, openingIndex: number): number {
	let depth = 0;
	for (let index = openingIndex; index < text.length; index++) {
		const character = text[index];
		if (character === "\\") {
			index++;
			continue;
		}
		if (character === "(") {
			depth++;
			continue;
		}
		if (character === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function findClosingReference(text: string, openingIndex: number): number {
	for (let index = openingIndex + 1; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}
		if (text[index] === "]") return index;
	}
	return -1;
}

function findUnstableLinkTextStart(text: string): number | undefined {
	const bracketStack: number[] = [];

	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}

		if (text[index] === "[") {
			const syntaxStart = index > 0 && text[index - 1] === "!" && !isEscaped(text, index - 1)
				? index - 1
				: index;
			bracketStack.push(syntaxStart);
			continue;
		}

		if (text[index] !== "]" || bracketStack.length === 0) continue;

		const syntaxStart = bracketStack.pop()!;
		const unstableStart = bracketStack[0] ?? syntaxStart;
		const nextIndex = index + 1;
		if (nextIndex >= text.length) return unstableStart;

		if (text[nextIndex] === "(") {
			const closingIndex = findClosingDestination(text, nextIndex);
			if (closingIndex < 0) return unstableStart;
			index = closingIndex;
			continue;
		}

		if (text[nextIndex] === "[") {
			const closingIndex = findClosingReference(text, nextIndex);
			if (closingIndex < 0) return unstableStart;
			index = closingIndex;
		}
	}

	return bracketStack[0];
}

/**
 * Remove an ambiguous link-shaped suffix from a streaming plain-text token.
 * Marked emits incomplete Markdown links as text, then replaces that text with
 * a much shorter link token when the closing delimiter arrives.
 */
export function stabilizeStreamingLinkText(text: string): string {
	const unstableStart = findUnstableLinkTextStart(text);
	return unstableStart === undefined ? text : text.slice(0, unstableStart);
}

function stabilizeStreamingInlineTokens(tokens: MarkdownToken[]): MarkdownToken[] {
	let changed = false;
	const lastIndex = tokens.length - 1;
	const stabilized = tokens.map((token, index) => {
		if (token.type === "link") {
			changed = true;
			return { ...token, type: "text" };
		}

		if (
			index === lastIndex
			&& token.type === "text"
			&& !token.tokens?.length
			&& typeof token.text === "string"
		) {
			const text = stabilizeStreamingLinkText(token.text);
			if (text !== token.text) {
				changed = true;
				return { ...token, text };
			}
		}

		return token;
	});
	return changed ? stabilized : tokens;
}

function stripRenderedCodeFences(lines: string[]): string[] {
	if (lines.length === 0) return lines;

	const result = [...lines];
	const opening = result[0];
	if (opening && stripAnsi(opening).trim().startsWith("```")) {
		result.shift();
	}

	// Pi appends an optional blank spacer after the closing fence, so scan
	// backwards to the last visible line instead of assuming a fixed index.
	for (let i = result.length - 1; i >= 0; i--) {
		const plain = stripAnsi(result[i] ?? "").trim();
		if (!plain) continue;
		if (plain === "```") result.splice(i, 1);
		break;
	}

	return result;
}

function patchRuntimeMarkdownPrototype(
	component: Component,
	assistantMarkdown: WeakSet<object>,
	streamingAssistantMarkdown: WeakSet<object>,
	prototypePatches: Map<PatchedMarkdownPrototype, PrototypePatch>,
): void {
	// Do not patch the Markdown class imported by the extension. Pi may load the
	// extension through a different module graph than the interactive renderer.
	// Instead, discover the prototype from the concrete Markdown instance that
	// AssistantMessageComponent just created and patch that exact runtime class.
	const prototype = Object.getPrototypeOf(component) as MarkdownInternals | null;
	if (!prototype || prototypePatches.has(prototype)) return;

	const patch: PrototypePatch = {};
	if (typeof prototype.renderToken === "function") {
		const previousRenderToken = prototype.renderToken;
		const patchedRenderToken: RenderToken = function (
			this: MarkdownInternals,
			token: MarkdownToken,
			width: number,
			nextTokenType?: string,
			styleContext?: unknown,
		): string[] {
			const lines = previousRenderToken.call(this, token, width, nextTokenType, styleContext);
			if (token.type !== "code" || !assistantMarkdown.has(this as object)) return lines;
			return stripRenderedCodeFences(lines);
		};
		prototype.renderToken = patchedRenderToken;
		patch.previousRenderToken = previousRenderToken;
		patch.patchedRenderToken = patchedRenderToken;
	}

	if (typeof prototype.renderInlineTokens === "function") {
		const previousRenderInlineTokens = prototype.renderInlineTokens;
		const patchedRenderInlineTokens: RenderInlineTokens = function (
			this: MarkdownInternals,
			tokens: MarkdownToken[],
			styleContext?: unknown,
		): string {
			const renderedTokens = streamingAssistantMarkdown.has(this as object)
				? stabilizeStreamingInlineTokens(tokens)
				: tokens;
			return previousRenderInlineTokens.call(this, renderedTokens, styleContext);
		};
		prototype.renderInlineTokens = patchedRenderInlineTokens;
		patch.previousRenderInlineTokens = previousRenderInlineTokens;
		patch.patchedRenderInlineTokens = patchedRenderInlineTokens;
	}

	if (patch.patchedRenderToken || patch.patchedRenderInlineTokens) {
		prototypePatches.set(prototype, patch);
	}
}

function markAssistantMarkdown(
	component: AssistantInternals,
	isStreaming: boolean,
	assistantMarkdown: WeakSet<object>,
	streamingAssistantMarkdown: WeakSet<object>,
	prototypePatches: Map<PatchedMarkdownPrototype, PrototypePatch>,
): void {
	if (!isMutableContainer(component.contentContainer)) return;
	for (const child of component.contentContainer.children) {
		if (!isMarkdownComponent(child)) continue;
		assistantMarkdown.add(child as object);
		if (isStreaming) streamingAssistantMarkdown.add(child as object);
		patchRuntimeMarkdownPrototype(child, assistantMarkdown, streamingAssistantMarkdown, prototypePatches);
	}
}

/**
 * Make assistant Markdown stream like Claude Code: keep incomplete link source
 * hidden, defer link underline/OSC 8 decoration until the message finalizes,
 * and omit literal fenced-code delimiter lines.
 *
 * The patch is intentionally scoped to Markdown components created by
 * AssistantMessageComponent, so standalone/user/extension Markdown keeps Pi's
 * upstream rendering behavior.
 */
export function installClaudeStyleMarkdown(
	assistantPrototype: AssistantPrototype = AssistantMessageComponent.prototype,
): () => void {
	const assistantMarkdown = new WeakSet<object>();
	const streamingAssistantMarkdown = new WeakSet<object>();
	const prototypePatches = new Map<PatchedMarkdownPrototype, PrototypePatch>();
	const previousUpdateContent = assistantPrototype.updateContent;

	if (typeof previousUpdateContent !== "function") {
		return () => {};
	}

	const patchedUpdateContent = function (
		this: AssistantInternals,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		const effectiveIsStreaming = isStreaming ?? this.isStreaming ?? false;
		previousUpdateContent.call(this, message, effectiveIsStreaming);
		try {
			markAssistantMarkdown(
				this,
				effectiveIsStreaming,
				assistantMarkdown,
				streamingAssistantMarkdown,
				prototypePatches,
			);
		} catch {
			// Unknown future assistant/Markdown internals keep Pi's original rendering.
		}
	};

	assistantPrototype.updateContent = patchedUpdateContent;

	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;

		for (const [prototype, patch] of prototypePatches) {
			if (patch.patchedRenderToken && prototype.renderToken === patch.patchedRenderToken) {
				prototype.renderToken = patch.previousRenderToken;
			}
			if (
				patch.patchedRenderInlineTokens
				&& prototype.renderInlineTokens === patch.patchedRenderInlineTokens
			) {
				prototype.renderInlineTokens = patch.previousRenderInlineTokens;
			}
		}
		prototypePatches.clear();

		if (assistantPrototype.updateContent === patchedUpdateContent) {
			assistantPrototype.updateContent = previousUpdateContent;
		}
	};
}
