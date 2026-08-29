import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { HEADER_LOGO_FRAME_INTERVAL_MS, OpenTuiHeader, type HeaderScheduler } from "../extensions/open-tui/header.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

test("header advances its startup logo and stops after the final frame", () => {
	let callback: (() => void) | undefined;
	let cleared = 0;
	let renders = 0;
	const scheduler: HeaderScheduler = {
		setInterval(fn, delayMs) {
			assert.equal(delayMs, HEADER_LOGO_FRAME_INTERVAL_MS);
			callback = fn;
			return 1;
		},
		clearInterval() {
			cleared++;
		},
	};
	const pi = {
		getCommands: () => [],
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/repo",
		model: { id: "test", provider: "mock" },
		ui: { theme },
	} as unknown as ExtensionContext;
	const header = new OpenTuiHeader(pi, ctx, { requestRender: () => renders++ } as never, scheduler);
	const first = header.render(90).join("\n");

	for (let index = 0; index < 40; index++) callback?.();
	const final = header.render(90).join("\n");
	assert.notEqual(first, final);
	assert.ok(renders > 0);
	assert.equal(cleared, 1);

	header.dispose();
	assert.equal(cleared, 1);
});
