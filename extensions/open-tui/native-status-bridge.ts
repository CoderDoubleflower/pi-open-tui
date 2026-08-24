import type { Component, TUI } from "@earendil-works/pi-tui";

export type NativeStatusKind = "working" | "retry" | "compaction" | "branchSummary";

export interface NativeRetryStatus {
	attempt: number;
	maxRetries: number;
	seconds: number;
}

export type NativeStatusPresentation =
	| {
		kind: "working";
		style: "working";
		message: string;
	}
	| {
		kind: "retry";
		style: "retry";
		retry: NativeRetryStatus | null;
	}
	| {
		kind: "retry" | "compaction" | "branchSummary";
		style: "system-requesting";
		message: "Compacting conversation…";
	};

export interface NativeStatusSink {
	nativeStatusStart(token: object, presentation: NativeStatusPresentation): void;
	nativeStatusUpdate(token: object, presentation: NativeStatusPresentation): void;
	nativeStatusEnd(token: object): void;
}

type ContainerLike = Component & {
	children: Component[];
	addChild(component: Component): void;
	clear(): void;
};

type StatusIndicatorLike = Component & {
	kind?: unknown;
	message?: unknown;
	setMessage?: (message: string) => void;
	dispose?: () => void;
};

const STATUS_KINDS = new Set<NativeStatusKind>([
	"working",
	"retry",
	"compaction",
	"branchSummary",
]);

const PI_RETRY_MESSAGE = /Retrying\s*\((\d+)\/(\d+)\)\s*in\s*(\d+)s/i;

export function parseNativeRetryStatus(message: string): NativeRetryStatus | null {
	const match = PI_RETRY_MESSAGE.exec(message);
	if (!match) return null;
	const attempt = Number.parseInt(match[1]!, 10);
	const maxRetries = Number.parseInt(match[2]!, 10);
	const seconds = Number.parseInt(match[3]!, 10);
	if (
		!Number.isSafeInteger(attempt)
		|| !Number.isSafeInteger(maxRetries)
		|| !Number.isSafeInteger(seconds)
		|| attempt < 1
		|| maxRetries < 1
		|| seconds < 0
	) return null;
	return { attempt, maxRetries, seconds };
}

export function formatClaudeRetryStatus(retry: NativeRetryStatus): string {
	return `Retrying in ${retry.seconds} ${retry.seconds === 1 ? "second" : "seconds"}… (attempt ${retry.attempt}/${retry.maxRetries})`;
}

function asContainer(component: Component | undefined): ContainerLike | undefined {
	if (!component) return undefined;
	const candidate = component as Partial<ContainerLike>;
	return Array.isArray(candidate.children)
		&& typeof candidate.addChild === "function"
		&& typeof candidate.clear === "function"
		? candidate as ContainerLike
		: undefined;
}

function nativeStatusKind(component: Component): NativeStatusKind | undefined {
	const kind = (component as StatusIndicatorLike).kind;
	return typeof kind === "string" && STATUS_KINDS.has(kind as NativeStatusKind)
		? kind as NativeStatusKind
		: undefined;
}

function isIdleStatus(component: Component): boolean {
	return component.constructor?.name === "IdleStatus";
}

function fallbackMessage(kind: NativeStatusKind): string {
	switch (kind) {
		case "working":
			return "Working...";
		case "retry":
			return "Retrying...";
		case "compaction":
			return "Compacting context...";
		case "branchSummary":
			return "Summarizing branch...";
	}
}

function statusMessage(component: StatusIndicatorLike, kind: NativeStatusKind): string {
	return typeof component.message === "string" && component.message.length > 0
		? component.message
		: fallbackMessage(kind);
}

function presentationFor(
	kind: NativeStatusKind,
	message: string,
	replacedKind?: NativeStatusKind,
): NativeStatusPresentation {
	if (kind === "compaction" || kind === "branchSummary") {
		return { kind, style: "system-requesting", message: "Compacting conversation…" };
	}
	if (kind === "retry") {
		// Pi also uses RetryStatusIndicator while compaction/branch summarization
		// retries. Claude Code keeps the system compaction spinner running for
		// those retries instead of switching to an API retry countdown.
		if (replacedKind === "compaction" || replacedKind === "branchSummary") {
			return { kind, style: "system-requesting", message: "Compacting conversation…" };
		}
		return { kind, style: "retry", retry: parseNativeRetryStatus(message) };
	}
	return { kind, style: "working", message };
}

/**
 * Suppress Pi's built-in status row and mirror supported status indicators into
 * the custom spinner widget using Claude Code's presentation semantics.
 *
 * Pi 0.84.x mounts the status container immediately before the above-editor
 * widget container. We discover that relationship from the widget instance
 * rather than relying on a fixed child index. If the component tree no longer
 * matches, the bridge fails open and Pi keeps rendering its native status UI.
 */
