/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import * as path from "node:path";
import { $ } from "bun";

/** Marker file written into a task-isolation base dir identifying its owner. */
export const ISOLATION_OWNER_FILE = ".omp-isolation-owner.json";

/** Stable identity for one operating-system process instance. */
export interface ProcessOwner {
	/** PID of the owning process. */
	pid: number;
	/**
	 * Process-instance start-time token for {@link pid}, when the OS can report
	 * it. Distinguishes the owner from an unrelated process that later inherits
	 * a recycled pid.
	 */
	startToken?: string;
}

/** Recorded owner of a task-isolation sandbox. */
export interface IsolationOwner extends ProcessOwner {
	/** Task id the sandbox was materialised for. */
	id: string;
}

/**
 * Boot-stable start-time token for `pid`, or `null` when the process is gone or
 * the platform cannot report it. Read from the same source on write and
 * validate so an exact string compare rejects a recycled pid.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot); other Unixes shell out to `ps -o lstart`. Platforms that report
 * neither (e.g. Windows) yield `null`, degrading to a pid-only liveness check.
 */
async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}

/** Capture the current process's PID plus its boot-stable start token when available. */
export async function currentProcessOwner(): Promise<ProcessOwner> {
	const startToken = await processStartToken(process.pid);
	return { pid: process.pid, ...(startToken ? { startToken } : {}) };
}

/**
 * Whether `owner` still identifies the same live process instance.
 *
 * `process.kill(pid, 0)` can fail with `EPERM` even when the process is alive,
 * so only `ESRCH` counts as dead. A start token rejects recycled PIDs.
 */
export async function isProcessOwnerLive(owner: unknown): Promise<boolean> {
	if (typeof owner !== "object" || owner === null || !("pid" in owner)) return false;
	const pid = owner.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if ("startToken" in owner && typeof owner.startToken === "string" && owner.startToken.length > 0) {
		const current = await processStartToken(pid);
		if (current !== null && current !== owner.startToken) return false;
	}
	return true;
}

/**
 * Record the current process as owner of the sandbox rooted at `baseDir`.
 *
 * Written before the isolation backend materialises `m` so a concurrent
 * `omp worktree clear` never sees an owner-less sandbox mid-creation.
 */
export async function writeIsolationOwner(baseDir: string, id: string): Promise<void> {
	const owner: IsolationOwner = { ...(await currentProcessOwner()), id };
	await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
}

/**
 * Whether a live omp process still owns the sandbox at `baseDir`.
 *
 * A missing or malformed marker means no verifiable owner — a crashed run or a
 * sandbox from before markers existed, both safe to reclaim.
 */
export async function hasLiveIsolationOwner(baseDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch {
		return false;
	}
	return isProcessOwnerLive(decoded);
}
