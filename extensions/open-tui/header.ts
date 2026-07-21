import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { center, truncateToWidth } from "./utils.ts";

const LOGO_CELL = "███";
const LOGO_ANIMATION_MS = 80;

type LogoColor = "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash" | "brand";
type LogoFrame = { phase: number; active: "left" | "top" | "right" | "none"; ax: number; ay: number; flash: boolean; white: boolean };

const LOGO_FRAMES: LogoFrame[] = [
	...Array.from({ length: 4 }, (_, ay) => ({ phase: 0, active: "left" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 3 }, (_, ay) => ({ phase: 1, active: "top" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 5 }, (_, ay) => ({ phase: 2, active: "right" as const, ax: 5, ay, flash: false, white: false })),
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];

function hasCell(y: number, x: number, cells: string): boolean {
	return cells.split(" ").includes(`${y},${x}`);
}

function hasPiece(y: number, x: number, py: number, px: number, cells: string): boolean {
	return cells.split(" ").some((item) => {
		const [dy, dx] = item.split(",").map(Number);
		return y === py + dy && x === px + dx;
	});
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
	if (frame.white) {
		return hasCell(y, x, "3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5") ? "white" : "panel";
	}
	if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";

	switch (frame.active) {
		case "left":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 1,1 2,0")) return "red";
			break;
		case "top":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 0,1 0,2 1,2")) return "cyan";
			break;
		case "right":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 2,0 2,1")) return "green";
			break;
	}

	if (frame.phase === 6) {
		return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
	}
	if (frame.phase === 4) {
		if (hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
		if (hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
		if (hasCell(y, x, "4,5 5,5")) return "green";
		return "panel";
	}
	if (frame.phase >= 5) {
		if (hasCell(y, x, "3,2 3,3 3,4 4,4")) return "cyan";
		if (hasCell(y, x, "4,2 5,2 5,3 6,2")) return "red";
		if (hasCell(y, x, "5,5 6,5")) return "green";
		return "panel";
	}
	if (frame.phase <= 3 && hasCell(y, x, "6,1 6,2 6,3 6,4")) return "orange";
	if (frame.phase >= 2 && hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
	if (frame.phase >= 1 && hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
	if (frame.phase >= 3 && hasCell(y, x, "4,5 5,5 6,5 6,6")) return "green";
	return "panel";
}

function colorCell(color: LogoColor, paintBrand: (text: string) => string): string {
	switch (color) {
		case "cyan": return `\x1b[36m${LOGO_CELL}\x1b[39m`;
		case "red": return `\x1b[31m${LOGO_CELL}\x1b[39m`;
		case "green": return `\x1b[32m${LOGO_CELL}\x1b[39m`;
		case "orange":
		case "flash": return `\x1b[33m${LOGO_CELL}\x1b[39m`;
		case "white": return `\x1b[39m${LOGO_CELL}`;
		case "brand": return paintBrand(LOGO_CELL);
		default: return " ".repeat(LOGO_CELL.length);
	}
}

function renderLogo(frameIndex: number, paintBrand: (text: string) => string): string[] {
	const frame = LOGO_FRAMES[frameIndex % LOGO_FRAMES.length]!;
	const grid: LogoColor[][] = [];
	for (let y = 1; y <= 7; y++) {
		const row: LogoColor[] = [];
		for (let x = 1; x <= 8; x++) row.push(logoCellColor(frame, y, x));
		grid.push(row);
	}

	let minX = 7;
	let maxX = 0;
	for (const row of grid) {
		row.forEach((cell, x) => {
			if (cell !== "panel") {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
		});
	}
	if (maxX < minX) { minX = 0; maxX = 7; }

	return grid.map((row) => {
		let line = "";
		for (let x = minX; x <= maxX; x++) line += colorCell(row[x]!, paintBrand);
		return line;
	});
}

export class OpenTuiHeader implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly ctx: ExtensionContext;

	constructor(_pi: ExtensionAPI, ctx: ExtensionContext, tui: TUI) {
		this.ctx = ctx;
		this.timer = setInterval(() => {
			if (this.frame < LOGO_FRAMES.length - 1) {
				this.frame++;
				tui.requestRender();
			} else {
				clearInterval(this.timer);
			}
		}, LOGO_ANIMATION_MS);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const paint = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);
		const bold = (s: string) => theme.bold(s);

		if (width < 24) return [paint(`Pi v${VERSION}`)];

		const lines: string[] = [];
		lines.push(bold(theme.fg("accent", "pi")) + " " + muted(`v${VERSION}`));
		lines.push("");

		for (const logoLine of renderLogo(this.frame, paint)) {
			lines.push(center(logoLine, width));
		}

		lines.push(center(bold("Let's build something great"), width));

		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}

export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
	let header: OpenTuiHeader | undefined;
	ctx.ui.setHeader((tui) => {
		header?.dispose();
		header = new OpenTuiHeader(pi, ctx, tui);
		return header;
	});
	return () => {
		header?.dispose();
		header = undefined;
		ctx.ui.setHeader(undefined);
	};
}
