/**
 * CLI handler for `omp worktree` — list and safely remove agent-managed worktrees.
 *
 * Layout under `~/.omp/wt/`:
 *
 *   - **Session worktrees** (`omp --worktree` / `-w`): regular linked git
 *     worktrees on `worktree-*` branches.
 *   - **PR-checkout worktrees** (`tools/gh.ts`): regular linked git worktrees
 *     on `pr-*` branches.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. `ensureIsolation` writes an ownership
 *     marker naming the live omp process; a sandbox whose owner is still
 *     running is reported `live` and never removed without `--all`, so `clear`
 *     reclaims only crashed leftovers.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, hashPath, isEnoent, samePath } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { FileLockContentionError, withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	hasLiveIsolationOwner,
	ISOLATION_OWNER_FILE,
	isProcessOwnerLive,
	type ProcessOwner,
} from "../task/isolation-ownership";
import * as git from "../utils/git";
import { readLiveSessionWorktreeOwner, removeSessionWorktreeOwner } from "./session-worktree-owner";

type WorktreeKind = "pr-checkout" | "session" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;
const OMP_SESSION_LOCK_RE = /^omp session ([A-Za-z0-9._/-]+) \(pid (\d+); start ([^)]*)\)$/;

interface ManagedRoot {
	path: string;
	canonicalPath: string;
}

interface WorktreeScan {
	entries: WorktreeEntry[];
	root: ManagedRoot | null;
}

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.omp/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `omp worktree clear` will remove it. */
	orphanReason?: string;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry except active sessions with a live owner or lock. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}

export interface RemoveWorktreeOptions {
	/** Resolve relative paths and repository-scoped names from this directory. */
	cwd: string;
	/** Preview without unlocking, unregistering, deleting files, or deleting a branch. */
	dryRun: boolean;
	/** Override target-local lock, dirty-tree, and unique-commit refusals. */
	force: boolean;
	json: boolean;
	/** Exact registered path or logical worktree name. */
	target: string;
}

export type RemoveWorktreeStatus = "not-found" | "refused" | "removed" | "would-remove";
export type RemoveWorktreeBranchAction = "deleted" | "kept" | "none" | "would-delete" | "would-keep";

