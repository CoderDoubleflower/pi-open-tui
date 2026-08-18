import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "./fullscreen-scroll.ts";
import type { IconMode } from "./icons.ts";
import { normalizeCustomSpinnerVerbs } from "./spinner-verbs.ts";

export type SettingsLanguage = "en" | "zh";
export type AutocompleteDirection = "up" | "down";

export type { IconMode } from "./icons.ts";

export interface FooterSegments {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	timer: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface FullscreenConfig {
	wheelScrollLines: number;
}

export type SpinnerVerbMode = "append" | "replace";
export type SpinnerEffortDisplay = "effective" | "off";
export type SpinnerTaskIntegration = "events" | "off";

export interface SpinnerConfig {
	enabled: boolean;
	verbose: boolean;
	reducedMotion: boolean;
	showThinking: boolean;
	showTimer: boolean;
	showTokens: boolean;
	showStall: boolean;
	showSuffix: boolean;
	effortDisplay: SpinnerEffortDisplay;
	taskIntegration: SpinnerTaskIntegration;
	suppressFooterWorkingTimer: boolean;
	verbs: {
		mode: SpinnerVerbMode;
		values: string[];
	};
}

export interface OpenTuiConfig {
	enabled: boolean;
	settingsLanguage: SettingsLanguage;
	footerScript: string | null;
	fullscreen: FullscreenConfig;
	editor: {
		dynamicBorderColor: boolean;
		autocompleteDirection: AutocompleteDirection;
	};
	icons: {
		mode: IconMode;
	};
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
	spinner: SpinnerConfig;
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	settingsLanguage: "en",
	footerScript: null,
	fullscreen: {
		wheelScrollLines: DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	},
	editor: {
		dynamicBorderColor: false,
		autocompleteDirection: "up",
	},
	icons: {
		mode: "auto",
	},
	footerSegments: {
		cwd: true,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		timer: true,
	},
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
	spinner: {
		enabled: false,
		verbose: false,
		reducedMotion: false,
		showThinking: true,
		showTimer: true,
		showTokens: true,
		showStall: true,
		showSuffix: true,
		effortDisplay: "effective",
		taskIntegration: "events",
		suppressFooterWorkingTimer: true,
		verbs: {
			mode: "append",
			values: [],
		},
	},
};

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}

	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const config = deepMerge(DEFAULT_CONFIG, parsed);
		if (config.settingsLanguage !== "en" && config.settingsLanguage !== "zh") {
			config.settingsLanguage = DEFAULT_CONFIG.settingsLanguage;
		}
		if (config.footerScript !== null && typeof config.footerScript !== "string") {
			config.footerScript = DEFAULT_CONFIG.footerScript;
		}
		config.fullscreen.wheelScrollLines = normalizeFullscreenWheelScrollLines(
			config.fullscreen.wheelScrollLines,
			DEFAULT_CONFIG.fullscreen.wheelScrollLines,
		);
		if (typeof config.editor.dynamicBorderColor !== "boolean") {
			config.editor.dynamicBorderColor = DEFAULT_CONFIG.editor.dynamicBorderColor;
		}
		if (config.editor.autocompleteDirection !== "up" && config.editor.autocompleteDirection !== "down") {
			config.editor.autocompleteDirection = DEFAULT_CONFIG.editor.autocompleteDirection;
		}
		if (typeof config.footerSegments.timer !== "boolean") {
			config.footerSegments.timer = DEFAULT_CONFIG.footerSegments.timer;
		}
		for (const key of [
			"enabled",
			"verbose",
			"reducedMotion",
			"showThinking",
			"showTimer",
			"showTokens",
			"showStall",
			"showSuffix",
			"suppressFooterWorkingTimer",
		] as const) {
			if (typeof config.spinner[key] !== "boolean") {
				config.spinner[key] = DEFAULT_CONFIG.spinner[key];
			}
		}
		if (config.spinner.effortDisplay !== "effective" && config.spinner.effortDisplay !== "off") {
			config.spinner.effortDisplay = DEFAULT_CONFIG.spinner.effortDisplay;
		}
		if (config.spinner.taskIntegration !== "events" && config.spinner.taskIntegration !== "off") {
			config.spinner.taskIntegration = DEFAULT_CONFIG.spinner.taskIntegration;
		}
		if (config.spinner.verbs.mode !== "append" && config.spinner.verbs.mode !== "replace") {
			config.spinner.verbs.mode = DEFAULT_CONFIG.spinner.verbs.mode;
		}
		config.spinner.verbs.values = normalizeCustomSpinnerVerbs(config.spinner.verbs.values);
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config save is best-effort
	}
}
