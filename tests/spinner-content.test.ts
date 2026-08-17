import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_SPINNER_MESSAGE_CODE_POINTS,
	resolveSpinnerMessage,
	sanitizeSpinnerMessage,
	selectCurrentSpinnerTask,
	type SpinnerTask,
} from "../extensions/open-tui/spinner-content.ts";

const currentTask: SpinnerTask = {
	id: 1,
	subject: "Fix authentication",
	activeForm: "Fixing authentication",
	status: "in_progress",
};

test("resolves override, active form, subject, and random verb in order", () => {
	assert.equal(resolveSpinnerMessage({
		overrideMessage: "Reviewing security",
		currentTask,
		randomVerb: "Working",
	}), "Reviewing security");
	assert.equal(resolveSpinnerMessage({
		overrideMessage: null,
		currentTask,
		randomVerb: "Working",
	}), "Fixing authentication");
	assert.equal(resolveSpinnerMessage({
		overrideMessage: null,
		currentTask: { ...currentTask, activeForm: undefined },
		randomVerb: "Working",
	}), "Fix authentication");
	assert.equal(resolveSpinnerMessage({
		overrideMessage: null,
		currentTask: null,
		randomVerb: "Working",
	}), "Working");
});

test("normalizes one trailing ellipsis without changing Unicode content", () => {
	assert.equal(sanitizeSpinnerMessage("正在检查…"), "正在检查");
	assert.equal(sanitizeSpinnerMessage("Testing......"), "Testing");
	assert.equal(sanitizeSpinnerMessage("It's checking 🔍..."), "It's checking 🔍");
});

test("rejects multiline and terminal controls and caps by code point", () => {
	assert.equal(sanitizeSpinnerMessage("line\nbreak"), null);
	assert.equal(sanitizeSpinnerMessage("bad\x1b[31m"), null);
	assert.equal(sanitizeSpinnerMessage("\t"), null);
	const long = "🔍".repeat(MAX_SPINNER_MESSAGE_CODE_POINTS + 10);
	assert.equal(Array.from(sanitizeSpinnerMessage(long) ?? "").length, MAX_SPINNER_MESSAGE_CODE_POINTS);
});

test("selects only the first in-progress task", () => {
	const tasks: SpinnerTask[] = [
		{ id: 1, subject: "Pending", status: "pending" },
		{ id: 2, subject: "Current", status: "in_progress" },
		{ id: 3, subject: "Second current", status: "in_progress" },
	];
	assert.equal(selectCurrentSpinnerTask(tasks)?.id, 2);
	assert.equal(selectCurrentSpinnerTask(tasks.map((task) => ({ ...task, status: "completed" }))), null);
});