/** Stable machine-readable result emitted by `omp worktree remove --json`. */
export interface RemoveWorktreeResult {
	branch: string | null;
	branchAction: RemoveWorktreeBranchAction;
	candidates: string[];
	name: string | null;
	path: string | null;
	reason: string | null;
	status: RemoveWorktreeStatus;
	target: string;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const { entries } = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason ? chalk.yellow("orphaned") : chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${entries.length} total`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const { entries, root } = await scanWorktrees();
	if (!root) {
		if (options.json) {
			console.log(JSON.stringify(options.dryRun ? { wouldRemove: [] } : { removed: 0, kept: 0 }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
	}

	const candidates = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);
	const targets: WorktreeEntry[] = [];
	const skipped: { path: string; message: string }[] = [];

	for (const candidate of candidates) {
		const liveOwner = await readLiveSessionWorktreeOwner(candidate.path);
		if (liveOwner) {
			skipped.push({
				path: candidate.path,
				message: `active session "${liveOwner.name}", pid ${liveOwner.pid}`,
			});
			continue;
		}
		if (candidate.parentRepo) {
			const list = await git.worktree.list(candidate.parentRepo).catch(() => []);
			const reg = list.find(entry => samePath(entry.path, candidate.path));
			if (reg?.locked !== undefined) {
				const lockName = worktreeLogicalName(candidate);
				const lockState = await classifyWorktreeLock(reg.locked, lockName);
				if (lockState === "exact-live") {
					skipped.push({
						path: candidate.path,
						message: "locked by live session",
					});
					continue;
				}
			}
		}
		targets.push(candidate);
	}

	if (!options.json) {
		for (const s of skipped) {
			console.log(`${chalk.yellow("skipped")}  ${s.path} (${s.message})`);
		}
	}

	if (targets.length === 0) {
		if (!options.dryRun) {
			await sweepOrphanedOwnerFiles(root.path);
		}
		if (options.json) {
			console.log(JSON.stringify(options.dryRun ? { wouldRemove: [] } : { removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed.`));
		}
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.parentRepo) {
				await assertSafeManagedDirectory(root, target.path);
				const primaryRepo = (await git.repo.primaryRoot(target.parentRepo).catch(() => null)) ?? target.parentRepo;
				const canonicalPrimary = await fs.realpath(primaryRepo).catch(() => primaryRepo);
				const repoLockTarget = path.join(root.canonicalPath, `.session-${hashPath(canonicalPrimary)}`);
				let skippedInLock = false;
				try {
					await withFileLock(
						repoLockTarget,
						() =>
							git.withRepoLock(target.parentRepo!, async () => {
								await assertSafeManagedDirectory(root, target.path);
								const liveOwner = await readLiveSessionWorktreeOwner(target.path);
								if (liveOwner) {
									skippedInLock = true;
									if (!options.json) {
										console.log(
											`${chalk.yellow("skipped")}  ${target.path} (active session "${liveOwner.name}", pid ${liveOwner.pid})`,
										);
									}
									return;
								}
								const list = await git.worktree.list(target.parentRepo!).catch(() => []);
								const reg = list.find(entry => samePath(entry.path, target.path));
								if (reg?.locked !== undefined) {
									const lockName = worktreeLogicalName(target);
									const lockState = await classifyWorktreeLock(reg.locked, lockName);
									if (lockState === "exact-live") {
										skippedInLock = true;
										if (!options.json) {
											console.log(`${chalk.yellow("skipped")}  ${target.path} (locked by live session)`);
										}
										return;
									}
								}
								if (!target.orphanReason) {
									await git.worktree.tryUnlock(target.parentRepo!, target.path);
									await assertSafeManagedDirectory(root, target.path);
									const removed = await git.worktree.tryRemove(target.parentRepo!, target.path, {
										force: true,
									});
									if (!removed) {
										await assertSafeManagedDirectory(root, target.path);
										await fs.rm(target.path, { recursive: true, force: true });
										parentsToPrune.add(target.parentRepo!);
									}
								} else {
									await fs.rm(target.path, { recursive: true, force: true });
									parentsToPrune.add(target.parentRepo!);
								}
								await removeSessionWorktreeOwner(target.path);
							}),
						{ retries: 40, retryDelayMs: 50 },
					);
				} catch (err) {
					if (err instanceof FileLockContentionError) {
						throw new Error(
							"Could not acquire worktree lock due to a concurrent omp launch or removal; retry the command.",
						);
					}
					throw err;
				}
				if (!skippedInLock) {
					results.push({ path: target.path, ok: true });
				}
			} else {
				const liveOwner = await readLiveSessionWorktreeOwner(target.path);
				if (liveOwner) {
					if (!options.json) {
						console.log(
							`${chalk.yellow("skipped")}  ${target.path} (active session "${liveOwner.name}", pid ${liveOwner.pid})`,
						);
					}
					continue;
				}
				await assertSafeManagedDirectory(root, target.path);
				await fs.rm(target.path, { recursive: true, force: true });
				await removeSessionWorktreeOwner(target.path);
				results.push({ path: target.path, ok: true });
			}
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await git.worktree.prune(parent);
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	await sweepOrphanedOwnerFiles(root.path);

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	if (failed > 0) process.exitCode = 1;
}

interface RemovalTarget {
	entry: WorktreeEntry;
	name: string | null;
	root: ManagedRoot;
}

type WorktreeLockState = "exact-live" | "exact-stale" | "foreign" | "unlocked";

export async function removeWorktree(options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
	const target = options.target.trim();
	if (!target) {
		return emitRemoveResult(
			options,
			removalFailure(options.target, "refused", "A worktree name or path is required."),
		);
	}

	const resolved = await resolveRemovalTarget(options.cwd, target);
	if ("status" in resolved) return emitRemoveResult(options, resolved);

	try {
		const result = await removeResolvedWorktree(options, target, resolved);
		return emitRemoveResult(options, result);
	} catch (error) {
		const result = removalFailure(
			target,
			"refused",
			error instanceof Error ? error.message : String(error),
			resolved.entry,
			resolved.name,
		);
		return emitRemoveResult(options, result);
	}
}

