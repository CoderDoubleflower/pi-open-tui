import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FooterState, ModelMeta } from "./state.ts";
import { getUsageTotals } from "./state.ts";

export const FOOTER_SCRIPT_TIMEOUT_MS = 1000;
const FOOTER_SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface FooterScriptInputV1 {
	version: 1;
	terminal: { width: number };
	time: { nowMs: number; nowIso: string };
	session: {
		cwd: string;
		name: string | null;
		startedAtMs: number;
	};
	model: {
		id: string | null;
		name: string | null;
		provider: string | null;
		reasoning: boolean | null;
		thinkingLevel: string | null;
		contextWindow: number | null;
	};
	context: {
		tokens: number | null;
		contextWindow: number | null;
		percent: number | null;
	};
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		latestCacheHitRate: number | null;
	};
	git: {
		branch: string | null;
		ahead: number;
		behind: number;
		modified: number;
		untracked: number;
		staged: number;
		stashed: number;
		conflicted: number;
		renamed: number;
		deleted: number;
		commit: {
			oid: string | null;
			detached: boolean;
			tag: string | null;
		} | null;
	};
	runtime: { name: string; version: string | null } | null;
	timer: {
		working: boolean;
		workingSinceMs: number | null;
		workingElapsedMs: number | null;
		lastDoneInMs: number | null;
	};
	extensionStatuses: Record<string, string>;
}

export function buildFooterScriptInput(
	ctx: ExtensionContext,
	state: FooterState,
	meta: ModelMeta,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	nowMs = Date.now(),
): FooterScriptInputV1 {
	const context = ctx.getContextUsage();
	const totals = getUsageTotals(ctx);
	const extensionStatuses = Object.fromEntries(
		Array.from(footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b)),
	);

	return {
		version: 1,
		terminal: { width },
		time: { nowMs, nowIso: new Date(nowMs).toISOString() },
		session: {
			cwd: ctx.sessionManager.getCwd(),
			name: ctx.sessionManager.getSessionName() ?? null,
			startedAtMs: state.sessionStartEpoch,
		},
		model: {
			id: ctx.model?.id ?? null,
			name: ctx.model?.name ?? null,
			provider: ctx.model?.provider ?? null,
			reasoning: ctx.model ? (ctx.model.reasoning ?? false) : null,
			thinkingLevel: meta.effort ?? null,
			contextWindow: ctx.model?.contextWindow ?? null,
		},
		context: {
			tokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? null,
			percent: context?.percent ?? null,
		},
		usage: {
			...totals,
			latestCacheHitRate: totals.latestCacheHitRate ?? null,
		},
		git: {
			...state.git,
			branch: state.git.branch ?? null,
			commit: state.git.commit ? { ...state.git.commit } : null,
		},
		runtime: state.runtime
			? { name: state.runtime.name, version: state.runtime.version ?? null }
			: null,
		timer: {
			working: state.workingSince !== undefined,
			workingSinceMs: state.workingSince ?? null,
			workingElapsedMs: state.workingSince === undefined ? null : Math.max(0, nowMs - state.workingSince),
			lastDoneInMs: state.lastDoneIn ?? null,
		},
		extensionStatuses,
	};
}

function scriptInputStateKey(input: FooterScriptInputV1): string {
	return JSON.stringify({
		...input,
		time: undefined,
		timer: {
			...input.timer,
			workingElapsedMs: undefined,
		},
	});
}

export function validateFooterScriptPath(path: string): void {
	if (!isAbsolute(path)) throw new Error("footerScript must be an absolute path");
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error("footerScript must point to a file");
	accessSync(path, constants.X_OK);
}

