import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	loadConfig,
	saveConfig,
	type OpenTuiConfig,
} from "../extensions/open-tui/config.ts";
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
	isOverlayClosed: () => boolean;
	waitForClose: () => Promise<void>;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;
	let overlayClosed = false;

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
		onOverlayClosed: () => {
			overlayClosed = true;
		},
	});

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

	assert.ok(commandHandler);
	const closePromise = Promise.resolve(commandHandler("", ctx));
	assert.ok(component);

	return {
		component,
		getConfig: () => config,
		isClosed: () => closed,
		isOverlayClosed: () => overlayClosed,
		waitForClose: () => closePromise,
	};
}

function selectedLine(component: SettingsComponent): string {
	return component.render(80).find((line) => line.includes("→ ")) ?? "";
}

test("closes cleanly after enabling or disabling the UI", async () => {
	for (const enabled of [true, false]) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.enabled = enabled;
		const settings = await openSettings(config);

		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().enabled, !enabled);
		assert.equal(settings.isClosed(), false);
		assert.equal(settings.isOverlayClosed(), false);

		settings.component.handleInput("q");
		assert.equal(settings.isClosed(), true);
		assert.equal(settings.isOverlayClosed(), false);
		await settings.waitForClose();
		assert.equal(settings.isOverlayClosed(), true);
	}
});

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git branch/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.gitBranch, false);
	assert.match(selectedLine(settings.component), /Git branch/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Git branch/);
});

test("configures telemetry from its own tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.enabled, false);
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.tps, false);
});

test("supports localized settings and keyboard shortcuts", async () => {
	const settings = await openSettings();
	assert.match(settings.component.render(80).join("\n"), /Open TUI Settings.*General.*Language/s);

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().settingsLanguage, "zh");
	assert.match(settings.component.render(80).join("\n"), /Open TUI 设置.*常规.*语言.*简体中文/s);
	assert.match(selectedLine(settings.component), /语言/);

	const reopened = await openSettings(structuredClone(settings.getConfig()));
	assert.match(reopened.component.render(80).join("\n"), /Open TUI 设置.*简体中文/s);

	reopened.component.handleInput("\x1b[B");
	reopened.component.handleInput("\x1b[C");
	assert.match(reopened.component.render(80).join("\n"), /\[图标\]/);
	reopened.component.handleInput("\x1b[D");
	assert.match(selectedLine(reopened.component), /语言/);
	reopened.component.handleInput("q");
	assert.equal(reopened.isClosed(), true);
});

test("configures the extension status line with Space", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 9; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Extension status line/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.extensionStatuses, false);
	assert.match(selectedLine(settings.component), /Extension status line/);
});

test("configures the autocomplete menu direction", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Autocomplete menu/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().editor.autocompleteDirection, "down");
	assert.match(selectedLine(settings.component), /Open downward/);
});

test("keeps localized settings and values within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	const settings = await openSettings(config);

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		}
		const output = lines.join("\n");
		assert.match(output, /开启/);
		assert.match(output, /简体中文/);
	}
});

test("falls back to English for an invalid settings language", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ settingsLanguage: "de" }), "utf8");
		assert.equal(loadConfig().settingsLanguage, "en");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("falls back to upward autocomplete for an invalid direction", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({ editor: { autocompleteDirection: "sideways" } }),
			"utf8",
		);
		assert.equal(loadConfig().editor.autocompleteDirection, "up");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("adds default spinner settings to older config files", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({ editor: { dynamicBorderColor: true } }),
			"utf8",
		);
		const config = loadConfig();
		assert.deepEqual(config.spinner, DEFAULT_CONFIG.spinner);
		assert.equal(config.editor.dynamicBorderColor, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("validates spinner booleans without replacing other config sections", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({
				spinner: { enabled: "yes", verbose: true, reducedMotion: 1 },
				editor: { autocompleteDirection: "down" },
				footerSegments: { sessionName: true },
				telemetry: { enabled: false },
			}),
			"utf8",
		);
		const config = loadConfig();
		assert.deepEqual(config.spinner, {
			...DEFAULT_CONFIG.spinner,
			verbose: true,
		});
		assert.equal(config.editor.autocompleteDirection, "down");
		assert.equal(config.footerSegments.sessionName, true);
		assert.equal(config.telemetry.enabled, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("ignores an invalid spinner object without replacing other config sections", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({ spinner: null, editor: { dynamicBorderColor: true } }),
			"utf8",
		);
		const config = loadConfig();
		assert.deepEqual(config.spinner, DEFAULT_CONFIG.spinner);
		assert.equal(config.editor.dynamicBorderColor, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("preserves spinner settings through save and load", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const config = structuredClone(DEFAULT_CONFIG);
		Object.assign(config.spinner, { enabled: true, verbose: true, reducedMotion: true });
		saveConfig(config);
		assert.deepEqual(loadConfig(), config);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("configures Phase 2 spinner options from their own tab", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.spinner.verbs.values = ["Inspecting", "Testing"];
	const settings = await openSettings(config);

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	assert.match(settings.component.render(80).join("\n"), /\[Spinner\]/);
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().spinner.enabled, true);
	for (const [key, expected] of [
		["verbose", true],
		["reducedMotion", true],
		["showThinking", false],
		["showTimer", false],
		["showTokens", false],
		["showStall", false],
		["showSuffix", false],
	] as const) {
		settings.component.handleInput("\x1b[B");
		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().spinner[key], expected);
	}

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().spinner.effortDisplay, "off");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().spinner.taskIntegration, "off");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().spinner.suppressFooterWorkingTimer, false);
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().spinner.verbs.mode, "replace");
	settings.component.handleInput("\x1b[B");
	assert.match(settings.component.render(80).join("\n"), /2 configured/);
});

test("shows localized spinner copy within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	config.spinner.verbs.values = ["检查"];
	const settings = await openSettings(config);
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	for (let i = 0; i < 12; i++) settings.component.handleInput("\x1b[B");

	let widestOutput = "";
	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width === 48) widestOutput = lines.join("\n");
	}
	assert.match(widestOutput, /自定义动词/);
	assert.match(widestOutput, /已配置 1 项/);
});

test("shows only the supported Phase 3 suffix setting", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	const output = settings.component.render(120).join("\n");
	assert.match(output, /External suffix/);
	assert.doesNotMatch(output, /Glimmer|Shimmer|Tool-use flash|Tips|Target|Brief|Connection|Background/);
});
