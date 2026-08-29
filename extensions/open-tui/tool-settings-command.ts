import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	OpenTuiConfig,
	ToolDiffLayout,
	ToolOutputMode,
	ToolRenderingConfig,
} from "./config.ts";

interface ToolSettingsHooks {
	getConfig: () => OpenTuiConfig;
	onConfigChanged: (config: OpenTuiConfig) => void;
}

type OutputTarget = "read" | "search" | "bash" | "mcp" | "openai";

const OUTPUT_KEY: Record<OutputTarget, keyof Pick<
	ToolRenderingConfig,
	"readOutputMode" | "searchOutputMode" | "bashOutputMode" | "mcpOutputMode" | "openAiOutputMode"
>> = {
	read: "readOutputMode",
	search: "searchOutputMode",
	bash: "bashOutputMode",
	mcp: "mcpOutputMode",
	openai: "openAiOutputMode",
};

function notify(ctx: ExtensionContext, message: string, level: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function parseToggle(value: string | undefined, current: boolean): boolean | undefined {
	if (value === "on") return true;
	if (value === "off") return false;
	if (!value || value === "toggle") return !current;
	return undefined;
}

function parseInteger(value: string | undefined, min: number, max: number): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const parsed = Number.parseInt(value, 10);
	return parsed >= min && parsed <= max ? parsed : undefined;
}

function updateTools(config: OpenTuiConfig, update: Partial<ToolRenderingConfig>): OpenTuiConfig {
	return { ...config, toolRendering: { ...config.toolRendering, ...update } };
}

function status(config: ToolRenderingConfig): string {
	return [
		`Tool rendering: ${config.enabled ? "on" : "off"}`,
		`Grouping: ${config.groupToolCalls ? "on" : "off"}`,
		`Outputs: read=${config.readOutputMode}, search=${config.searchOutputMode}, bash=${config.bashOutputMode}, mcp=${config.mcpOutputMode}, openai=${config.openAiOutputMode}`,
		`Preview: ${config.previewLines} lines · expanded cap ${config.expandedPreviewMaxLines}`,
		`Live preview: ${config.livePreview ? `on (${config.livePreviewLines} lines)` : "off"}`,
		`Diff: ${config.diffLayout} · ${config.diffCollapsedLines} lines · ${config.diffTheme}`,
	].join("\n");
}

function usage(): string {
	return [
		"/open-tui-tools status",
		"/open-tui-tools enabled on|off|toggle",
		"/open-tui-tools group on|off|toggle",
		"/open-tui-tools read|search|bash|mcp|openai hidden|summary|preview",
		"/open-tui-tools preview <1-50>",
		"/open-tui-tools expanded <100-20000>",
		"/open-tui-tools live on|off|toggle",
		"/open-tui-tools live-lines <1-20>",
		"/open-tui-tools diff-lines <4-200>",
		"/open-tui-tools diff-layout auto|unified|split",
		"/open-tui-tools diff-theme <shiki-theme>",
	].join("\n");
}

export function registerToolSettingsCommand(pi: ExtensionAPI, hooks: ToolSettingsHooks): void {
	pi.registerCommand("open-tui-tools", {
		description: "Configure Claude-style tool rendering",
		handler: async (rawArgs, ctx) => {
			const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
			const command = (parts[0] ?? "status").toLowerCase();
			const value = parts[1]?.toLowerCase();
			const current = hooks.getConfig();
			const tools = current.toolRendering;
			let next: OpenTuiConfig | undefined;

			if (command === "status") {
				notify(ctx, status(tools));
				return;
			}
			if (command === "help") {
				notify(ctx, usage());
				return;
			}
			if (command === "enabled" || command === "group" || command === "live") {
				const key = command === "enabled" ? "enabled" : command === "group" ? "groupToolCalls" : "livePreview";
				const parsed = parseToggle(value, tools[key]);
				if (parsed === undefined) {
					notify(ctx, `Usage: /open-tui-tools ${command} on|off|toggle`, "error");
					return;
				}
				next = updateTools(current, { [key]: parsed });
			} else if (command in OUTPUT_KEY) {
				if (value !== "hidden" && value !== "summary" && value !== "preview") {
					notify(ctx, `Usage: /open-tui-tools ${command} hidden|summary|preview`, "error");
					return;
				}
				const key = OUTPUT_KEY[command as OutputTarget];
				next = updateTools(current, { [key]: value as ToolOutputMode });
			} else if (command === "preview" || command === "expanded" || command === "live-lines" || command === "diff-lines") {
				const bounds = command === "preview" ? [1, 50]
					: command === "expanded" ? [100, 20_000]
						: command === "live-lines" ? [1, 20]
							: [4, 200];
				const parsed = parseInteger(value, bounds[0]!, bounds[1]!);
				if (parsed === undefined) {
					notify(ctx, `Expected an integer between ${bounds[0]} and ${bounds[1]}.`, "error");
					return;
				}
				const key = command === "preview" ? "previewLines"
					: command === "expanded" ? "expandedPreviewMaxLines"
						: command === "live-lines" ? "livePreviewLines"
							: "diffCollapsedLines";
				next = updateTools(current, { [key]: parsed });
			} else if (command === "diff-layout") {
				if (value !== "auto" && value !== "unified" && value !== "split") {
					notify(ctx, "Usage: /open-tui-tools diff-layout auto|unified|split", "error");
					return;
				}
				next = updateTools(current, { diffLayout: value as ToolDiffLayout });
			} else if (command === "diff-theme") {
				const theme = parts.slice(1).join(" ").trim();
				if (!theme || theme.length > 80) {
					notify(ctx, "Usage: /open-tui-tools diff-theme <shiki-theme>", "error");
					return;
				}
				next = updateTools(current, { diffTheme: theme });
			} else {
				notify(ctx, usage(), "error");
				return;
			}

			hooks.onConfigChanged(next);
			notify(ctx, status(next.toolRendering));
		},
	});
}
