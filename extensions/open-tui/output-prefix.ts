import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./utils.ts";

const ASSISTANT_DOT = "●";
const THINKING_MARK = "∴";
const PREFIX_GAP = " ";
const RGB_RESET = "\x1b[39m";

const TOOL_COLORS = {
	preparing: [153, 153, 153],
	running: [215, 119, 87],
	success: [78, 186, 101],
	failure: [255, 107, 128],
} as const;

type PrefixKind = "thinking" | "text";
export type ToolExecutionStatus = keyof typeof TOOL_COLORS;

interface MutableContainer extends Component {
	children: Component[];
}

interface AssistantInternals {
	contentContainer?: unknown;
	hideThinkingBlock?: unknown;
}

interface RenderRequester {
	requestRender(): void;
}

interface ToolInternals {
	children?: unknown;
	contentBox?: unknown;
	contentText?: unknown;
	selfRenderContainer?: unknown;
	builtInToolDefinition?: unknown;
	toolDefinition?: unknown;
	isPartial?: unknown;
	executionStarted?: unknown;
	result?: unknown;
	ui?: unknown;
}

export interface AssistantPrototype {
	updateContent(message: AssistantMessage, isStreaming?: boolean): void;
}

export interface ToolPrototype {
	render(width: number): string[];
}

export interface OutputPrefixOptions {
	blink?: ToolBlinkController;
	assistantPrototype?: AssistantPrototype;
	toolPrototype?: ToolPrototype;
}

