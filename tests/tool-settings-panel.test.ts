import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
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

async function openSettings(initialConfig = structuredClone(DEFAULT_CONFIG)): Promise<{
	component: SettingsComponent;
	getConfig: () => OpenTuiConfig;
	isClosed: () => boolean;
	waitForClose: () => Promise<void>;
}> {
	let commandName: string | undefined;
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;

	const pi = {
		registerCommand: (name: string, options: { handler: typeof commandHandler }) => {
			commandName = name;
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
		},
	});

	assert.equal(commandName, "open-tui");
	assert.ok(commandHandler);

	const tui = { requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => new Promise<void>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, (_value: void) => {
					closed = true;
					resolve();
				}) as SettingsComponent;
			}),
		},
	} as unknown as ExtensionContext;

	const closePromise = Promise.resolve(commandHandler("", ctx));
	assert.ok(component);

	return {
		component,
		getConfig: () => config,
		isClosed: () => closed,
		waitForClose: () => closePromise,
	};
}

function down(component: SettingsComponent, count = 1): void {
	for (let i = 0; i < count; i++) component.handleInput("\x1b[B");
}

function enter(component: SettingsComponent): void {
	component.handleInput("\r");
}

function selectedLine(component: SettingsComponent): string {
	return component.render(100).find((line) => line.includes("→ ")) ?? "";
}

function openToolPanel(component: SettingsComponent): void {
	down(component, 4);
	assert.match(selectedLine(component), /Tool rendering|工具渲染/);
	enter(component);
	assert.match(component.render(100).join("\n"), /‹ (?:Tool rendering|工具渲染)/);
}

function editValue(component: SettingsComponent, value: string): void {
	enter(component);
	component.handleInput(value);
	enter(component);
}

test("configures every tool rendering option inside /open-tui", async () => {
	const settings = await openSettings();
	const component = settings.component;
	openToolPanel(component);

	enter(component);
	assert.equal(settings.getConfig().toolRendering.enabled, false);

	down(component);
	enter(component);
	assert.equal(settings.getConfig().toolRendering.groupToolCalls, false);

	for (const [key, expected] of [
		["readOutputMode", "preview"],
		["searchOutputMode", "preview"],
		["bashOutputMode", "hidden"],
		["mcpOutputMode", "hidden"],
		["openAiOutputMode", "hidden"],
	] as const) {
		down(component);
		enter(component);
		assert.equal(settings.getConfig().toolRendering[key], expected);
	}

	down(component);
	editValue(component, "12");
	assert.equal(settings.getConfig().toolRendering.previewLines, 12);

	down(component);
	editValue(component, "6000");
	assert.equal(settings.getConfig().toolRendering.expandedPreviewMaxLines, 6000);

	down(component);
	enter(component);
	assert.equal(settings.getConfig().toolRendering.livePreview, false);

	down(component);
	editValue(component, "7");
	assert.equal(settings.getConfig().toolRendering.livePreviewLines, 7);

	down(component);
	enter(component);
	assert.equal(settings.getConfig().toolRendering.diffLayout, "unified");

	down(component);
	editValue(component, "36");
	assert.equal(settings.getConfig().toolRendering.diffCollapsedLines, 36);

	down(component);
	editValue(component, "nord");
	assert.equal(settings.getConfig().toolRendering.diffTheme, "nord");
	assert.match(selectedLine(component), /Diff theme/);

	down(component);
	enter(component);
	assert.equal(settings.getConfig().toolRendering.subagents.enabled, false);
	assert.match(selectedLine(component), /Codex Subagent rendering/);

	down(component);
	editValue(component, "5");
	assert.equal(settings.getConfig().toolRendering.subagents.collapsedActivityItems, 5);

	down(component);
	editValue(component, "500");
	assert.equal(settings.getConfig().toolRendering.subagents.expandedActivityItems, 500);

	for (const key of ["showToolActivity", "showUsage", "showElapsed", "showExpandHint"] as const) {
		down(component);
		enter(component);
		assert.equal(settings.getConfig().toolRendering.subagents[key], false);
	}

	component.handleInput("q");
	assert.equal(settings.isClosed(), true);
	await settings.waitForClose();
});

test("validates typed tool rendering values and keeps the active selection", async () => {
	const settings = await openSettings();
	const component = settings.component;
	openToolPanel(component);

	down(component, 7);
	enter(component);
	component.handleInput("0");
	enter(component);
	assert.equal(settings.getConfig().toolRendering.previewLines, 8);
	assert.match(component.render(100).join("\n"), /whole number from 1 to 50/);

	component.handleInput("\x1b");
	assert.match(selectedLine(component), /Preview lines/);

	editValue(component, "50");
	assert.equal(settings.getConfig().toolRendering.previewLines, 50);
	assert.match(selectedLine(component), /Preview lines/);

	down(component, 6);
	enter(component);
	enter(component);
	assert.equal(settings.getConfig().toolRendering.diffTheme, "github-dark");
	assert.match(component.render(100).join("\n"), /non-empty Shiki theme name/);
	component.handleInput("github-light");
	enter(component);
	assert.equal(settings.getConfig().toolRendering.diffTheme, "github-light");

	component.handleInput("\x1b");
	assert.match(selectedLine(component), /Tool rendering/);
	component.handleInput("q");
	await settings.waitForClose();
});

test("renders the localized tool settings panel within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	const settings = await openSettings(config);
	openToolPanel(settings.component);

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /工具渲染/);
	}

	settings.component.handleInput("q");
	await settings.waitForClose();
});