export function installNativeStatusBridge(
	tui: TUI,
	widget: Component,
	sink: NativeStatusSink,
): (() => void) | undefined {
	if (!Array.isArray(tui.children)) return undefined;
	const widgetContainerIndex = tui.children.findIndex((child) => asContainer(child)?.children.includes(widget));
	if (widgetContainerIndex <= 0) return undefined;

	const statusContainer = asContainer(tui.children[widgetContainerIndex - 1]);
	if (!statusContainer) return undefined;
	if (statusContainer.children.some((child) => nativeStatusKind(child) === undefined && !isIdleStatus(child))) {
		return undefined;
	}

	const hadOwnAddChild = Object.prototype.hasOwnProperty.call(statusContainer, "addChild");
	const originalAddChild = statusContainer.addChild;
	const activeIndicators = new Set<StatusIndicatorLike>();
	const restoreIndicatorMethods = new Map<StatusIndicatorLike, () => void>();
	let latestActiveIndicator: StatusIndicatorLike | undefined;
	let pendingReplacementKind: NativeStatusKind | undefined;
	let replacementGeneration = 0;
	let disposed = false;

	const rememberReplacementKind = (kind: NativeStatusKind): void => {
		pendingReplacementKind = kind;
		const generation = ++replacementGeneration;
		queueMicrotask(() => {
			if (replacementGeneration === generation) pendingReplacementKind = undefined;
		});
	};

	const consumeReplacementKind = (): NativeStatusKind | undefined => {
		const kind = pendingReplacementKind;
		pendingReplacementKind = undefined;
		replacementGeneration++;
		return kind;
	};

	const bindIndicator = (
		component: Component,
		kind: NativeStatusKind,
		replacedKind?: NativeStatusKind,
	): void => {
		const indicator = component as StatusIndicatorLike;
		if (restoreIndicatorMethods.has(indicator)) return;

		const hadOwnSetMessage = Object.prototype.hasOwnProperty.call(indicator, "setMessage");
		const originalSetMessage = indicator.setMessage;
		const hadOwnDispose = Object.prototype.hasOwnProperty.call(indicator, "dispose");
		const originalDispose = indicator.dispose;
		let active = true;
		let presentation = presentationFor(kind, statusMessage(indicator, kind), replacedKind);

		activeIndicators.add(indicator);
		latestActiveIndicator = indicator;
		sink.nativeStatusStart(indicator, presentation);

		if (typeof originalSetMessage === "function") {
			indicator.setMessage = function setMessage(message: string): void {
				originalSetMessage.call(this, message);
				if (!active) return;
				if (presentation.style === "retry") {
					presentation = presentationFor(kind, message);
				}
				sink.nativeStatusUpdate(indicator, presentation);
			};
		}

		const restore = () => {
			if (typeof originalSetMessage === "function") {
				if (hadOwnSetMessage) indicator.setMessage = originalSetMessage;
				else delete indicator.setMessage;
			}
			if (typeof originalDispose === "function") {
				if (hadOwnDispose) indicator.dispose = originalDispose;
				else delete indicator.dispose;
			}
		};
		restoreIndicatorMethods.set(indicator, restore);

		if (typeof originalDispose === "function") {
			indicator.dispose = function dispose(): void {
				try {
					originalDispose.call(this);
				} finally {
					if (active) {
						active = false;
						activeIndicators.delete(indicator);
						rememberReplacementKind(kind);
						sink.nativeStatusEnd(indicator);
					}
					restoreIndicatorMethods.get(indicator)?.();
					restoreIndicatorMethods.delete(indicator);
				}
			};
		}
	};

	for (const child of statusContainer.children) {
		const kind = nativeStatusKind(child);
		if (kind) bindIndicator(child, kind);
	}
	statusContainer.clear();

	statusContainer.addChild = function addChild(component: Component): void {
		const replacedKind = consumeReplacementKind();
		const kind = nativeStatusKind(component);
		if (kind) {
			bindIndicator(component, kind, replacedKind);
			return;
		}
		if (isIdleStatus(component)) return;
		// Unknown future status content: fail open rather than hiding information.
		originalAddChild.call(this, component);
	};

	return () => {
		if (disposed) return;
		disposed = true;

		if (hadOwnAddChild) statusContainer.addChild = originalAddChild;
		else delete (statusContainer as Partial<ContainerLike>).addChild;

		const indicatorToRestore = latestActiveIndicator && activeIndicators.has(latestActiveIndicator)
			? latestActiveIndicator
			: undefined;
		for (const indicator of activeIndicators) sink.nativeStatusEnd(indicator);
		for (const restore of restoreIndicatorMethods.values()) restore();
		activeIndicators.clear();
		restoreIndicatorMethods.clear();
		pendingReplacementKind = undefined;
		replacementGeneration++;

		// If the custom spinner is disabled in the middle of retry/compaction,
		// hand the still-live status component back to Pi immediately.
		if (indicatorToRestore) originalAddChild.call(statusContainer, indicatorToRestore);
	};
}