export interface BlinkScheduler {
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

const defaultBlinkScheduler: BlinkScheduler = {
	setInterval: (callback, delayMs) => setInterval(callback, delayMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function rgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RGB_RESET}`;
}

function leadingSgr(line: string): string {
	return line.match(/^(?:\x1b\[[0-9;:]*m)+/)?.[0] ?? "";
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

class ComponentGroup implements Component {
	private readonly children: readonly Component[];

	constructor(children: readonly Component[]) {
		this.children = children;
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}
}

export class PrefixComponent implements Component {
	private readonly child: Component;
	private readonly getPrefix: () => string;
	private readonly inheritLeadingStyle: boolean;
	private readonly slotWidth: number;

	constructor(
		child: Component,
		getPrefix: () => string,
		inheritLeadingStyle = false,
	) {
		this.child = child;
		this.getPrefix = getPrefix;
		this.inheritLeadingStyle = inheritLeadingStyle;
		this.slotWidth = visibleWidth(ASSISTANT_DOT + PREFIX_GAP);
	}

	render(width: number): string[] {
		if (width <= this.slotWidth) return this.child.render(width);

		const contentWidth = width - this.slotWidth;
		const lines = this.child.render(contentWidth);
		const firstTextLine = lines.findIndex(hasVisibleText);
		if (firstTextLine === -1) {
			// Image-only components keep their original width and layout.
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
			const inherited = this.inheritLeadingStyle ? leadingSgr(line) : "";
			return inherited + slot + line;
		});
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export class ToolBlinkController {
	private readonly scheduler: BlinkScheduler;
	private readonly running = new Map<object, RenderRequester>();
	private interval: unknown;
	private lit = true;

	constructor(scheduler: BlinkScheduler = defaultBlinkScheduler) {
		this.scheduler = scheduler;
	}

	isLit(): boolean {
		return this.lit;
	}

	runningCount(): number {
		return this.running.size;
	}

	sync(component: object, requester: RenderRequester, isRunning: boolean): void {
		if (!isRunning) {
			this.remove(component);
			return;
		}

		const startsBatch = this.running.size === 0;
		this.running.set(component, requester);
		if (startsBatch) {
			this.lit = true;
			this.interval = this.scheduler.setInterval(() => this.tick(), 600);
			(this.interval as { unref?: () => void } | undefined)?.unref?.();
		}
	}

	remove(component: object): void {
		if (!this.running.delete(component) || this.running.size > 0) return;
		this.stopInterval();
		this.lit = true;
	}

	dispose(): void {
		this.running.clear();
		this.stopInterval();
		this.lit = true;
	}

	private tick(): void {
		if (this.running.size === 0) {
			this.stopInterval();
			this.lit = true;
			return;
		}

		this.lit = !this.lit;
		const requesters = new Set(this.running.values());
		for (const requester of requesters) {
			try {
				requester.requestRender();
			} catch {
				// One disposed TUI must not stop the shared blink timer for the others.
			}
		}
	}

	private stopInterval(): void {
		if (this.interval === undefined) return;
		this.scheduler.clearInterval(this.interval);
		this.interval = undefined;
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

function decorateAssistant(
	component: AssistantInternals,
	message: AssistantMessage,
	getTheme: () => Theme,
): void {
	if (!isMutableContainer(component.contentContainer)) return;
	if (typeof component.hideThinkingBlock !== "boolean") return;

	const kinds = assistantBlockKinds(message, component.hideThinkingBlock);
	const markdownChildren = component.contentContainer.children.filter(isMarkdownComponent);
	if (markdownChildren.length !== kinds.length) return;

	let markdownIndex = 0;
	component.contentContainer.children = component.contentContainer.children.map((child) => {
		if (!isMarkdownComponent(child)) return child;
		const kind = kinds[markdownIndex++];
		if (kind === "thinking") {
			return new PrefixComponent(child, () => thinkingPrefix(getTheme));
		}
		return new PrefixComponent(child, () => rgb(255, 255, 255, ASSISTANT_DOT));
	});
}

export function parseToolExecutionStatus(value: unknown): ToolExecutionStatus | undefined {
	if (!value || typeof value !== "object") return undefined;
	const tool = value as ToolInternals;
	if (typeof tool.isPartial !== "boolean" || typeof tool.executionStarted !== "boolean") {
		return undefined;
	}

	if (tool.result !== undefined && tool.isPartial === false) {
		if (!tool.result || typeof tool.result !== "object") return undefined;
		const isError = (tool.result as { isError?: unknown }).isError;
		if (typeof isError !== "boolean") return undefined;
		return isError ? "failure" : "success";
	}
	if (tool.executionStarted) return "running";
	return "preparing";
}

function isRenderRequester(value: unknown): value is RenderRequester {
	return !!value
		&& typeof value === "object"
		&& typeof (value as { requestRender?: unknown }).requestRender === "function";
}

function toolPrefix(status: ToolExecutionStatus, blink: ToolBlinkController): string {
	if (status === "running" && !blink.isLit()) return " ";
	const [r, g, b] = TOOL_COLORS[status];
	return rgb(r, g, b, ASSISTANT_DOT);
}

interface TemporaryPrefixTarget {
	container: MutableContainer;
	children: Component[];
	inheritLeadingStyle: boolean;
}

function findToolPrefixTarget(tool: ToolInternals): TemporaryPrefixTarget | undefined {
	if (!isMutableContainer(tool)) return undefined;
	const container = tool as ToolInternals & MutableContainer;
	if (isMutableContainer(container.contentBox) && container.children.includes(container.contentBox)) {
		return {
			container: container.contentBox,
			children: container.contentBox.children,
			inheritLeadingStyle: false,
		};
	}
	if (
		isMutableContainer(container.selfRenderContainer)
		&& container.children.includes(container.selfRenderContainer)
	) {
		return {
			container: container.selfRenderContainer,
			children: container.selfRenderContainer.children,
			inheritLeadingStyle: true,
		};
	}
	if (isComponent(container.contentText)) {
		const index = container.children.indexOf(container.contentText);
		if (index !== -1) {
			return {
				container,
				children: [container.contentText],
				inheritLeadingStyle: true,
			};
		}
	}
	return undefined;
}

function renderToolWithPrefix(
	tool: ToolInternals,
	status: ToolExecutionStatus,
	blink: ToolBlinkController,
	width: number,
	renderOriginal: (width: number) => string[],
): string[] {
	const target = findToolPrefixTarget(tool);
	if (!target) return renderOriginal(width);

	const originalChildren = target.container.children;
	const grouped = new ComponentGroup(target.children);
	const prefixed = new PrefixComponent(
		grouped,
		() => toolPrefix(status, blink),
		target.inheritLeadingStyle,
	);

	if (target.container === tool) {
		const content = target.children[0]!;
		target.container.children = originalChildren.map((child) => child === content ? prefixed : child);
	} else {
		target.container.children = [prefixed];
	}

	try {
		return renderOriginal(width);
	} finally {
		target.container.children = originalChildren;
	}
}

export function installAssistantPrefixes(
	getTheme: () => Theme,
	prototype: AssistantPrototype = AssistantMessageComponent.prototype,
): () => void {
	const previousUpdateContent = prototype.updateContent;
	const prefixedUpdateContent = function (
		this: AssistantInternals,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		previousUpdateContent.call(this, message, isStreaming);
		try {
			decorateAssistant(this, message, getTheme);
		} catch {
			// Unknown future component internals keep pi's original rendering.
		}
	};

	prototype.updateContent = prefixedUpdateContent;
	return () => {
		if (prototype.updateContent === prefixedUpdateContent) {
			prototype.updateContent = previousUpdateContent;
		}
	};
}

export function installToolPrefixes(
	blink: ToolBlinkController,
	prototype: ToolPrototype = ToolExecutionComponent.prototype,
): () => void {
	const previousRender = prototype.render;
	const prefixedRender = function (this: ToolInternals, width: number): string[] {
		const renderOriginal = (renderWidth: number) => previousRender.call(this, renderWidth);
		const status = parseToolExecutionStatus(this);
		if (!status || !isRenderRequester(this.ui)) {
			if (typeof this === "object" && this) blink.remove(this);
			return renderOriginal(width);
		}

		blink.sync(this, this.ui, status === "running");
		try {
			return renderToolWithPrefix(this, status, blink, width, renderOriginal);
		} catch {
			return renderOriginal(width);
		}
	};

	prototype.render = prefixedRender;
	return () => {
		if (prototype.render === prefixedRender) {
			prototype.render = previousRender;
		}
	};
}

export function installOutputPrefixes(
	getTheme: () => Theme,
	options: OutputPrefixOptions = {},
): () => void {
	const blink = options.blink ?? new ToolBlinkController();
	const cleanupAssistant = installAssistantPrefixes(getTheme, options.assistantPrototype);
	const cleanupTools = installToolPrefixes(blink, options.toolPrototype);
	let cleaned = false;

	return () => {
		if (cleaned) return;
		cleaned = true;
		cleanupTools();
		cleanupAssistant();
		blink.dispose();
	};
}