async function hasSymlinkComponent(target: string, cwd: string): Promise<boolean> {
	const resolved = path.resolve(cwd, target);
	const parsed = path.parse(resolved);
	const root = parsed.root;
	const relative = resolved.slice(root.length);
	const segments = relative.split(path.sep).filter(Boolean);

	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		if (
			process.platform === "darwin" &&
			(current === "/var" || current === "/tmp" || current === "/etc" || current === "/private")
		) {
			continue;
		}
		const stat = await fs.lstat(current).catch(() => null);
		if (stat?.isSymbolicLink()) {
			return true;
		}
	}
	return false;
}

async function resolveRemovalTarget(cwd: string, target: string): Promise<RemovalTarget | RemoveWorktreeResult> {
	const { entries, root } = await scanWorktrees();
	if (!root) return removalFailure(target, "not-found", `No registered worktree matches ${JSON.stringify(target)}.`);

	const registered = entries.filter(
		(entry): entry is WorktreeEntry & { parentRepo: string } =>
			(entry.kind === "pr-checkout" || entry.kind === "session") &&
			entry.parentRepo !== undefined &&
			entry.orphanReason === undefined,
	);
	const requestedPath = path.resolve(cwd, target);
	const hasSymlink = await hasSymlinkComponent(target, cwd);
	const exactPath = !hasSymlink ? registered.find(entry => samePath(entry.path, requestedPath)) : undefined;
	if (exactPath) {
		return { entry: exactPath, name: worktreeLogicalName(exactPath), root };
	}

	const primaryRoot = await git.repo.primaryRoot(cwd);
	const canonicalPrimaryRoot = primaryRoot ? await fs.realpath(primaryRoot).catch(() => primaryRoot) : null;
	const candidates = registered.filter(entry => {
		if (worktreeLogicalName(entry) !== target) return false;
		return canonicalPrimaryRoot === null || samePath(entry.parentRepo, canonicalPrimaryRoot);
	});
	if (candidates.length === 1) {
		const entry = candidates[0];
		return { entry, name: worktreeLogicalName(entry), root };
	}
	if (candidates.length > 1) {
		return removalFailure(
			target,
			"refused",
			`Worktree name ${JSON.stringify(target)} is ambiguous; pass an exact registered path.`,
			undefined,
			null,
			candidates.map(candidate => candidate.path).sort(),
		);
	}
	return removalFailure(
		target,
		"not-found",
		canonicalPrimaryRoot
			? `No registered worktree named ${JSON.stringify(target)} belongs to the current repository.`
			: `No registered worktree matches ${JSON.stringify(target)}.`,
	);
}

