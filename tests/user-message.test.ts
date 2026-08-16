import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	compactUserMessageLines,
	installCompactUserMessages,
} from "../extensions/open-tui/user-message.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const START = "\x1b]133;A\x07";
const END = "\x1b]133;B\x07";
const FINAL = "\x1b]133;C\x07";
const background = (text: string) => `\x1b[48;2;58;58;58m${text.padEnd(20)}\x1b[0m`;

test("renders a single-line user message at exactly one row", () => {
	const lines = [
		`${START}${background("")}`,
		background(" message"),
		`${END}${FINAL}${background("")}`,
	];

	const compact = compactUserMessageLines(lines);

	assert.equal(compact.length, 1);
	assert.equal(stripAnsi(compact[0] ?? ""), " message".padEnd(20));
	assert.ok(compact[0]?.includes(START));
	assert.ok(compact[0]?.includes(END));
	assert.ok(compact[0]?.includes(FINAL));
});

test("renders a multi-line user message at exactly its text row count", () => {
	const lines = [
		`${START}${background("")}`,
		background(" first"),
		background(" second"),
		`${END}${FINAL}${background("")}`,
	];

	const compact = compactUserMessageLines(lines);

	assert.deepEqual(compact.map(stripAnsi), [" first".padEnd(20), " second".padEnd(20)]);
	assert.ok(compact[0]?.startsWith(START));
	assert.ok(compact[1]?.startsWith(`${END}${FINAL}`));
});

test("leaves render output unchanged without background-only edge rows", () => {
	const lines = [background("first"), background("second")];
	assert.equal(compactUserMessageLines(lines), lines);
});

test("restores the previous user message renderer during cleanup", () => {
	const prototype = UserMessageComponent.prototype;
	const originalRender = prototype.render;
	const paddedRender = () => [background(""), background("message"), background("")];
	prototype.render = paddedRender;
	const cleanup = installCompactUserMessages();

	try {
		const component = Object.create(prototype) as UserMessageComponent;
		assert.equal(component.render(20).length, 1);
		cleanup();
		assert.equal(prototype.render, paddedRender);
	} finally {
		cleanup();
		prototype.render = originalRender;
	}
});
