import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "./utils.ts";

interface MutableContainer extends Component {
	children: Component[];
}

interface AssistantInternals {
	contentContainer?: unknown;
}

interface AssistantPrototype {
	updateContent(message: AssistantMessage, isStreaming?: boolean): void;
}

type MarkdownToken = {
	type?: string;
};

type RenderToken = (
	this: MarkdownInternals,
	token: MarkdownToken,
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

interface MarkdownInternals {
	renderToken: RenderToken;
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

function markAssistantMarkdown(component: AssistantInternals, markdown: WeakSet<object>): void {
	if (!isMutableContainer(component.contentContainer)) return;
	for (const child of component.contentContainer.children) {
		if (isMarkdownComponent(child)) markdown.add(child as object);
	}
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

/**
 * Make assistant fenced code blocks render like Claude Code: keep Pi's native
 * Markdown parsing, language detection, syntax highlighting, wrapping, and
 * spacing, but omit the literal opening/closing triple-backtick fence lines.
 *
 * The patch is intentionally scoped to Markdown components created by
 * AssistantMessageComponent, so standalone/user/extension Markdown keeps Pi's
 * upstream rendering behavior.
 */
export function installClaudeStyleMarkdown(): () => void {
	const assistantMarkdown = new WeakSet<object>();
	const assistantPrototype = AssistantMessageComponent.prototype as unknown as AssistantPrototype;
	const markdownPrototype = Markdown.prototype as unknown as MarkdownInternals;
	const previousUpdateContent = assistantPrototype.updateContent;
	const previousRenderToken = markdownPrototype.renderToken;

	// Pi currently exposes renderToken as a normal prototype method even though
	// it is private in TypeScript. If a future Pi release changes that internal,
	// fail open and preserve upstream rendering rather than breaking the TUI.
	if (typeof previousUpdateContent !== "function" || typeof previousRenderToken !== "function") {
		return () => {};
	}

	const patchedUpdateContent = function (
		this: AssistantInternals,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		previousUpdateContent.call(this, message, isStreaming);
		try {
			markAssistantMarkdown(this, assistantMarkdown);
		} catch {
			// Unknown future assistant internals keep Pi's original rendering.
		}
	};

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

	assistantPrototype.updateContent = patchedUpdateContent;
	markdownPrototype.renderToken = patchedRenderToken;

	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		if (markdownPrototype.renderToken === patchedRenderToken) {
			markdownPrototype.renderToken = previousRenderToken;
		}
		if (assistantPrototype.updateContent === patchedUpdateContent) {
			assistantPrototype.updateContent = previousUpdateContent;
		}
	};
}
