import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { installAssistantPrefixes } from "../extensions/open-tui/output-prefix.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const theme = {
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

type Block =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall" };

class Markdown implements Component {
	text: string;
	constructor(text: string) { this.text = text; }
	setText(text: string): void { this.text = text; }
	render(width: number): string[] {
		const size = Math.max(1, width);
		return this.text.split("\n").flatMap((line) => {
			if (!line) return [""];
			const lines: string[] = [];
			for (let i = 0; i < line.length; i += size) lines.push(line.slice(i, i + size));
			return lines;
		});
	}
	invalidate(): void {}
}

class Text implements Component {
	render(): string[] { return ["Thinking..."]; }
	invalidate(): void {}
}

// Deliberately use another runtime class, not instanceof Pi's imported class.
// This models Pi 0.85's MouseRegion(Markdown | Text) thinking blocks.
class MouseRegion implements Component {
	child: Component;
	clicks = 0;
	constructor(child: Component) { this.child = child; }
	render(width: number): string[] { return this.child.render(width); }
	handleMouse(event: { type: string; button: string }): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.clicks++;
		return { handled: true };
	}
	invalidate(): void { this.child.invalidate(); }
}

class FakeContainer implements Component {
	children: Component[];
	mouseLayout: Array<{ component: Component; height: number }> = [];
	constructor(children: Component[]) { this.children = children; }
	render(width: number): string[] {
		this.mouseLayout = [];
		return this.children.flatMap((component) => {
			const lines = component.render(width);
			// Like Pi's Container, cache the rendered instances, not just heights.
			this.mouseLayout.push({ component, height: lines.length });
			return lines;
		});
	}
	invalidate(): void {}
}

function fixture(content: Block[], children: Component[], hideThinkingBlock = false) {
	const instance = {
		lastMessage: { role: "assistant", content },
		hideThinkingBlock,
		thinkingVisibilityOverrides: new Map<number, boolean>(),
		contentContainer: new FakeContainer(children),
	};
	const prototype = {
		render(this: typeof instance, width: number): string[] {
			return this.contentContainer.render(width);
		},
	};
	return {
		instance,
		prototype,
		render: (width = 40) => prototype.render.call(instance, width).map(stripAnsi),
	};
}

test("legacy direct thinking Markdown still gets one thinking mark", (t) => {
	const f = fixture(
		[{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }],
		[new Markdown("reason"), new Markdown("answer")],
	);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["∴ reason", "● answer"]);
});

test("MouseRegion thinking restores both prefixes and preserves streaming children", (t) => {
	const thinking = new Markdown("abcdefghijk");
	const region = new MouseRegion(thinking);
	const answer = new Markdown("done");
	const content: Block[] = [
		{ type: "thinking", thinking: thinking.text },
		{ type: "text", text: "done" },
	];
	const children = [region, answer];
	const f = fixture(content, children);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(10), ["∴ abcdefgh", "  ijk", "● done"]);
	assert.equal(f.instance.contentContainer.children, children);
	assert.equal(region.child, thinking);
	thinking.setText("streamed");
	content[0] = { type: "thinking", thinking: "streamed" };
	assert.deepEqual(f.render(10), ["∴ streamed", "● done"]);
	assert.deepEqual(f.render(10), ["∴ streamed", "● done"]);
	assert.equal(region.child, thinking);
});

test("rendered mouse layout retains the original clickable thinking region", (t) => {
	const region = new MouseRegion(new Markdown("abcdefghijk"));
	const f = fixture([{ type: "thinking", thinking: "abcdefghijk" }], [region]);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(10), ["∴ abcdefgh", "  ijk"]);
	const target = f.instance.contentContainer.mouseLayout[0]!;
	assert.equal(target.component, region, "do not replace the mouse target with PrefixComponent");
	assert.equal(target.height, 2, "hit testing must use the prefixed wrapping height");
	assert.deepEqual(region.handleMouse({ type: "click", button: "left" }), { handled: true });
	assert.equal(region.clicks, 1);
});

