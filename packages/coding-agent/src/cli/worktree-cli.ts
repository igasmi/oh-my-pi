/**
 * CLI handler for `omp worktree` — list and clean up agent-managed worktrees.
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
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE } from "../task/isolation-ownership";
import * as git from "../utils/git";

type WorktreeKind = "pr-checkout" | "session" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

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
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
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
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
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
	if (!root) throw new Error("Managed worktree root disappeared before removal.");
	for (const target of targets) {
		try {
			if (
				(target.kind === "pr-checkout" || target.kind === "session") &&
				target.parentRepo &&
				!target.orphanReason
			) {
				// This branch is reachable only for explicit `--all`. Release a git
				// lock first so removal also clears its metadata; pruning deliberately
				// preserves locked entries. An unlocked worktree simply returns false.
				await assertSafeManagedDirectory(root, target.path);
				await git.worktree.tryUnlock(target.parentRepo, target.path);
				await assertSafeManagedDirectory(root, target.path);
				const removed = await git.worktree.tryRemove(target.parentRepo, target.path, { force: true });
				if (!removed) {
					await assertSafeManagedDirectory(root, target.path);
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else {
				await assertSafeManagedDirectory(root, target.path);
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
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

function isStrictDescendant(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function isSafeManagedDirectory(root: ManagedRoot, candidate: string): Promise<boolean> {
	const absoluteCandidate = path.resolve(candidate);
	if (!isStrictDescendant(root.path, absoluteCandidate)) return false;

	const relative = path.relative(root.path, absoluteCandidate);
	let current = root.path;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		const stat = await fs.lstat(current).catch(() => null);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
	}

	const canonicalCandidate = await fs.realpath(absoluteCandidate).catch(() => null);
	return canonicalCandidate !== null && isStrictDescendant(root.canonicalPath, canonicalCandidate);
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