async function removeResolvedWorktree(
	options: RemoveWorktreeOptions,
	target: string,
	resolved: RemovalTarget,
): Promise<RemoveWorktreeResult> {
	const { entry, name, root } = resolved;
	const parentRepo = entry.parentRepo;
	if (!parentRepo) {
		return removalFailure(target, "refused", "The target is not a registered git worktree.", entry, name);
	}

	const primaryRepo = (await git.repo.primaryRoot(parentRepo).catch(() => null)) ?? parentRepo;
	const canonicalPrimary = await fs.realpath(primaryRepo).catch(() => primaryRepo);
	const repoLockTarget = path.join(root.canonicalPath, `.session-${hashPath(canonicalPrimary)}`);

	try {
		return await withFileLock(
			repoLockTarget,
			() =>
				git.withRepoLock(parentRepo, async () => {
					await assertSafeManagedDirectory(root, entry.path);
					const liveOwner = await readLiveSessionWorktreeOwner(entry.path);
					if (!options.force && liveOwner) {
						return removalFailure(
							target,
							"refused",
							`The worktree is owned by an active OMP session ("${liveOwner.name}", pid ${liveOwner.pid}).`,
							entry,
							name,
						);
					}
					const registration = (await git.worktree.list(parentRepo)).find(candidate =>
						samePath(candidate.path, entry.path),
					);
					if (!registration || registration.branch !== (entry.branch ? `refs/heads/${entry.branch}` : undefined)) {
						return removalFailure(
							target,
							"refused",
							"The worktree registration changed while resolving the target; retry the command.",
							entry,
							name,
						);
					}
					const lockState = await classifyWorktreeLock(registration.locked, name);
					if (!options.force) {
						if (lockState === "exact-live") {
							return removalFailure(
								target,
								"refused",
								"The worktree is locked by a live OMP session.",
								entry,
								name,
							);
						}
						if (lockState === "foreign") {
							return removalFailure(target, "refused", "The worktree has a foreign lock.", entry, name);
						}

						const status = await git.status(entry.path, { porcelainV1: true, untrackedFiles: "all", z: true });
						if (status.length > 0) {
							return removalFailure(
								target,
								"refused",
								"The worktree has modified, staged, or untracked files; use --force to remove it.",
								entry,
								name,
							);
						}
					}

					const branchRef = registration.branch;
					const expectedOid =
						registration.head ??
						(branchRef ? await git.ref.resolve(parentRepo, branchRef) : await git.head.sha(entry.path));
					if (!options.force && expectedOid && (await hasUniqueCommits(parentRepo, branchRef, expectedOid))) {
						return removalFailure(
							target,
							"refused",
							"The worktree has unique or unpublished commits; use --force to remove it.",
							entry,
							name,
						);
					}
					if (!options.force && !expectedOid) {
						return removalFailure(
							target,
							"refused",
							"Could not verify whether the worktree has unique or unpublished commits.",
							entry,
							name,
						);
					}

					const ownsBranch =
						lockState !== "foreign" && (await provesOmpBranchOwnership(root, entry, name, branchRef));
					if (options.dryRun) {
						return removalSuccess(
							target,
							entry,
							name,
							"would-remove",
							ownsBranch && expectedOid ? "would-delete" : "would-keep",
						);
					}

					if (lockState !== "unlocked") {
						if (!(await git.worktree.tryUnlock(parentRepo, entry.path))) {
							return removalFailure(target, "refused", "Could not unlock the resolved worktree.", entry, name);
						}
						const afterUnlock = (await git.worktree.list(parentRepo)).find(candidate =>
							samePath(candidate.path, entry.path),
						);
						if (
							!afterUnlock ||
							afterUnlock.locked !== undefined ||
							afterUnlock.branch !== registration.branch ||
							afterUnlock.head !== registration.head
						) {
							return removalFailure(
								target,
								"refused",
								"The worktree registration changed while unlocking it; retry the command.",
								entry,
								name,
							);
						}
					}

					await assertSafeManagedDirectory(root, entry.path);
					if (!(await git.worktree.tryRemove(parentRepo, entry.path, { force: options.force }))) {
						return removalFailure(
							target,
							"refused",
							"Git refused to remove the resolved worktree; its files and registration were kept.",
							entry,
							name,
						);
					}

					await removeSessionWorktreeOwner(entry.path);

					let branchAction: RemoveWorktreeBranchAction = branchRef ? "kept" : "none";
					if (ownsBranch && branchRef && expectedOid) {
						branchAction = (await git.ref.tryDelete(parentRepo, branchRef, expectedOid)) ? "deleted" : "kept";
					}
					return removalSuccess(target, entry, name, "removed", branchAction);
				}),
			{ retries: 40, retryDelayMs: 50 },
		);
	} catch (error) {
		if (error instanceof FileLockContentionError) {
			return removalFailure(
				target,
				"refused",
				"Could not acquire worktree lock due to a concurrent omp launch or removal; retry the command.",
				entry,
				name,
			);
		}
		throw error;
	}
}

