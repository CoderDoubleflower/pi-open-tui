import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface ThemeFile {
	name: string;
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: Record<string, string | number>;
}

const theme = JSON.parse(readFileSync(new URL("../themes/claude-theme.json", import.meta.url), "utf8")) as ThemeFile;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	files?: string[];
	pi?: { themes?: string[] };
};

const requiredColors = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim",
	"text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg",
	"customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle",
	"toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
	"mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
	"syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow",
	"thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

test("ships claude-theme as a pi package resource", () => {
	assert.equal(theme.name, "claude-theme");
	assert.ok(packageJson.files?.includes("themes/"));
	assert.deepEqual(packageJson.pi?.themes, ["./themes/claude-theme.json"]);
});

test("defines every required pi theme color", () => {
	for (const color of requiredColors) {
		assert.ok(Object.hasOwn(theme.colors, color), `missing theme color: ${color}`);
	}
});

test("matches Claude Code dark palette source values", () => {
	assert.equal(theme.vars.claude, "#d77757");
	assert.equal(theme.vars.claudeShimmer, "#eb9f7f");
	assert.equal(theme.vars.permission, "#b1b9f9");
	assert.equal(theme.vars.promptBorder, "#888888");
	assert.equal(theme.vars.text, "#ffffff");
	assert.equal(theme.vars.inactive, "#999999");
	assert.equal(theme.vars.subtle, "#505050");
	assert.equal(theme.vars.userMessageBg, "#373737");
	assert.equal(theme.vars.success, "#4eba65");
	assert.equal(theme.vars.error, "#ff6b80");
	assert.equal(theme.vars.warning, "#ffc107");
	assert.equal(theme.colors.bashMode, "bashBorder");
});

test("uses Claude Code Monokai Extended syntax colors", () => {
	assert.equal(theme.colors.syntaxComment, "#75715e");
	assert.equal(theme.colors.syntaxKeyword, "#f92672");
	assert.equal(theme.colors.syntaxFunction, "#a6e22e");
	assert.equal(theme.colors.syntaxVariable, "#ffffff");
	assert.equal(theme.colors.syntaxString, "#e6db74");
	assert.equal(theme.colors.syntaxNumber, "#be84ff");
	assert.equal(theme.colors.syntaxType, "#a6e22e");
	assert.equal(theme.colors.syntaxOperator, "#f92672");
	assert.equal(theme.colors.syntaxPunctuation, "#f8f8f2");
});

test("inherits tool and custom message backgrounds from the terminal", () => {
	assert.equal(theme.colors.customMessageBg, "");
	assert.equal(theme.colors.toolPendingBg, "");
	assert.equal(theme.colors.toolSuccessBg, "");
	assert.equal(theme.colors.toolErrorBg, "");
	assert.notEqual(theme.colors.userMessageBg, "");
	assert.notEqual(theme.colors.selectedBg, "");
});

test("resolves all color variables and provides explicit export backgrounds", () => {
	for (const [name, value] of Object.entries(theme.colors)) {
		if (typeof value === "string" && value !== "" && !value.startsWith("#")) {
			assert.ok(Object.hasOwn(theme.vars, value), `${name} references unknown variable: ${value}`);
		}
	}

	assert.match(String(theme.export?.pageBg), /^#[0-9a-f]{6}$/i);
	assert.match(String(theme.export?.cardBg), /^#[0-9a-f]{6}$/i);
	assert.match(String(theme.export?.infoBg), /^#[0-9a-f]{6}$/i);
});
