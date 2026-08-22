/**
 * Ownership marker for session worktrees under `~/.omp/wt/`.
 *
 * Each session worktree has a sibling marker file `<worktreesRoot>/<basename(worktreePath)>.owner`
 * identifying the live omp process that created or reopened it. `omp worktree clear` consults
 * the marker so it never removes or destroys a live session worktree.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { currentProcessOwner, isProcessOwnerLive, type ProcessOwner } from "../task/isolation-ownership";

/** Recorded owner of a session worktree. */
export interface SessionWorktreeOwner extends ProcessOwner {
	/** Logical name of the worktree session. */
	name: string;
}

/** Compute the sibling `.owner` marker path for a session worktree dir. */
export function sessionWorktreeOwnerPath(worktreePath: string): string {
	const dir = path.dirname(worktreePath);
	const base = path.basename(worktreePath);
	return path.join(dir, `${base}.owner`);
}

/** Record the current process as owner of the session worktree at `worktreePath`. */
export async function writeSessionWorktreeOwner(worktreePath: string, name: string): Promise<void> {
	const owner = await currentProcessOwner();
	const payload: SessionWorktreeOwner = { ...owner, name };
	await Bun.write(sessionWorktreeOwnerPath(worktreePath), JSON.stringify(payload));
}

/** Remove the session worktree owner marker if present. */
export async function removeSessionWorktreeOwner(worktreePath: string): Promise<void> {
	try {
		await fs.unlink(sessionWorktreeOwnerPath(worktreePath));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Read the live session worktree owner, or `null` if the marker is missing,
 * malformed, or the recorded owner process is no longer live.
 */
export async function readLiveSessionWorktreeOwner(
	worktreePath: string,
): Promise<{ pid: number; name: string } | null> {
	const markerPath = sessionWorktreeOwnerPath(worktreePath);
	let content: string;
	try {
		content = await fs.readFile(markerPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const pid = record.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	const name = record.name;
	if (typeof name !== "string" || name.length === 0) return null;
	if (!(await isProcessOwnerLive(record))) return null;
	return { pid, name };
}
