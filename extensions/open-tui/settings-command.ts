import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Input,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	Text,
} from "@earendil-works/pi-tui";
import type {
	AutocompleteDirection,
	IconMode,
	OpenTuiConfig,
	SettingsLanguage,
	SpinnerEffortDisplay,
	SpinnerTaskIntegration,
	SpinnerVerbMode,
	ToolDiffLayout,
	ToolOutputMode,
	ToolRenderingConfig,
} from "./config.ts";
import {
	applyFullscreenWheelScrollLines,
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
} from "./fullscreen-scroll.ts";

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
}

type Tab = "features" | "icons" | "spinner" | "segments" | "telemetry";
type SettingsView = "main" | "tools";
type ToolEditableSettingId = "previewLines" | "expandedPreviewMaxLines" | "livePreviewLines" | "diffCollapsedLines" | "diffTheme";

const TABS: Tab[] = ["features", "icons", "spinner", "segments", "telemetry"];
const TOOL_PANEL_ITEM_ID = "toolRenderingPanel";
const OUTPUT_MODE_ORDER: ToolOutputMode[] = ["hidden", "summary", "preview"];
const DIFF_LAYOUT_ORDER: ToolDiffLayout[] = ["auto", "unified", "split"];

const TOOL_EDIT_SPECS = {
	previewLines: { min: 1, max: 50 },
	expandedPreviewMaxLines: { min: 100, max: 20_000 },
	livePreviewLines: { min: 1, max: 20 },
	diffCollapsedLines: { min: 4, max: 200 },
	diffTheme: { maxLength: 80 },
} as const;