async function classifyWorktreeLock(
	locked: string | undefined,
	expectedName: string | null,
): Promise<WorktreeLockState> {
	if (locked === undefined) return "unlocked";
	const match = OMP_SESSION_LOCK_RE.exec(locked);
	if (!match || expectedName === null || match[1] !== expectedName) return "foreign";
	const pid = Number(match[2]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return "foreign";
	let startToken: string;
	try {
		startToken = decodeURIComponent(match[3]);
	} catch {
		return "foreign";
	}
	const owner: ProcessOwner = { pid, ...(startToken ? { startToken } : {}) };
	return (await isProcessOwnerLive(owner)) ? "exact-live" : "exact-stale";
}

async function hasUniqueCommits(parentRepo: string, branchRef: string | undefined, oid: string): Promise<boolean> {
	const targetRef = branchRef ? (branchRef.startsWith("refs/") ? branchRef : `refs/heads/${branchRef}`) : undefined;
	const contained = await git.ref.containsCommit(parentRepo, oid, targetRef ? { excludeRef: targetRef } : undefined);
	return !contained;
}

async function provesOmpBranchOwnership(
	root: ManagedRoot,
	entry: WorktreeEntry,
	name: string | null,
	branchRef: string | undefined,
): Promise<boolean> {
	if (entry.kind !== "session" || !entry.parentRepo || name === null) return false;
	const encodedName = name.replaceAll("/", "+");
	if (branchRef !== `refs/heads/worktree-${encodedName}`) return false;
	const canonicalParent = await fs.realpath(entry.parentRepo).catch(() => null);
	if (!canonicalParent) return false;
	const expectedPath = path.join(root.canonicalPath, `session-${encodedName}-${hashPath(canonicalParent)}`);
	return samePath(entry.path, expectedPath) && (await isSafeManagedDirectory(root, entry.path));
}

function worktreeLogicalName(entry: WorktreeEntry): string | null {
	if (!entry.branch) return null;
	if (entry.kind === "session" && entry.branch.startsWith("worktree-")) {
		return entry.branch.slice("worktree-".length).replaceAll("+", "/");
	}
	return entry.branch;
}

function removalFailure(
	target: string,
	status: "not-found" | "refused",
	reason: string,
	entry?: WorktreeEntry,
	name: string | null = null,
	candidates: string[] = [],
): RemoveWorktreeResult {
	return {
		branch: entry?.branch ?? null,
		branchAction: "none",
		candidates,
		name,
		path: entry?.path ?? null,
		reason,
		status,
		target,
	};
}

function removalSuccess(
	target: string,
	entry: WorktreeEntry,
	name: string | null,
	status: "removed" | "would-remove",
	branchAction: RemoveWorktreeBranchAction,
): RemoveWorktreeResult {
	return {
		branch: entry.branch ?? null,
		branchAction,
		candidates: [],
		name,
		path: entry.path,
		reason: null,
		status,
		target,
	};
}

function emitRemoveResult(options: RemoveWorktreeOptions, result: RemoveWorktreeResult): RemoveWorktreeResult {
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	} else if (result.status === "removed" || result.status === "would-remove") {
		const verb = result.status === "removed" ? chalk.green("removed") : chalk.yellow("would remove");
		console.log(`${verb}  ${result.path}`);
		if (result.branch && result.branchAction !== "none") {
			console.log(`          ${chalk.dim(`branch ${result.branch}: ${result.branchAction}`)}`);
		}
	} else {
		console.log(`${chalk.red("refused")}  ${result.path ?? result.target}`);
		if (result.reason) console.log(`          ${chalk.dim(result.reason)}`);
		for (const candidate of result.candidates) console.log(`          ${chalk.dim(candidate)}`);
	}
	return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeScan> {
	const rootPath = path.resolve(getWorktreesDir());
	let canonicalRoot: string;
	let topLevel: string[];
	try {
		canonicalRoot = await fs.realpath(rootPath);
		topLevel = await fs.readdir(rootPath);
	} catch (err) {
		if (isEnoent(err)) return { entries: [], root: null };
		throw err;
	}
	const root = { path: rootPath, canonicalPath: canonicalRoot };

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root.path, name);
		if (!(await isSafeManagedDirectory(root, dir))) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			if (await isSafeManagedDirectory(root, dir)) entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			if (!(await isSafeManagedDirectory(root, childDir))) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified && (await isSafeManagedDirectory(root, childDir))) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0 && (await isSafeManagedDirectory(root, dir))) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return { entries, root };
}

