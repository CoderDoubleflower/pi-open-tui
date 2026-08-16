import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "./utils.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function isBackgroundOnlyLine(line: string): boolean {
	return stripAnsi(line).trim().length === 0;
}

export function compactUserMessageLines(lines: string[]): string[] {
	if (
		lines.length < 3
		|| !isBackgroundOnlyLine(lines[0]!)
		|| !isBackgroundOnlyLine(lines[lines.length - 1]!)
	) {
		return lines;
	}

	const compact = lines.slice(1, -1);
	compact[0] = `${OSC133_ZONE_START}${compact[0]}`;
	compact[compact.length - 1] = `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${compact[compact.length - 1]}`;
	return compact;
}

export function installCompactUserMessages(): () => void {
	const prototype = UserMessageComponent.prototype;
	const previousRender = prototype.render;
	const compactRender = function (this: UserMessageComponent, width: number): string[] {
		return compactUserMessageLines(previousRender.call(this, width));
	};

	prototype.render = compactRender;
	return () => {
		if (prototype.render === compactRender) {
			prototype.render = previousRender;
		}
	};
}