const COPY = {
	en: {
		title: "Open TUI Settings",
		toolsTitle: "Tool rendering",
		tabs: { features: "General", icons: "Icons", spinner: "Spinner", segments: "Footer", telemetry: "Telemetry" },
		hint: "Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
		toolsHint: "↑/↓: move · Enter/Space: change or edit · Esc/←: back · q: close",
		editHint: "Type a new value · Enter: save · Esc: cancel",
		labels: {
			enabled: "Enabled",
			language: "Language",
			autocompleteDirection: "Autocomplete menu",
			wheelScrollLines: "Mouse wheel speed",
			toolRenderingPanel: "Tool rendering",
			iconMode: "Icon mode",
			spinnerVerbose: "Verbose metadata",
			reducedMotion: "Reduced motion",
			showThinking: "Thinking status",
			showTimer: "Elapsed timer",
			showTokens: "Input/output tokens",
			showStall: "Stall indication",
			showSuffix: "External suffix",
			effortDisplay: "Effort display",
			taskIntegration: "Task event integration",
			suppressFooterWorkingTimer: "Hide duplicate footer timer",
			verbMode: "Custom verb mode",
			customVerbs: "Custom verbs",
			cwd: "CWD",
			sessionName: "Session name",
			gitBranch: "Git branch",
			gitStatus: "Git status",
			gitCommit: "Git commit (detached)",
			runtime: "Runtime",
			context: "Context bar",
			tokens: "Tokens",
			cost: "Cost",
			extensionStatuses: "Extension status line",
			timer: "Timer",
			totalDuration: "Total duration",
			tokenCounts: "Token counts",
			stallDetails: "Stall details",
			costRate: "Cost rate",
			toolRenderingEnabled: "Tool rendering",
			groupToolCalls: "Group tool calls",
			readOutputMode: "Read output",
			searchOutputMode: "Search output",
			bashOutputMode: "Bash output",
			mcpOutputMode: "MCP output",
			openAiOutputMode: "OpenAI output",
			previewLines: "Preview lines",
			expandedPreviewMaxLines: "Expanded preview cap",
			livePreview: "Live preview",
			livePreviewLines: "Live preview lines",
			diffLayout: "Diff layout",
			diffCollapsedLines: "Collapsed diff lines",
			diffTheme: "Diff theme",
		},
		values: {
			on: "On",
			off: "Off",
			grouped: "Grouped",
			ungrouped: "Ungrouped",
			languages: { en: "English", zh: "简体中文" },
			autocompleteDirections: { up: "Open upward", down: "Open downward" },
			wheelLines: (count: number) => `${count} ${count === 1 ? "line" : "lines"} / notch`,
			icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
			effortDisplays: { effective: "Effective", off: "Hidden" },
			taskIntegrations: { events: "Events", off: "Off" },
			verbModes: { append: "Append", replace: "Replace" },
			configured: (count: number) => `${count} configured`,
			outputModes: { hidden: "Hidden", summary: "Summary", preview: "Preview" },
			diffLayouts: { auto: "Auto", unified: "Unified", split: "Split" },
			lines: (count: number) => `${count} ${count === 1 ? "line" : "lines"}`,
			current: (value: string) => `Current: ${value}`,
			range: (min: number, max: number) => `Range: ${min}–${max}`,
			maxChars: (max: number) => `Maximum: ${max} characters`,
		},
		errors: {
			integer: (min: number, max: number) => `Enter a whole number from ${min} to ${max}.`,
			theme: (max: number) => `Enter a non-empty Shiki theme name up to ${max} characters.`,
		},
	},
	zh: {
		title: "Open TUI 设置",
		toolsTitle: "工具渲染",
		tabs: { features: "常规", icons: "图标", spinner: "Spinner", segments: "Footer", telemetry: "遥测" },
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭",
		toolsHint: "↑/↓：移动 · Enter/Space：更改或编辑 · Esc/←：返回 · q：关闭",
		editHint: "输入新值 · Enter：保存 · Esc：取消",
		labels: {
			enabled: "启用",
			language: "语言",
			autocompleteDirection: "补全菜单",
			wheelScrollLines: "鼠标滚轮速度",
			toolRenderingPanel: "工具渲染",
			iconMode: "图标模式",
			spinnerVerbose: "详细元数据",
			reducedMotion: "减少动态效果",
			showThinking: "思考状态",
			showTimer: "已用时间",
			showTokens: "输入/输出 Token",
			showStall: "停顿提示",
			showSuffix: "外部后缀",
			effortDisplay: "思考强度",
			taskIntegration: "任务事件集成",
			suppressFooterWorkingTimer: "隐藏重复 Footer 计时",
			verbMode: "自定义动词模式",
			customVerbs: "自定义动词",
			cwd: "当前目录",
			sessionName: "会话名",
			gitBranch: "Git 分支",
			gitStatus: "Git 状态",
			gitCommit: "Git 提交（分离 HEAD）",
			runtime: "运行环境",
			context: "上下文栏",
			tokens: "Token",
			cost: "费用",
			extensionStatuses: "扩展状态行",
			timer: "计时器",
			totalDuration: "总耗时",
			tokenCounts: "Token 数量",
			stallDetails: "停顿详情",
			costRate: "费用速率",
			toolRenderingEnabled: "工具渲染",
			groupToolCalls: "工具调用分组",
			readOutputMode: "Read 输出",
			searchOutputMode: "Search 输出",
			bashOutputMode: "Bash 输出",
			mcpOutputMode: "MCP 输出",
			openAiOutputMode: "OpenAI 输出",
			previewLines: "预览行数",
			expandedPreviewMaxLines: "展开预览上限",
			livePreview: "实时预览",
			livePreviewLines: "实时预览行数",
			diffLayout: "Diff 布局",
			diffCollapsedLines: "折叠 Diff 行数",
			diffTheme: "Diff 主题",
		},
		values: {
			on: "开启",
			off: "关闭",
			grouped: "已分组",
			ungrouped: "未分组",
			languages: { en: "English", zh: "简体中文" },
			autocompleteDirections: { up: "向上弹出", down: "向下弹出" },
			wheelLines: (count: number) => `每格 ${count} 行`,
			icons: { auto: "自动", nerd: "Nerd", ascii: "ASCII" },
			effortDisplays: { effective: "显示当前强度", off: "隐藏" },
			taskIntegrations: { events: "事件", off: "关闭" },
			verbModes: { append: "追加", replace: "替换" },
			configured: (count: number) => `已配置 ${count} 项`,
			outputModes: { hidden: "隐藏", summary: "摘要", preview: "预览" },
			diffLayouts: { auto: "自动", unified: "统一", split: "左右分栏" },
			lines: (count: number) => `${count} 行`,
			current: (value: string) => `当前值：${value}`,
			range: (min: number, max: number) => `范围：${min}–${max}`,
			maxChars: (max: number) => `最多 ${max} 个字符`,
		},
		errors: {
			integer: (min: number, max: number) => `请输入 ${min} 到 ${max} 之间的整数。`,
			theme: (max: number) => `请输入非空的 Shiki 主题名，最多 ${max} 个字符。`,
		},
	},
} as const;

