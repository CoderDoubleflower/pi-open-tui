import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	installAssistantPrefixes,
	installOutputPrefixes,
	installToolPrefixes,
	parseToolExecutionStatus,
	PrefixComponent,
	ToolBlinkController,
	type BlinkScheduler,
} from "../extensions/open-tui/output-prefix.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const WHITE_DOT = "\x1b[38;2;255;255;255m●\x1b[39m";
const PREPARING_DOT = "\x1b[2m●\x1b[22m";
const RUNNING_DOT = "\x1b[2m●\x1b[22m";
const SUCCESS_DOT = "\x1b[38;2;78;186;101m●\x1b[39m";
const FAILURE_DOT = "\x1b[38;2;255;107;128m●\x1b[39m";

initTheme();

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason,
		timestamp: 1,
	};
}

function prefixTheme(r: number, g: number, b: number): Theme {
	return {
		fg: (color: string, text: string) => color === "thinkingText"
			? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
			: text,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	} as Theme;
}

function count(text: string, value: string): number {
	return text.split(value).length - 1;
}

class FakeScheduler implements BlinkScheduler {
	readonly callbacks = new Map<object, () => void>();
	readonly delays: number[] = [];
	readonly cleared: object[] = [];
	unrefCalls = 0;

	setInterval(callback: () => void, delayMs: number): object {
		const handle = {
			unref: () => this.unrefCalls++,
		};
		this.callbacks.set(handle, callback);
		this.delays.push(delayMs);
		return handle;
	}

	clearInterval(handle: unknown): void {
		const typedHandle = handle as object;
		this.cleared.push(typedHandle);
		this.callbacks.delete(typedHandle);
	}

	tick(): void {
		for (const callback of [...this.callbacks.values()]) callback();
	}
}

function customTool(tui: TUI): ToolExecutionComponent {
	const definition = {
		renderCall: (args: unknown) => new Text(`custom ${JSON.stringify(args)}`, 0, 0),
		renderResult: (
			result: { content: Array<{ type: string; text?: string }> },
		) => new Text(result.content.map((part) => part.text ?? "").join(""), 0, 0),
	};
	return new ToolExecutionComponent(
		"custom",
		"tool-id",
		{ value: 1 },
		{},
		definition as never,
		tui,
		process.cwd(),
	);
}

test("prefix component reserves width and prefixes only the first non-empty line", () => {
	const widths: number[] = [];
	const child: Component = {
		render(width) {
			widths.push(width);
			return [" ".repeat(width), "body".padEnd(width), "continued".padEnd(width)];
		},
		invalidate() {},
	};
	const component = new PrefixComponent(child, () => WHITE_DOT);

	const lines = component.render(14);

	assert.deepEqual(widths, [12]);
	assert.equal(stripAnsi(lines[0] ?? ""), " ".repeat(14));
	assert.equal(stripAnsi(lines[1] ?? "").slice(0, 6), "● body");
	assert.equal(stripAnsi(lines[2] ?? "").slice(0, 11), "  continued");
	assert.ok(lines.every((line) => visibleWidth(line) <= 14));
});

test("prefix component leaves image-only output at its original width", () => {
	const widths: number[] = [];
	const imageLine = "\x1b_Gf=100;AAAA\x07";
	const child: Component = {
		render(width) {
			widths.push(width);
			return [imageLine];
		},
		invalidate() {},
	};

	const lines = new PrefixComponent(child, () => WHITE_DOT).render(20);

	assert.deepEqual(widths, [18, 20]);
	assert.deepEqual(lines, [imageLine]);
});

