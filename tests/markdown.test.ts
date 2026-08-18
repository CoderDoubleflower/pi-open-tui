import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown as PiMarkdown, type Component } from "@earendil-works/pi-tui";
import {
	installClaudeStyleMarkdown,
	type AssistantPrototype,
} from "../extensions/open-tui/markdown.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

initTheme();

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function renderPlain(component: { render(width: number): string[] }, width = 80): string {
	return stripAnsi(component.render(width).join("\n"));
}

function hasFenceLine(text: string): boolean {
	return text.split("\n").some((line) => line.trim().startsWith("```"));
}

test("assistant fenced code keeps the body but hides literal Markdown fences", () => {
	const cleanup = installClaudeStyleMarkdown();
	try {
		const component = new AssistantMessageComponent(
			assistantMessage("Before\n\n```ts\nconst value: number = 42;\n```\n\nAfter"),
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
		);
		const plain = renderPlain(component);

		assert.ok(plain.includes("Before"));
		assert.ok(plain.includes("const value: number = 42;"));
		assert.ok(plain.includes("After"));
		assert.equal(hasFenceLine(plain), false);
	} finally {
		cleanup();
	}
});

test("streaming incomplete fenced code also renders without synthetic fences", () => {
	const cleanup = installClaudeStyleMarkdown();
	try {
		const message = assistantMessage("```ts\nconst streaming = true;");
		const component = new AssistantMessageComponent(
			message,
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
		);
		component.updateContent(message, true);
		const plain = renderPlain(component);

		assert.ok(plain.includes("const streaming = true;"));
		assert.equal(hasFenceLine(plain), false);
	} finally {
		cleanup();
	}
});

test("standalone Markdown keeps Pi's upstream fence rendering", () => {
	const cleanup = installClaudeStyleMarkdown();
	try {
		const standalone = new PiMarkdown(
			"```ts\nconst standalone = true;\n```",
			0,
			0,
			getMarkdownTheme(),
		);
		const plain = renderPlain(standalone);

		assert.ok(plain.includes("```ts"));
		assert.ok(plain.split("\n").some((line) => line.trim() === "```"));
		assert.ok(plain.includes("const standalone = true;"));
	} finally {
		cleanup();
	}
});

test("discovers and patches the concrete Markdown prototype created by the assistant", () => {
	class FakeContainer implements Component {
		children: Component[] = [];

		render(width: number): string[] {
			return this.children.flatMap((child) => child.render(width));
		}

		invalidate(): void {
			for (const child of this.children) child.invalidate();
		}
	}

	// Deliberately use a separate class named Markdown. This models a runtime
	// module graph where the assistant renderer's Markdown constructor is not the
	// same class object an extension could import directly.
	class Markdown implements Component {
		setText(_text: string): void {}

		renderToken(token: { type?: string }): string[] {
			if (token.type === "code") return ["```bash", "echo runtime", "```"];
			return ["plain"];
		}

		render(_width: number): string[] {
			return this.renderToken({ type: "code" });
		}

		invalidate(): void {}
	}

	class FakeAssistant {
		contentContainer = new FakeContainer();

		updateContent(_message: AssistantMessage, _isStreaming?: boolean): void {
			this.contentContainer.children = [new Markdown()];
		}
	}

	const cleanup = installClaudeStyleMarkdown(FakeAssistant.prototype as AssistantPrototype);
	try {
		const assistant = new FakeAssistant();
		assistant.updateContent(assistantMessage("ignored"));
		const child = assistant.contentContainer.children[0]!;
		const plain = renderPlain(child);

		assert.equal(hasFenceLine(plain), false);
		assert.ok(plain.includes("echo runtime"));

		// Patching the concrete prototype must still remain scoped to the exact
		// assistant Markdown instances that were marked by updateContent.
		const unrelated = new Markdown();
		assert.equal(hasFenceLine(renderPlain(unrelated)), true);
	} finally {
		cleanup();
	}
});

test("cleanup restores Pi's original assistant code fence rendering", () => {
	const cleanup = installClaudeStyleMarkdown();
	cleanup();

	const component = new AssistantMessageComponent(
		assistantMessage("```ts\nconst restored = true;\n```"),
		false,
		getMarkdownTheme(),
		"Thinking...",
		1,
	);
	const plain = renderPlain(component);

	assert.ok(plain.includes("```ts"));
	assert.ok(plain.split("\n").some((line) => line.trim() === "```"));
	assert.ok(plain.includes("const restored = true;"));
});