type SettingsCopy = (typeof COPY)[SettingsLanguage];

function cycleValue<T>(current: T, order: readonly T[]): T {
	const currentIndex = order.indexOf(current);
	return order[(currentIndex + 1) % order.length]!;
}

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
	return { ...config, icons: { mode: cycleValue(config.icons.mode, order) } };
}

function toggleEnabled(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function toggleLanguage(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, settingsLanguage: config.settingsLanguage === "en" ? "zh" : "en" };
}

function toggleAutocompleteDirection(config: OpenTuiConfig): OpenTuiConfig {
	const direction: AutocompleteDirection = config.editor.autocompleteDirection === "down" ? "up" : "down";
	return { ...config, editor: { ...config.editor, autocompleteDirection: direction } };
}

function cycleWheelScrollLines(config: OpenTuiConfig): OpenTuiConfig {
	const current = config.fullscreen.wheelScrollLines;
	const wheelScrollLines = current >= MAX_FULLSCREEN_WHEEL_SCROLL_LINES
		? MIN_FULLSCREEN_WHEEL_SCROLL_LINES
		: current + 1;
	return { ...config, fullscreen: { ...config.fullscreen, wheelScrollLines } };
}

function toggleTelemetry(config: OpenTuiConfig, key: keyof OpenTuiConfig["telemetry"]): OpenTuiConfig {
	return {
		...config,
		telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
	};
}

type SpinnerBooleanKey = {
	[K in keyof OpenTuiConfig["spinner"]]: OpenTuiConfig["spinner"][K] extends boolean ? K : never;
}[keyof OpenTuiConfig["spinner"]];

function toggleSpinner(config: OpenTuiConfig, key: SpinnerBooleanKey): OpenTuiConfig {
	return {
		...config,
		spinner: { ...config.spinner, [key]: !config.spinner[key] },
	};
}

function cycleSpinnerEffortDisplay(config: OpenTuiConfig): OpenTuiConfig {
	const effortDisplay: SpinnerEffortDisplay = config.spinner.effortDisplay === "effective" ? "off" : "effective";
	return { ...config, spinner: { ...config.spinner, effortDisplay } };
}

function cycleSpinnerTaskIntegration(config: OpenTuiConfig): OpenTuiConfig {
	const taskIntegration: SpinnerTaskIntegration = config.spinner.taskIntegration === "events" ? "off" : "events";
	return { ...config, spinner: { ...config.spinner, taskIntegration } };
}

function cycleSpinnerVerbMode(config: OpenTuiConfig): OpenTuiConfig {
	const mode: SpinnerVerbMode = config.spinner.verbs.mode === "append" ? "replace" : "append";
	return { ...config, spinner: { ...config.spinner, verbs: { ...config.spinner.verbs, mode } } };
}

function updateTools(config: OpenTuiConfig, update: Partial<ToolRenderingConfig>): OpenTuiConfig {
	return { ...config, toolRendering: { ...config.toolRendering, ...update } };
}

function handleToolSettingChange(itemId: string, config: OpenTuiConfig): OpenTuiConfig {
	const tools = config.toolRendering;
	switch (itemId) {
		case "enabled": return updateTools(config, { enabled: !tools.enabled });
		case "groupToolCalls": return updateTools(config, { groupToolCalls: !tools.groupToolCalls });
		case "readOutputMode": return updateTools(config, { readOutputMode: cycleValue(tools.readOutputMode, OUTPUT_MODE_ORDER) });
		case "searchOutputMode": return updateTools(config, { searchOutputMode: cycleValue(tools.searchOutputMode, OUTPUT_MODE_ORDER) });
		case "bashOutputMode": return updateTools(config, { bashOutputMode: cycleValue(tools.bashOutputMode, OUTPUT_MODE_ORDER) });
		case "mcpOutputMode": return updateTools(config, { mcpOutputMode: cycleValue(tools.mcpOutputMode, OUTPUT_MODE_ORDER) });
		case "openAiOutputMode": return updateTools(config, { openAiOutputMode: cycleValue(tools.openAiOutputMode, OUTPUT_MODE_ORDER) });
		case "livePreview": return updateTools(config, { livePreview: !tools.livePreview });
		case "diffLayout": return updateTools(config, { diffLayout: cycleValue(tools.diffLayout, DIFF_LAYOUT_ORDER) });
		default: return config;
	}
}