export function executeFooterScript(
	path: string,
	input: FooterScriptInputV1,
	timeoutMs = FOOTER_SCRIPT_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			validateFooterScriptPath(path);
		} catch (error) {
			reject(error);
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const child = execFile(
			path,
			[],
			{
				cwd: input.session.cwd,
				encoding: "utf8",
				maxBuffer: FOOTER_SCRIPT_MAX_BUFFER,
			},
			(error, stdout, stderr) => {
				if (timer) clearTimeout(timer);
				if (settled) return;
				settled = true;
				if (error) {
					const detail = stderr.trim();
					reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
					return;
				}
				resolve(stdout);
			},
		);
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`footerScript timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(input));
	});
}

/** Preserve SGR color sequences while removing terminal control sequences. */
export function sanitizeFooterScriptOutput(output: string): string[] {
	const normalized = output.replace(/\r\n?/g, "\n");
	let clean = "";
	for (let i = 0; i < normalized.length;) {
		const code = normalized.charCodeAt(i);
		if (code === 0x1b) {
			const kind = normalized[i + 1];
			if (kind === "[") {
				let end = i + 2;
				while (end < normalized.length) {
					const finalCode = normalized.charCodeAt(end);
					if (finalCode >= 0x40 && finalCode <= 0x7e) break;
					end++;
				}
				if (end >= normalized.length) break;
				const sequence = normalized.slice(i, end + 1);
				if (/^\x1b\[[0-9;]*m$/.test(sequence)) clean += sequence;
				i = end + 1;
				continue;
			}
			if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
				let end = i + 2;
				while (end < normalized.length) {
					if (normalized.charCodeAt(end) === 0x07) {
						end++;
						break;
					}
					if (normalized.charCodeAt(end) === 0x1b && normalized[end + 1] === "\\") {
						end += 2;
						break;
					}
					end++;
				}
				i = end;
				continue;
			}
			i += Math.min(2, normalized.length - i);
			continue;
		}
		if (code === 0x09) {
			clean += "    ";
		} else if (code === 0x0a || code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			clean += normalized[i];
		}
		i++;
	}

	clean = clean.replace(/\n+$/, "");
	if (clean.trim() === "") return [];
	return clean.split("\n").map((line) =>
		line.includes("\x1b[") && !line.endsWith("\x1b[0m") ? `${line}\x1b[0m` : line,
	);
}

interface FooterScriptRequest {
	path: string;
	input: FooterScriptInputV1;
	stateKey: string;
}

export interface FooterScriptRunnerOptions {
	execute?: (path: string, input: FooterScriptInputV1) => Promise<string>;
	notifyWarning: (message: string) => void;
	requestRender: () => void;
	now?: () => number;
}

export class FooterScriptRunner {
	private readonly execute: (path: string, input: FooterScriptInputV1) => Promise<string>;
	private readonly notifyWarning: (message: string) => void;
	private readonly requestRender: () => void;
	private readonly now: () => number;
	private path: string | undefined;
	private cachedLines: string[] | undefined;
	private lastAttemptKey: string | undefined;
	private lastStartedAt = 0;
	private running = false;
	private pending: FooterScriptRequest | undefined;
	private warned = false;
	private generation = 0;
	private disposed = false;

	constructor(options: FooterScriptRunnerOptions) {
		this.execute = options.execute ?? executeFooterScript;
		this.notifyWarning = options.notifyWarning;
		this.requestRender = options.requestRender;
		this.now = options.now ?? Date.now;
	}

	render(path: string, input: FooterScriptInputV1, width: number): string[] | undefined {
		if (this.disposed) return undefined;
		if (this.path !== path) {
			this.path = path;
			this.cachedLines = undefined;
			this.lastAttemptKey = undefined;
			this.pending = undefined;
			this.warned = false;
			this.generation++;
		}

		const request = { path, input, stateKey: scriptInputStateKey(input) };
		const periodicDue = input.timer.working && this.now() - this.lastStartedAt >= 1000;
		if (request.stateKey !== this.lastAttemptKey || periodicDue) {
			this.queue(request);
		}

		return this.cachedLines?.map((line) => truncateToWidth(line, width, ""));
	}

	disable(): void {
		if (this.path === undefined) return;
		this.path = undefined;
		this.cachedLines = undefined;
		this.lastAttemptKey = undefined;
		this.pending = undefined;
		this.warned = false;
		this.generation++;
	}

	dispose(): void {
		this.disposed = true;
		this.disable();
	}

	private queue(request: FooterScriptRequest): void {
		if (this.running) {
			this.pending = request;
			return;
		}
		void this.run(request);
	}

	private async run(request: FooterScriptRequest): Promise<void> {
		this.running = true;
		this.lastAttemptKey = request.stateKey;
		this.lastStartedAt = this.now();
		const generation = this.generation;
		try {
			const stdout = await this.execute(request.path, request.input);
			if (this.disposed || generation !== this.generation || request.path !== this.path) return;
			this.cachedLines = sanitizeFooterScriptOutput(stdout);
			this.warned = false;
			this.requestRender();
		} catch (error) {
			if (this.disposed || generation !== this.generation || request.path !== this.path) return;
			if (!this.warned) {
				this.warned = true;
				this.notifyWarning(`open-tui footerScript error: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.running = false;
			const pending = this.pending;
			this.pending = undefined;
			if (pending && !this.disposed && pending.path === this.path) {
				const periodicDue = pending.input.timer.working && this.now() - this.lastStartedAt >= 1000;
				if (pending.stateKey !== this.lastAttemptKey || periodicDue) this.queue(pending);
			}
		}
	}
}
