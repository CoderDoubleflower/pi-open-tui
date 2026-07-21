import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import { registerSettingsCommand } from "../extensions/open-tui/settings-command.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

async function openSettings(): Promise<{
	component: SettingsComponent;
	getConfig: () => OpenTuiConfig;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = structuredClone(DEFAULT_CONFIG);

	const pi = {
		registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
		},
	});

	const tui = { requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => {
				component = factory(tui, theme, {} as KeybindingsManager, (_value: void) => {}) as SettingsComponent;
			},
		},
	} as unknown as ExtensionContext;

	assert.ok(commandHandler);
	await commandHandler("", ctx);
	assert.ok(component);

	return { component, getConfig: () => config };
}

function selectedLine(component: SettingsComponent): string {
	return component.render(80).find((line) => line.includes("→")) ?? "";
}

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Auto-collapse resources/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().autoCollapseResources, false);
	assert.match(selectedLine(settings.component), /Auto-collapse resources/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Auto-collapse resources/);
});