function updateNumericToolSetting(config: OpenTuiConfig, itemId: Exclude<ToolEditableSettingId, "diffTheme">, value: number): OpenTuiConfig {
	switch (itemId) {
		case "previewLines": return updateTools(config, { previewLines: value });
		case "expandedPreviewMaxLines": return updateTools(config, { expandedPreviewMaxLines: value });
		case "livePreviewLines": return updateTools(config, { livePreviewLines: value });
		case "diffCollapsedLines": return updateTools(config, { diffCollapsedLines: value });
	}
}

function isToolEditableSettingId(itemId: string): itemId is ToolEditableSettingId {
	return Object.prototype.hasOwnProperty.call(TOOL_EDIT_SPECS, itemId);
}

function rawToolSettingValue(config: ToolRenderingConfig, itemId: ToolEditableSettingId): string {
	switch (itemId) {
		case "previewLines": return String(config.previewLines);
		case "expandedPreviewMaxLines": return String(config.expandedPreviewMaxLines);
		case "livePreviewLines": return String(config.livePreviewLines);
		case "diffCollapsedLines": return String(config.diffCollapsedLines);
		case "diffTheme": return config.diffTheme;
	}
}

function buildFeaturesItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const tools = config.toolRendering;
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: config.enabled ? copy.values.on : copy.values.off },
		{ id: "settingsLanguage", label: copy.labels.language, currentValue: copy.values.languages[config.settingsLanguage] },
		{
			id: "autocompleteDirection",
			label: copy.labels.autocompleteDirection,
			currentValue: copy.values.autocompleteDirections[config.editor.autocompleteDirection],
		},
		{
			id: "wheelScrollLines",
			label: copy.labels.wheelScrollLines,
			currentValue: copy.values.wheelLines(config.fullscreen.wheelScrollLines),
		},
		{
			id: TOOL_PANEL_ITEM_ID,
			label: copy.labels.toolRenderingPanel,
			currentValue: `${tools.enabled ? copy.values.on : copy.values.off} · ${tools.groupToolCalls ? copy.values.grouped : copy.values.ungrouped}`,
		},
	];
}

function buildIconsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	return [{ id: "mode", label: copy.labels.iconMode, currentValue: copy.values.icons[config.icons.mode] }];
}

function buildSpinnerItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const spinner = config.spinner;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: flag(spinner.enabled) },
		{ id: "verbose", label: copy.labels.spinnerVerbose, currentValue: flag(spinner.verbose) },
		{ id: "reducedMotion", label: copy.labels.reducedMotion, currentValue: flag(spinner.reducedMotion) },
		{ id: "showThinking", label: copy.labels.showThinking, currentValue: flag(spinner.showThinking) },
		{ id: "showTimer", label: copy.labels.showTimer, currentValue: flag(spinner.showTimer) },
		{ id: "showTokens", label: copy.labels.showTokens, currentValue: flag(spinner.showTokens) },
		{ id: "showStall", label: copy.labels.showStall, currentValue: flag(spinner.showStall) },
		{ id: "showSuffix", label: copy.labels.showSuffix, currentValue: flag(spinner.showSuffix) },
		{
			id: "effortDisplay",
			label: copy.labels.effortDisplay,
			currentValue: copy.values.effortDisplays[spinner.effortDisplay],
		},
		{
			id: "taskIntegration",
			label: copy.labels.taskIntegration,
			currentValue: copy.values.taskIntegrations[spinner.taskIntegration],
		},
		{
			id: "suppressFooterWorkingTimer",
			label: copy.labels.suppressFooterWorkingTimer,
			currentValue: flag(spinner.suppressFooterWorkingTimer),
		},
		{
			id: "verbMode",
			label: copy.labels.verbMode,
			currentValue: copy.values.verbModes[spinner.verbs.mode],
		},
		{
			id: "customVerbs",
			label: copy.labels.customVerbs,
			currentValue: copy.values.configured(spinner.verbs.values.length),
		},
	];
}

function buildSegmentsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const segs = config.footerSegments;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
		{ id: "sessionName", label: copy.labels.sessionName, currentValue: flag(segs.sessionName) },
		{ id: "gitBranch", label: copy.labels.gitBranch, currentValue: flag(segs.gitBranch) },
		{ id: "gitStatus", label: copy.labels.gitStatus, currentValue: flag(segs.gitStatus) },
		{ id: "gitCommit", label: copy.labels.gitCommit, currentValue: flag(segs.gitCommit) },
		{ id: "runtime", label: copy.labels.runtime, currentValue: flag(segs.runtime) },
		{ id: "context", label: copy.labels.context, currentValue: flag(segs.context) },
		{ id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
		{ id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
		{ id: "extensionStatuses", label: copy.labels.extensionStatuses, currentValue: flag(segs.extensionStatuses) },
		{ id: "timer", label: copy.labels.timer, currentValue: flag(segs.timer) },
	];
}

function buildTelemetryItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: flag(telemetry.enabled) },
		{ id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
		{ id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
		{ id: "duration", label: copy.labels.totalDuration, currentValue: flag(telemetry.duration) },
		{ id: "tokens", label: copy.labels.tokenCounts, currentValue: flag(telemetry.tokens) },
		{ id: "stalls", label: copy.labels.stallDetails, currentValue: flag(telemetry.stalls) },
		{ id: "cost", label: copy.labels.costRate, currentValue: flag(telemetry.cost) },
	];
}

function buildToolItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const tools = config.toolRendering;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "enabled", label: copy.labels.toolRenderingEnabled, currentValue: flag(tools.enabled) },
		{ id: "groupToolCalls", label: copy.labels.groupToolCalls, currentValue: flag(tools.groupToolCalls) },
		{ id: "readOutputMode", label: copy.labels.readOutputMode, currentValue: copy.values.outputModes[tools.readOutputMode] },
		{ id: "searchOutputMode", label: copy.labels.searchOutputMode, currentValue: copy.values.outputModes[tools.searchOutputMode] },
		{ id: "bashOutputMode", label: copy.labels.bashOutputMode, currentValue: copy.values.outputModes[tools.bashOutputMode] },
		{ id: "mcpOutputMode", label: copy.labels.mcpOutputMode, currentValue: copy.values.outputModes[tools.mcpOutputMode] },
		{ id: "openAiOutputMode", label: copy.labels.openAiOutputMode, currentValue: copy.values.outputModes[tools.openAiOutputMode] },
		{ id: "previewLines", label: copy.labels.previewLines, currentValue: copy.values.lines(tools.previewLines) },
		{ id: "expandedPreviewMaxLines", label: copy.labels.expandedPreviewMaxLines, currentValue: copy.values.lines(tools.expandedPreviewMaxLines) },
		{ id: "livePreview", label: copy.labels.livePreview, currentValue: flag(tools.livePreview) },
		{ id: "livePreviewLines", label: copy.labels.livePreviewLines, currentValue: copy.values.lines(tools.livePreviewLines) },
		{ id: "diffLayout", label: copy.labels.diffLayout, currentValue: copy.values.diffLayouts[tools.diffLayout] },
		{ id: "diffCollapsedLines", label: copy.labels.diffCollapsedLines, currentValue: copy.values.lines(tools.diffCollapsedLines) },
		{ id: "diffTheme", label: copy.labels.diffTheme, currentValue: tools.diffTheme },
	];
}

function buildItems(tab: Tab, config: OpenTuiConfig): SettingItem[] {
	const copy = COPY[config.settingsLanguage];
	switch (tab) {
		case "features": return buildFeaturesItems(config, copy);
		case "icons": return buildIconsItems(config, copy);
		case "spinner": return buildSpinnerItems(config, copy);
		case "segments": return buildSegmentsItems(config, copy);
		case "telemetry": return buildTelemetryItems(config, copy);
	}
}

function handleSettingChange(tab: Tab, itemId: string, config: OpenTuiConfig): OpenTuiConfig {
	if (tab === "features") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "settingsLanguage") return toggleLanguage(config);
		if (itemId === "autocompleteDirection") return toggleAutocompleteDirection(config);
		if (itemId === "wheelScrollLines") return cycleWheelScrollLines(config);
	}
	if (tab === "icons" && itemId === "mode") return cycleIconMode(config);
	if (tab === "spinner") {
		if (itemId === "effortDisplay") return cycleSpinnerEffortDisplay(config);
		if (itemId === "taskIntegration") return cycleSpinnerTaskIntegration(config);
		if (itemId === "verbMode") return cycleSpinnerVerbMode(config);
		if (itemId === "customVerbs") return config;
		return toggleSpinner(config, itemId as SpinnerBooleanKey);
	}
	if (tab === "segments") return toggleSetting(config, itemId as keyof OpenTuiConfig["footerSegments"]);
	if (tab === "telemetry") return toggleTelemetry(config, itemId as keyof OpenTuiConfig["telemetry"]);
	return config;
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

