import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	Text,
} from "@earendil-works/pi-tui";
import type { IconMode, OpenTuiConfig } from "./config.ts";

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
	values: string[];
}

type Tab = "features" | "icons" | "segments";

const TABS: { id: Tab; label: string }[] = [
	{ id: "features", label: "Features" },
	{ id: "icons", label: "Icons" },
	{ id: "segments", label: "Segments" },
];

function toggleSetting(config: OpenTuiConfig, key: keyof OpenTuiConfig["footerSegments"]): OpenTuiConfig {
	return {
		...config,
		footerSegments: {
			...config.footerSegments,
			[key]: !config.footerSegments[key],
		},
	};
}

function cycleIconMode(config: OpenTuiConfig): OpenTuiConfig {
	const order: IconMode[] = ["auto", "nerd", "ascii"];
	const currentIdx = order.indexOf(config.icons.mode);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, icons: { mode: next } };
}

function toggleEnabled(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function buildFeaturesItems(config: OpenTuiConfig): SettingItem[] {
	return [
		{
			id: "enabled",
			label: "Enabled",
			currentValue: config.enabled ? "on" : "off",
			values: ["on", "off"],
		},
	];
}

function buildIconsItems(config: OpenTuiConfig): SettingItem[] {
	return [
		{
			id: "mode",
			label: "Icon mode",
			currentValue: config.icons.mode,
			values: ["auto", "nerd", "ascii"],
		},
	];
}

function buildSegmentsItems(config: OpenTuiConfig): SettingItem[] {
	const segs = config.footerSegments;
	return [
		{ id: "cwd", label: "cwd", currentValue: segs.cwd ? "on" : "off", values: ["on", "off"] },
		{ id: "gitBranch", label: "git branch", currentValue: segs.gitBranch ? "on" : "off", values: ["on", "off"] },
		{ id: "gitStatus", label: "git status", currentValue: segs.gitStatus ? "on" : "off", values: ["on", "off"] },
		{ id: "gitCommit", label: "git commit (detached)", currentValue: segs.gitCommit ? "on" : "off", values: ["on", "off"] },
		{ id: "runtime", label: "runtime", currentValue: segs.runtime ? "on" : "off", values: ["on", "off"] },
		{ id: "context", label: "context bar", currentValue: segs.context ? "on" : "off", values: ["on", "off"] },
		{ id: "tokens", label: "tokens", currentValue: segs.tokens ? "on" : "off", values: ["on", "off"] },
		{ id: "cost", label: "cost", currentValue: segs.cost ? "on" : "off", values: ["on", "off"] },
	];
}

function buildItems(tab: Tab, config: OpenTuiConfig): SettingItem[] {
	switch (tab) {
		case "features": return buildFeaturesItems(config);
		case "icons": return buildIconsItems(config);
		case "segments": return buildSegmentsItems(config);
	}
}

function handleSettingChange(
	tab: Tab,
	itemId: string,
	config: OpenTuiConfig,
): OpenTuiConfig {
	if (tab === "features" && itemId === "enabled") {
		return toggleEnabled(config);
	}
	if (tab === "icons" && itemId === "mode") {
		return cycleIconMode(config);
	}
	if (tab === "segments") {
		return toggleSetting(config, itemId as keyof OpenTuiConfig["footerSegments"]);
	}
	return config;
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

class SettingsUi implements SettingsUiHandle {
	private tab: Tab = "features";
	private config: OpenTuiConfig;
	private selectList: SelectList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly container: Box;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly theme: Theme,
		config: OpenTuiConfig,
		private readonly onChange: (config: OpenTuiConfig) => void,
		private readonly onClose: () => void,
	) {
		this.config = config;
		this.container = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		this.selectList = new SelectList([], 12, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.rebuild();
	}

	private rebuild(preferredItemId = this.selectedItemByTab[this.tab]): void {
		this.container.clear();
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", "Open TUI Settings")), 1, 0));

		const tabBar = TABS.map((t) => {
			const active = t.id === this.tab;
			const label = active ? `[${t.label}]` : ` ${t.label} `;
			return active ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
		}).join(" ");
		this.container.addChild(new Text(tabBar, 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", "Tab/Shift+Tab to switch · Enter to toggle · Esc to close"), 1, 0));

		const items = buildItems(this.tab, this.config).map((item) => ({
			value: item.id,
			label: item.label,
			description: item.currentValue,
		} as SelectItem));
		this.selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
		const selectedIndex = items.findIndex((item) => item.value === preferredItemId);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		}
		this.selectedItemByTab[this.tab] = this.selectList.getSelectedItem()?.value;
		this.selectList.onSelectionChange = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
			this.config = handleSettingChange(this.tab, item.value, this.config);
			this.onChange(this.config);
			this.rebuild(item.value);
			this.invalidate();
		};
		this.selectList.onCancel = () => {
			this.onClose();
		};
		this.container.addChild(this.selectList);

		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			const idx = TABS.findIndex((t) => t.id === this.tab);
			this.tab = TABS[(idx + 1) % TABS.length]!.id;
			this.rebuild();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			const idx = TABS.findIndex((t) => t.id === this.tab);
			this.tab = TABS[(idx - 1 + TABS.length) % TABS.length]!.id;
			this.rebuild();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.onClose();
			return;
		}
		this.selectList.handleInput?.(data);
		this.invalidate();
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.container.render(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.container.invalidate();
	}
}

export function registerSettingsCommand(
	pi: ExtensionAPI,
	hooks: {
		getConfig: () => OpenTuiConfig;
		onConfigChanged: (config: OpenTuiConfig) => void;
	},
): void {
	pi.registerCommand("open-tui", {
		description: "Open the open-tui settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui: TUI, theme, _kb, done) => {
			const ui = new SettingsUi(
				theme,
				hooks.getConfig(),
				(config) => hooks.onConfigChanged(config),
				() => done(undefined),
			);
			return {
				render: (w: number) => ui.render(w),
				invalidate: () => ui.invalidate(),
				handleInput: (data: string) => {
					ui.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
		},
	});
}