function isUnder(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function isSafeManagedDirectory(root: ManagedRoot, candidate: string): Promise<boolean> {
	const absoluteCandidate = path.resolve(candidate);
	if (!isUnder(absoluteCandidate, root.path)) return false;

	const relative = path.relative(root.path, absoluteCandidate);
	let current = root.path;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		const stat = await fs.lstat(current).catch(() => null);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
	}

	const canonicalCandidate = await fs.realpath(absoluteCandidate).catch(() => null);
	return canonicalCandidate !== null && isUnder(canonicalCandidate, root.canonicalPath);
}

async function sweepOrphanedOwnerFiles(rootPath: string): Promise<void> {
	let files: string[];
	try {
		files = await fs.readdir(rootPath);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".owner")) continue;
		const markerPath = path.join(rootPath, file);
		const worktreeDir = path.join(rootPath, file.slice(0, -".owner".length));
		const stat = await fs.lstat(worktreeDir).catch(() => null);
		if (!stat?.isDirectory()) {
			await fs.unlink(markerPath).catch(() => null);
		}
	}
}

async function assertSafeManagedDirectory(root: ManagedRoot, candidate: string): Promise<void> {
	if (!(await isSafeManagedDirectory(root, candidate))) {
		throw new Error("Refusing to remove a path outside the managed worktree root or through a symbolic link.");
	}
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.lstat(gitEntry).catch(() => null);
	if (gitStat?.isFile() && !gitStat.isSymbolicLink()) {
		return classifyGitWorktree(dir, gitEntry);
	}
	// A task-isolation sandbox is identified by its ownership marker — written
	// before the backend materialises the mount — or by the `m`/`merged` mount
	// dir itself (legacy dirs and crashed pre-marker runs). Recognizing the
	// marker alone keeps an in-progress sandbox from being mistaken for a stray
	// during the window between marker creation and mount materialisation.
	const ownerStat = await fs.lstat(path.join(dir, ISOLATION_OWNER_FILE)).catch(() => null);
	let isIsolation = ownerStat?.isFile() === true && !ownerStat.isSymbolicLink();
	if (!isIsolation) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountStat = await fs.lstat(path.join(dir, mountDir)).catch(() => null);
			if (mountStat?.isDirectory() && !mountStat.isSymbolicLink()) {
				isIsolation = true;
				break;
			}
		}
	}
	if (!isIsolation) return null;
	const live = await hasLiveIsolationOwner(dir);
	return {
		path: dir,
		kind: "task-isolation",
		// Only after confirming no live owner is the "no live task" claim true.
		// A running subagent's sandbox stays live so `clear` won't delete it.
		orphanReason: live ? undefined : "task-isolation leftover (no live task owns it)",
	};
}

async function classifyGitWorktree(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const gitDirPointer = match?.[1];
	if (!gitDirPointer) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	const resolvedGitDir = path.resolve(path.dirname(gitEntry), gitDirPointer);
	const resolvedRepository = await git.repo.resolve(dir);
	const repository =
		resolvedRepository && path.resolve(resolvedRepository.gitEntryPath) === path.resolve(gitEntry)
			? resolvedRepository
			: null;
	const primaryRoot = repository ? await git.repo.primaryRoot(dir) : null;
	const headFile = repository?.headPath ?? path.join(resolvedGitDir, "HEAD");
	const branch = await readWorktreeBranch(headFile);
	const kind: WorktreeKind = branch?.startsWith("worktree-") ? "session" : "pr-checkout";
	const fallbackParentRepo = path.dirname(path.dirname(path.dirname(resolvedGitDir)));
	const parentRepo = primaryRoot ?? fallbackParentRepo;

	if (!repository) {
		return {
			path: dir,
			kind,
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		return {
			path: dir,
			kind,
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind, parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "session") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch} · isolated session`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}