test("assistant prefixes preserve block grouping, markdown, exact color, and dynamic thinking theme", () => {
	let currentTheme = prefixTheme(12, 34, 56);
	const cleanup = installAssistantPrefixes(() => currentTheme);
	try {
		const message = assistantMessage([
			{ type: "thinking", thinking: "first thought" },
			{ type: "thinking", thinking: "second thought" },
			{ type: "text", text: "# Heading\n\n- one\n- two" },
			{ type: "thinking", thinking: "separate thought" },
			{ type: "text", text: "Second **bold** block" },
		]);
		const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1);
		const originalChildren = [...(component as unknown as { contentContainer: { children: Component[] } })
			.contentContainer.children];

		const firstRender = component.render(48);
		const firstRaw = firstRender.join("\n");
		const firstPlain = stripAnsi(firstRaw);
		assert.equal(count(firstPlain, "∴"), 2);
		assert.equal(count(firstPlain, "●"), 2);
		assert.equal(count(firstRaw, WHITE_DOT), 2);
		assert.ok(firstRaw.includes("\x1b[3m\x1b[38;2;12;34;56m∴\x1b[39m\x1b[23m"));
		assert.ok(firstPlain.includes("Heading"));
		assert.ok(firstPlain.includes("one"));
		assert.ok(firstPlain.includes("two"));
		assert.ok(firstPlain.includes("Second bold block"));
		assert.ok(firstRender.every((line) => visibleWidth(line) <= 48));
		assert.deepEqual(
			(component as unknown as { contentContainer: { children: Component[] } }).contentContainer.children,
			originalChildren,
			"render-time prefix wrappers must not replace Markdown children",
		);

		currentTheme = prefixTheme(65, 43, 21);
		const themedRaw = component.render(48).join("\n");
		assert.ok(themedRaw.includes("\x1b[3m\x1b[38;2;65;43;21m∴\x1b[39m\x1b[23m"));
		assert.ok(!themedRaw.includes("\x1b[38;2;12;34;56m∴"));

		component.updateContent(message);
		const streamedPlain = stripAnsi(component.render(48).join("\n"));
		assert.equal(count(streamedPlain, "∴"), 2);
		assert.equal(count(streamedPlain, "●"), 2);
	} finally {
		cleanup();
	}
});

test("hidden thinking placeholders and model errors are not prefixed", () => {
	const cleanup = installAssistantPrefixes(() => prefixTheme(1, 2, 3));
	try {
		const hidden = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "secret" }]),
			true,
			getMarkdownTheme(),
			"Thinking...",
			1,
		);
		const hiddenPlain = stripAnsi(hidden.render(40).join("\n"));
		assert.ok(hiddenPlain.includes("Thinking..."));
		assert.ok(!hiddenPlain.includes("∴"));
		assert.ok(!hiddenPlain.includes("●"));

		const failed = assistantMessage([], "error");
		failed.errorMessage = "provider failed";
		const errorOnly = new AssistantMessageComponent(failed, false, getMarkdownTheme(), "Thinking...", 1);
		const errorPlain = stripAnsi(errorOnly.render(40).join("\n"));
		assert.ok(errorPlain.includes("provider failed"));
		assert.ok(!errorPlain.includes("●"));
	} finally {
		cleanup();
	}
});

test("tool status parser follows final-result precedence and rejects unknown internals", () => {
	assert.equal(parseToolExecutionStatus({ isPartial: true, executionStarted: false }), "preparing");
	assert.equal(parseToolExecutionStatus({ isPartial: true, executionStarted: true }), "running");
	assert.equal(parseToolExecutionStatus({
		isPartial: false,
		executionStarted: true,
		result: { isError: false },
	}), "success");
	assert.equal(parseToolExecutionStatus({
		isPartial: false,
		executionStarted: true,
		result: { isError: true },
	}), "failure");
	assert.equal(parseToolExecutionStatus({ isPartial: false, executionStarted: true }), "running");
	assert.equal(parseToolExecutionStatus({ isPartial: "no", executionStarted: true }), undefined);
});

test("real tool components render exact preparing, running, success, and failure dots", () => {
	const scheduler = new FakeScheduler();
	const blink = new ToolBlinkController(scheduler);
	let renderRequests = 0;
	const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
	const cleanup = installToolPrefixes(blink);
	try {
		const tool = customTool(tui);
		const preparing = tool.render(64);
		assert.ok(preparing.some((line) => line.includes(PREPARING_DOT)));
		assert.equal(scheduler.delays.length, 0);

		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		const running = tool.render(64);
		assert.ok(running.some((line) => line.includes(RUNNING_DOT)));
		assert.deepEqual(scheduler.delays, [600]);
		assert.equal(scheduler.unrefCalls, 1);
		const runningLine = running.find((line) => line.includes("custom")) ?? "";
		assert.ok(runningLine.slice(0, runningLine.indexOf("●")).includes("48;"));

		scheduler.tick();
		const dark = tool.render(64);
		assert.ok(!dark.some((line) => line.includes(RUNNING_DOT)));
		const darkLine = dark.find((line) => stripAnsi(line).includes("custom")) ?? "";
		assert.equal(stripAnsi(runningLine).replace("●", " "), stripAnsi(darkLine));

		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		const success = tool.render(64);
		assert.ok(success.some((line) => line.includes(SUCCESS_DOT)));
		assert.equal(blink.runningCount(), 0);
		assert.equal(scheduler.cleared.length, 1);

		tool.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		const failure = tool.render(64);
		assert.ok(failure.some((line) => line.includes(FAILURE_DOT)));
		assert.ok(stripAnsi(failure.join("\n")).includes("failed"));
		assert.ok(renderRequests >= 2);
	} finally {
		cleanup();
		blink.dispose();
	}
});