interface ToolEditState {
	id: ToolEditableSettingId;
	input: Input;
	error?: string;
}

class SettingsUi implements SettingsUiHandle {
	private view: SettingsView = "main";
	private tab: Tab = "features";
	private config: OpenTuiConfig;
	private selectList: SelectList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private selectedToolItem: string | undefined;
	private toolEdit: ToolEditState | undefined;
	private readonly container: Box;
	private readonly theme: Theme;
	private readonly onChange: (config: OpenTuiConfig) => void;
	private readonly onClose: () => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private compact = false;

	constructor(theme: Theme, config: OpenTuiConfig, onChange: (config: OpenTuiConfig) => void, onClose: () => void) {
		this.theme = theme;
		this.config = config;
		this.onChange = onChange;
		this.onClose = onClose;
		this.container = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		this.selectList = this.createSelectList([]);
		this.rebuild();
	}

	private createSelectList(items: SelectItem[]): SelectList {
		return new SelectList(items, Math.max(1, Math.min(items.length, 10)), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
	}

	private applySetting(itemId: string): void {
		if (this.view === "tools") {
			this.selectedToolItem = itemId;
			if (isToolEditableSettingId(itemId)) {
				this.startToolEdit(itemId);
				return;
			}
			this.config = handleToolSettingChange(itemId, this.config);
			this.onChange(this.config);
			this.rebuild(itemId);
			return;
		}

		this.selectedItemByTab[this.tab] = itemId;
		if (this.tab === "features" && itemId === TOOL_PANEL_ITEM_ID) {
			this.view = "tools";
			this.rebuild(this.selectedToolItem);
			return;
		}
		this.config = handleSettingChange(this.tab, itemId, this.config);
		this.onChange(this.config);
		this.rebuild(itemId);
	}

	private startToolEdit(itemId: ToolEditableSettingId): void {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value) => this.commitToolEdit(value);
		input.onEscape = () => this.cancelToolEdit();
		this.toolEdit = { id: itemId, input };
		this.rebuild(itemId);
	}

	private commitToolEdit(rawValue: string): void {
		const edit = this.toolEdit;
		if (!edit) return;
		const copy = COPY[this.config.settingsLanguage];
		const value = rawValue.trim();

		if (edit.id === "diffTheme") {
			const maxLength = TOOL_EDIT_SPECS.diffTheme.maxLength;
			if (!value || value.length > maxLength) {
				edit.error = copy.errors.theme(maxLength);
				this.rebuild(edit.id);
				return;
			}
			this.config = updateTools(this.config, { diffTheme: value });
		} else {
			const spec = TOOL_EDIT_SPECS[edit.id];
			if (!/^\d+$/.test(value)) {
				edit.error = copy.errors.integer(spec.min, spec.max);
				this.rebuild(edit.id);
				return;
			}
			const parsed = Number.parseInt(value, 10);
			if (parsed < spec.min || parsed > spec.max) {
				edit.error = copy.errors.integer(spec.min, spec.max);
				this.rebuild(edit.id);
				return;
			}
			this.config = updateNumericToolSetting(this.config, edit.id, parsed);
		}

		this.onChange(this.config);
		this.toolEdit = undefined;
		this.rebuild(edit.id);
	}

	private cancelToolEdit(): void {
		const itemId = this.toolEdit?.id;
		this.toolEdit = undefined;
		this.rebuild(itemId);
	}

	private leaveToolPanel(): void {
		this.toolEdit = undefined;
		this.view = "main";
		this.tab = "features";
		this.rebuild(TOOL_PANEL_ITEM_ID);
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.rebuild();
	}

