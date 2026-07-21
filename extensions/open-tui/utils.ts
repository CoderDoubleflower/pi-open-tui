import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth };

export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[^\x07]*\x07/g, "");
}

export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

export function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return "no-model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function alignRight(left: string, right: string, width: number, theme: Theme): string {
	const rightW = visibleWidth(right);
	if (rightW > width) {
		right = truncateToWidth(right, width, theme.fg("dim", "..."));
	}
	const leftW = visibleWidth(left);
	const rightW2 = visibleWidth(right);
	const pad = width - leftW - rightW2;
	if (pad >= 1) {
		return left + " ".repeat(pad) + right;
	}
	const availableForLeft = Math.max(0, width - rightW2 - 1);
	const truncatedLeft =
		availableForLeft > 0 ? truncateToWidth(left, availableForLeft, theme.fg("dim", "...")) : "";
	return truncatedLeft ? truncatedLeft + " " + right : right;
}

export function stressColor(value: number, warn = 70, danger = 90): ThemeColor {
	if (value >= danger) return "error";
	if (value >= warn) return "warning";
	return "accent";
}

export function cacheHitColor(value: number): ThemeColor {
	if (value < 30) return "error";
	if (value < 70) return "warning";
	return "success";
}

export function providerColor(provider: string): ThemeColor {
	switch (provider.toLowerCase()) {
		case "anthropic":
			return "accent";
		case "openai":
		case "openai-codex":
			return "success";
		case "google":
		case "google-vertex":
			return "warning";
		case "amazon-bedrock":
			return "thinkingHigh";
		case "github-copilot":
			return "mdLink";
		case "deepseek":
			return "thinkingLow";
		case "xai":
		case "groq":
			return "error";
		default:
			return "muted";
	}
}

export function effortColor(level: ThinkingLevel | string | undefined): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingMedium";
	}
}

export function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	if (/^─+$/.test(plain)) return true;
	if (/^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain)) return true;
	return false;
}

export function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isEditorBorderLine(lines[i]!)) return i;
	}
	return Math.max(0, lines.length - 1);
}

export function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "...");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

export function sanitizeStatus(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