test("built-in and restored historical tools use the same prefix renderer", () => {
	const blink = new ToolBlinkController(new FakeScheduler());
	const tui = { requestRender() {} } as unknown as TUI;
	const historical = customTool(tui);
	historical.markExecutionStarted();
	historical.updateResult({ content: [{ type: "text", text: "restored" }], isError: false }, false);
	const cleanup = installToolPrefixes(blink);
	try {
		const builtIn = new ToolExecutionComponent(
			"read",
			"read-id",
			{ path: "package.json" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		assert.ok(builtIn.render(64).some((line) => line.includes(PREPARING_DOT)));
		assert.ok(historical.render(64).some((line) => line.includes(SUCCESS_DOT)));
	} finally {
		cleanup();
		blink.dispose();
	}
});

test("shared blink controller uses one timer, one phase, and one render per TUI", () => {
	const scheduler = new FakeScheduler();
	const blink = new ToolBlinkController(scheduler);
	let firstTuiRenders = 0;
	let secondTuiRenders = 0;
	const firstTui = { requestRender: () => firstTuiRenders++ };
	const secondTui = { requestRender: () => secondTuiRenders++ };
	const first = {};
	const second = {};
	const third = {};

	blink.sync(first, firstTui, true);
	blink.sync(second, firstTui, true);
	assert.equal(blink.isLit(), true);
	assert.deepEqual(scheduler.delays, [600]);

	scheduler.tick();
	assert.equal(blink.isLit(), false);
	assert.equal(firstTuiRenders, 1);
	blink.sync(third, secondTui, true);
	assert.equal(blink.isLit(), false);
	assert.equal(scheduler.delays.length, 1);

	scheduler.tick();
	assert.equal(blink.isLit(), true);
	assert.equal(firstTuiRenders, 2);
	assert.equal(secondTuiRenders, 1);

	blink.remove(first);
	blink.remove(second);
	assert.equal(scheduler.cleared.length, 0);
	blink.remove(third);
	assert.equal(scheduler.cleared.length, 1);
	assert.equal(blink.isLit(), true);

	const nextBatch = {};
	blink.sync(nextBatch, firstTui, true);
	assert.equal(blink.isLit(), true);
	assert.deepEqual(scheduler.delays, [600, 600]);
	blink.dispose();
	assert.equal(scheduler.cleared.length, 2);
});

test("full cleanup restores both prototypes and stops an active blink timer", () => {
	const assistantPrototype = AssistantMessageComponent.prototype;
	const toolPrototype = ToolExecutionComponent.prototype;
	const originalAssistantRender = assistantPrototype.render;
	const originalRender = toolPrototype.render;
	const scheduler = new FakeScheduler();
	const blink = new ToolBlinkController(scheduler);
	const cleanup = installOutputPrefixes(() => prefixTheme(1, 2, 3), { blink });

	try {
		assert.notEqual(assistantPrototype.render, originalAssistantRender);
		assert.notEqual(toolPrototype.render, originalRender);
		const tool = customTool({ requestRender() {} } as unknown as TUI);
		tool.markExecutionStarted();
		tool.render(60);
		assert.equal(blink.runningCount(), 1);

		cleanup();
		assert.equal(assistantPrototype.render, originalAssistantRender);
		assert.equal(toolPrototype.render, originalRender);
		assert.equal(blink.runningCount(), 0);
		assert.equal(scheduler.cleared.length, 1);
		cleanup();
		assert.equal(scheduler.cleared.length, 1);
	} finally {
		cleanup();
		assistantPrototype.render = originalAssistantRender;
		toolPrototype.render = originalRender;
	}
});

test("cleanup does not overwrite prototype wrappers installed later", () => {
	const assistantPrototype = {
		render(_width: number): string[] {
			return ["original"];
		},
	};
	const toolPrototype = {
		render(_width: number): string[] {
			return ["original"];
		},
	};
	const cleanupAssistant = installAssistantPrefixes(
		() => prefixTheme(1, 2, 3),
		assistantPrototype,
	);
	const blink = new ToolBlinkController(new FakeScheduler());
	const cleanupTool = installToolPrefixes(blink, toolPrototype);
	const laterAssistantWrapper = () => ["later"];
	const laterToolWrapper = () => ["later"];
	assistantPrototype.render = laterAssistantWrapper;
	toolPrototype.render = laterToolWrapper;

	cleanupAssistant();
	cleanupTool();
	blink.dispose();

	assert.equal(assistantPrototype.render, laterAssistantWrapper);
	assert.equal(toolPrototype.render, laterToolWrapper);
});
