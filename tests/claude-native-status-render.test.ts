import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	createSpinnerWidget,
	type SpinnerWidgetSnapshot,
	type SpinnerWidgetSource,
} from "../extensions/open-tui/spinner-widget.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

function createHarness(snapshot: SpinnerWidgetSnapshot) {
	let current = snapshot;
	const source: SpinnerWidgetSource = {
		getWidgetSnapshot() {
			return current;
		},
		setRequestRender() {},
		nativeStatusStart() {},
		nativeStatusUpdate() {},
		nativeStatusEnd() {},
	};
	const tui = {
		children: [],
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const widget = createSpinnerWidget(tui, theme, "other", source);
	return {
		widget,
		setSnapshot(next: SpinnerWidgetSnapshot) {
			current = next;
		},
	};
}

function runningSnapshot(overrides: Partial<SpinnerWidgetSnapshot> = {}): SpinnerWidgetSnapshot {
	return {
		phase: "running",
		active: true,
		message: "Working…",
		visualMode: "default",
		completionVerb: "Worked",
		completedDurationMs: null,
		hasAttachedTodos: false,
		reducedMotion: true,
		stalledIntensity: 0,
		...overrides,
	};
}

test("Claude compaction renders the exact system-blue status row", () => {
	const harness = createHarness(runningSnapshot({
		message: "Compacting conversation…",
		visualMode: "system-requesting",
	}));
	try {
		const lines = harness.widget.render(120);
		assert.equal(stripAnsi(lines[0] ?? ""), "● Compacting conversation…");
		assert.match(lines[0] ?? "", /\x1b\[38;2;147;165;255m/);
		assert.equal(lines[1], "");
	} finally {
		harness.widget.dispose();
	}
});

test("Claude visible retry row sits above the still-running main spinner", () => {
	const harness = createHarness(runningSnapshot({
		retryMessage: "Retrying in 1 second… (attempt 4/10)",
	}));
	try {
		const lines = harness.widget.render(120);
		assert.equal(stripAnsi(lines[0] ?? ""), "  ⎿  Retrying in 1 second… (attempt 4/10)");
		assert.equal(stripAnsi(lines[1] ?? ""), "● Working…");
		assert.equal(lines[2], "");
	} finally {
		harness.widget.dispose();
	}
});

test("Claude-hidden early retry leaves only the main spinner", () => {
	const harness = createHarness(runningSnapshot());
	try {
		const lines = harness.widget.render(120);
		assert.equal(stripAnsi(lines[0] ?? ""), "● Working…");
		assert.equal(lines[1], "");
		assert.equal(lines.length, 2);
	} finally {
		harness.widget.dispose();
	}
});