	private rebuild(preferredItemId?: string): void {
		const copy = COPY[this.config.settingsLanguage];
		this.container.clear();
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", copy.title)), 1, 0));

		if (this.view === "tools") {
			this.rebuildTools(copy, preferredItemId);
		} else {
			this.rebuildMain(copy, preferredItemId ?? this.selectedItemByTab[this.tab]);
		}

		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private rebuildMain(copy: SettingsCopy, preferredItemId?: string): void {
		const tabBar = TABS.map((tab) => {
			const active = tab === this.tab;
			const label = active ? `[${copy.tabs[tab]}]` : ` ${copy.tabs[tab]} `;
			return active ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
		}).join(" ");
		this.container.addChild(new Text(tabBar, 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", copy.hint), 1, 0));

		const items = buildItems(this.tab, this.config).map((item) => ({
			value: item.id,
			label: this.compact ? `${item.label}: ${item.currentValue}` : item.label,
			description: this.compact ? undefined : item.currentValue,
		} as SelectItem));
		this.installSelectList(items, preferredItemId, () => this.onClose());
	}

	private rebuildTools(copy: SettingsCopy, preferredItemId?: string): void {
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", `‹ ${copy.toolsTitle}`)), 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", this.toolEdit ? copy.editHint : copy.toolsHint), 1, 0));

		if (this.toolEdit) {
			const item = buildToolItems(this.config, copy).find((candidate) => candidate.id === this.toolEdit?.id);
			const current = rawToolSettingValue(this.config.toolRendering, this.toolEdit.id);
			const spec = TOOL_EDIT_SPECS[this.toolEdit.id];
			const constraint = "maxLength" in spec
				? copy.values.maxChars(spec.maxLength)
				: copy.values.range(spec.min, spec.max);
			this.container.addChild(new Text(this.theme.fg("accent", item?.label ?? this.toolEdit.id), 1, 0));
			this.container.addChild(new Text(this.theme.fg("muted", `${copy.values.current(current)} · ${constraint}`), 1, 0));
			this.container.addChild(this.toolEdit.input);
			if (this.toolEdit.error) {
				this.container.addChild(new Text(this.theme.fg("warning", this.toolEdit.error), 1, 0));
			}
			return;
		}

		const items = buildToolItems(this.config, copy).map((item) => ({
			value: item.id,
			label: this.compact ? `${item.label}: ${item.currentValue}` : item.label,
			description: this.compact ? undefined : item.currentValue,
		} as SelectItem));
		this.installSelectList(items, preferredItemId ?? this.selectedToolItem, () => this.leaveToolPanel());
	}

	private installSelectList(items: SelectItem[], preferredItemId: string | undefined, onCancel: () => void): void {
		this.selectList = this.createSelectList(items);
		const selectedIndex = items.findIndex((item) => item.value === preferredItemId);
		if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);

		const selectedValue = this.selectList.getSelectedItem()?.value;
		if (this.view === "tools") this.selectedToolItem = selectedValue;
		else this.selectedItemByTab[this.tab] = selectedValue;

		this.selectList.onSelectionChange = (item) => {
			if (this.view === "tools") this.selectedToolItem = item.value;
			else this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => this.applySetting(item.value);
		this.selectList.onCancel = onCancel;
		this.container.addChild(this.selectList);
	}

	handleInput(data: string): void {
		if (this.toolEdit) {
			if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
				this.commitToolEdit(this.toolEdit.input.getValue());
			} else if (matchesKey(data, Key.escape)) {
				this.cancelToolEdit();
			} else {
				this.toolEdit.input.handleInput(data);
			}
			this.invalidate();
			return;
		}

		if (this.view === "tools") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
				this.leaveToolPanel();
				this.invalidate();
				return;
			}
			if (matchesKey(data, "q")) {
				this.onClose();
				return;
			}
			if (matchesKey(data, Key.space) || data === " ") {
				const selected = this.selectList.getSelectedItem();
				if (selected) this.applySetting(selected.value);
			} else {
				this.selectList.handleInput?.(data);
			}
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.applySetting(selected.value);
		} else {
			this.selectList.handleInput?.(data);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const compact = width <= 60;
		if (compact !== this.compact) {
			this.compact = compact;
			this.rebuild();
		}
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
		onOverlayClosed?: () => void;
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
					(config) => {
						hooks.onConfigChanged(config);
						applyFullscreenWheelScrollLines(tui, config.fullscreen.wheelScrollLines);
					},
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
			// Overlay is closed and focus is back on the editor. Deferred UI changes
			// (e.g. toggling the extension) run here, so pi core's focus restore
			// cannot strand the overlay without keyboard input.
			hooks.onOverlayClosed?.();
		},
	});
}
