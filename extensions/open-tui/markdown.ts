import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "./utils.ts";

interface MutableContainer extends Component {
	children: Component[];
}

interface AssistantInternals {
	contentContainer?: unknown;
}

export interface AssistantPrototype {
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
	renderToken?: RenderToken;
}

interface PatchedMarkdownPrototype extends MarkdownInternals {
	renderToken: RenderToken;
}

interface PrototypePatch {
	previous: RenderToken;
	patched: RenderToken;
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
	prototypePatches: Map<PatchedMarkdownPrototype, PrototypePatch>,
): void {
	// Do not patch the Markdown class imported by the extension. Pi may load the
	// extension through a different module graph than the interactive renderer.
	// Instead, discover the prototype from the concrete Markdown instance that
	// AssistantMessageComponent just created and patch that exact runtime class.
	const prototype = Object.getPrototypeOf(component) as MarkdownInternals | null;
	if (!prototype || typeof prototype.renderToken !== "function") return;

	const runtimePrototype = prototype as PatchedMarkdownPrototype;
	if (prototypePatches.has(runtimePrototype)) return;

	const previousRenderToken = runtimePrototype.renderToken;
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

	runtimePrototype.renderToken = patchedRenderToken;
	prototypePatches.set(runtimePrototype, {
		previous: previousRenderToken,
		patched: patchedRenderToken,
	});
}

function markAssistantMarkdown(
	component: AssistantInternals,
	assistantMarkdown: WeakSet<object>,
	prototypePatches: Map<PatchedMarkdownPrototype, PrototypePatch>,
): void {
	if (!isMutableContainer(component.contentContainer)) return;
	for (const child of component.contentContainer.children) {
		if (!isMarkdownComponent(child)) continue;
		assistantMarkdown.add(child as object);
		patchRuntimeMarkdownPrototype(child, assistantMarkdown, prototypePatches);
	}
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
export function installClaudeStyleMarkdown(
	assistantPrototype: AssistantPrototype = AssistantMessageComponent.prototype,
): () => void {
	const assistantMarkdown = new WeakSet<object>();
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
		previousUpdateContent.call(this, message, isStreaming);
		try {
			markAssistantMarkdown(this, assistantMarkdown, prototypePatches);
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
			if (prototype.renderToken === patch.patched) {
				prototype.renderToken = patch.previous;
			}
		}
		prototypePatches.clear();

		if (assistantPrototype.updateContent === patchedUpdateContent) {
			assistantPrototype.updateContent = previousUpdateContent;
		}
	};
}
