export type IconMode = "auto" | "nerd" | "ascii";

export interface IconGlyphs {
	cwd: string;
	git: string;
	working: string;
	done: string;
	context: string;
	model: string;
	thinking: string;
	input: string;
	output: string;
	cacheHit: string;
	cost: string;
	extensions: string;
	ahead: string;
	behind: string;
	diverged: string;
	conflicted: string;
	stashed: string;
	modified: string;
	staged: string;
	untracked: string;
	renamed: string;
	deleted: string;
}

const NERD_GLYPHS: IconGlyphs = {
	cwd: "",
	git: "",
	working: "",
	done: "",
	context: "",
	model: "",
	thinking: "",
	input: "",
	output: "",
	cacheHit: "",
	cost: "",
	extensions: "",
	ahead: "↑",
	behind: "↓",
	diverged: "⇕",
	conflicted: "=",
	stashed: "$",
	modified: "!",
	staged: "+",
	untracked: "?",
	renamed: "»",
	deleted: "✘",
};

const ASCII_GLYPHS: IconGlyphs = {
	cwd: "dir",
	git: "git",
	working: "time",
	done: "ok",
	context: "ctx",
	model: "model",
	thinking: "think",
	input: "in",
	output: "out",
	cacheHit: "cache",
	cost: "cost",
	extensions: "ext",
	ahead: "^",
	behind: "v",
	diverged: "<>",
	conflicted: "!",
	stashed: "$",
	modified: "M",
	staged: "A",
	untracked: "?",
	renamed: "R",
	deleted: "D",
};

const NERD_FONT_TERMINALS = new Set([
	"iTerm.app",
	"Ghostty",
	"WezTerm",
	"kitty",
	"rio",
	"tabby",
	"WindowsTerminal",
	"vscode",
]);

export function detectNerdFont(): boolean {
	const termProgram = process.env.TERM_PROGRAM;
	if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true;

	const lcTerminal = process.env.LC_TERMINAL;
	if (lcTerminal && NERD_FONT_TERMINALS.has(lcTerminal)) return true;

	if (process.env.TERM === "xterm-kitty") return true;

	// Windows Terminal sets WT_SESSION (not TERM_PROGRAM)
	if (process.env.WT_SESSION) return true;

	// VS Code integrated terminal
	if (process.env.TERM_PROGRAM === "vscode") return true;

	return false;
}

export function resolveIconMode(mode: IconMode): "nerd" | "ascii" {
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	return detectNerdFont() ? "nerd" : "ascii";
}

export function resolveGlyphs(mode: IconMode): IconGlyphs {
	const resolved = resolveIconMode(mode);
	return resolved === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}

const RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "\uE718",
	rust: "\uE7A8",
	go: "\uE626",
	python: "\uE73C",
	ruby: "\uE739",
	java: "\uE256",
	cpp: "\uE61D",
	c: "\uE61E",
	swift: "\uE755",
	kotlin: "\uE634",
	deno: "\uE7FB",
	bun: "\uE6FB",
	php: "\uE73D",
	haskell: "\uE777",
	julia: "\uE624",
	lua: "\uE620",
	elixir: "\uE62B",
	erlang: "\uE7B1",
	gleam: "\uE6B4",
	crystal: "\uE62F",
	dart: "\uE7C0",
	nim: "\uE677",
	zig: "\uE6A9",
	ocaml: "\uE67A",
	clojure: "\uE76A",
	scala: "\uE747",
	perl: "\uE769",
	r: "\uE68A",
	elm: "\uE62C",
	haxe: "\uE7B7",
	vagrant: "\uE21A",
	terraform: "\uE1A5",
};

const RUNTIME_ASCII_SYMBOLS: Record<string, string> = {
	nodejs: "node",
	rust: "rs",
	go: "go",
	python: "py",
	ruby: "rb",
	java: "java",
	swift: "swift",
	kotlin: "kt",
	cpp: "c++",
	c: "c",
	deno: "deno",
	bun: "bun",
	php: "php",
	haskell: "hs",
	julia: "jl",
	lua: "lua",
	elixir: "ex",
	erlang: "erl",
	gleam: "gleam",
	crystal: "cr",
	dart: "dart",
	nim: "nim",
	zig: "zig",
	ocaml: "ml",
	clojure: "clj",
	scala: "scala",
	perl: "pl",
	r: "R",
	elm: "elm",
	haxe: "hx",
	vagrant: "vag",
	terraform: "tf",
};

export function runtimeSymbol(name: string, mode: IconMode): string {
	if (resolveIconMode(mode) === "ascii") return RUNTIME_ASCII_SYMBOLS[name] ?? name;
	return RUNTIME_SYMBOLS[name] ?? "";
}