test("globally hidden thinking stays hidden and can be expanded per run", (t) => {
	const label = new Text();
	const region = new MouseRegion(label);
	const f = fixture(
		[{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }],
		[region, new Markdown("answer")],
		true,
	);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["Thinking...", "● answer"]);
	assert.equal(region.child, label);
	f.instance.thinkingVisibilityOverrides.set(0, false);
	region.child = new Markdown("reason");
	assert.deepEqual(f.render(), ["∴ reason", "● answer"]);
	f.instance.thinkingVisibilityOverrides.set(0, true);
	region.child = label;
	assert.deepEqual(f.render(), ["Thinking...", "● answer"]);
});

test("collapsing one thinking run does not shift later thinking and text prefixes", (t) => {
	const first = new MouseRegion(new Text());
	const second = new MouseRegion(new Markdown("second"));
	const f = fixture(
		[
			{ type: "thinking", thinking: "first" },
			{ type: "text", text: "between" },
			{ type: "thinking", thinking: "second" },
			{ type: "text", text: "answer" },
		],
		[first, new Markdown("between"), second, new Markdown("answer")],
	);
	f.instance.thinkingVisibilityOverrides.set(0, true);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["Thinking...", "● between", "∴ second", "● answer"]);
});

test("run overrides count nonempty runs, merging adjacent thinking blocks", (t) => {
	const f = fixture(
		[
			{ type: "thinking", thinking: " " },
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "one" },
			{ type: "thinking", thinking: "two" },
			{ type: "toolCall" },
			{ type: "thinking", thinking: "\n" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "three" },
		],
		[new MouseRegion(new Text()), new Markdown("answer"), new MouseRegion(new Markdown("three"))],
		true,
	);
	f.instance.thinkingVisibilityOverrides.set(1, false);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["Thinking...", "● answer", "∴ three"]);
});

test("legacy runtimes without visibility overrides remain supported", (t) => {
	const f = fixture([{ type: "thinking", thinking: "reason" }], [new Markdown("reason")]);
	Reflect.deleteProperty(f.instance, "thinkingVisibilityOverrides");
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["∴ reason"]);
});

test("unknown wrapper layouts fall back without changing children", (t) => {
	class UnknownRegion extends MouseRegion {}
	const markdown = new Markdown("reason");
	const region = new UnknownRegion(markdown);
	const children = [region, new Markdown("answer")];
	const f = fixture(
		[{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }], children,
	);
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["reason", "answer"]);
	assert.equal(f.instance.contentContainer.children, children);
	assert.equal(region.child, markdown);
});

test("failed rendering restores nested children before the native fallback", (t) => {
	const markdown = new Markdown("reason");
	const region = new MouseRegion(markdown);
	const children = [region];
	const f = fixture([{ type: "thinking", thinking: "reason" }], children);
	const originalRender = f.prototype.render;
	let fail = true;
	let prefixedDuringFailure = false;
	f.prototype.render = function (width: number): string[] {
		if (fail) {
			fail = false;
			prefixedDuringFailure = region.child !== markdown;
			throw new Error("render failed");
		}
		assert.equal(region.child, markdown, "native fallback must see the restored child");
		return originalRender.call(this, width);
	};
	t.after(installAssistantPrefixes(() => theme, f.prototype));
	assert.deepEqual(f.render(), ["reason"]);
	assert.equal(prefixedDuringFailure, true, "prefix must be inside the mouse region");
	assert.equal(f.instance.contentContainer.children, children);
	assert.equal(region.child, markdown);
});

test("narrow rendering and uninstall leave no persistent thinking wrappers", () => {
	const markdown = new Markdown("abc");
	const region = new MouseRegion(markdown);
	const f = fixture([{ type: "thinking", thinking: "abc" }], [region]);
	const originalRender = f.prototype.render;
	const cleanup = installAssistantPrefixes(() => theme, f.prototype);
	try {
		assert.deepEqual(f.render(2), ["ab", "c"]);
		assert.deepEqual(f.render(3), ["∴ a", "  b", "  c"]);
		assert.equal(region.child, markdown);
	} finally {
		cleanup();
	}
	cleanup();
	assert.equal(f.prototype.render, originalRender);
	assert.deepEqual(f.render(), ["abc"]);
	assert.equal(region.child, markdown);
});
