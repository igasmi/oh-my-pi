/**
 * Accident-prevention guardrails for isolated linked git worktrees.
 *
 * This is an ACCIDENT GUARDRAIL, NOT a security boundary — arbitrary process
 * execution (e.g. bash commands) can still mutate the primary checkout.
 *
 * Enforced surfaces:
 * - Session-header validation on resume and fork (`validateWorktreeIsolation`)
 * - Additional-directory filtering (`filterWorktreeAdditionalDirectories`)
 * - First-party write/edit tool guard: the synchronous boundary check in
 *   `tools/plan-mode-guard.ts` (`enforceWriteGuards`), which resolves targets
 *   through their nearest existing ancestor before containment testing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, lexicalPathIsWithin, lstatOptional, normalizePathForComparison, samePath } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";

/** Persisted identity and authorization boundary for an isolated linked worktree. */
export interface WorktreeIsolation {
	/** Canonical absolute path to the isolated linked worktree. */
	worktreeRoot: string;
	/** Canonical absolute path to the protected primary checkout. */
	primaryRoot: string;
	/** User-facing logical worktree name. */
	name: string;
	/** Local branch checked out in the linked worktree. */
	branch: string;
	/** Canonical absolute path to the repository's shared Git directory. */
	commonDir: string;
}

export type WorktreeIsolationValidationResult =
	| { status: "valid"; isolation: WorktreeIsolation }
	| { status: "missing"; reason: string }
	| { status: "tampered"; reason: string };

export type WorktreeIsolationErrorCode = "missing" | "tampered" | "primary" | "unverifiable";

/** A persisted binding or mutation target could not be trusted. */
export class WorktreeIsolationError extends Error {
	constructor(
		message: string,
		readonly code: WorktreeIsolationErrorCode,
	) {
		super(message);
		this.name = "WorktreeIsolationError";
	}
}

function sameCanonicalPath(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

/**
 * Lexical containment check for pre-canonicalized paths (deliberately no realpath / disk I/O).
 */
function canonicalPathIsWithin(root: string, candidate: string): boolean {
	return lexicalPathIsWithin(root, candidate);
}

function hasValidShape(isolation: unknown): isolation is WorktreeIsolation {
	if (isolation === null || typeof isolation !== "object") return false;
	const candidate = isolation as Record<string, unknown>;
	return (
		typeof candidate.worktreeRoot === "string" &&
		path.isAbsolute(candidate.worktreeRoot) &&
		typeof candidate.primaryRoot === "string" &&
		path.isAbsolute(candidate.primaryRoot) &&
		typeof candidate.name === "string" &&
		candidate.name.length > 0 &&
		typeof candidate.branch === "string" &&
		candidate.branch.length > 0 &&
		typeof candidate.commonDir === "string" &&
		path.isAbsolute(candidate.commonDir)
	);
}

/**
 * Verify a serialized binding against the linked worktree's live Git metadata.
 * Missing checkouts are reported separately; every malformed or inconsistent
 * binding is treated as tampering.
 */
export async function validateWorktreeIsolation(isolation: unknown): Promise<WorktreeIsolationValidationResult> {
	if (!hasValidShape(isolation)) {
		return { status: "tampered", reason: "Worktree isolation metadata is malformed." };
	}

	try {
		const [worktreeStat, primaryStat] = await Promise.all([
			lstatOptional(isolation.worktreeRoot),
			lstatOptional(isolation.primaryRoot),
		]);
		if (!worktreeStat) {
			return { status: "missing", reason: `Isolated worktree is missing: ${isolation.worktreeRoot}` };
		}
		if (!primaryStat) {
			return { status: "missing", reason: `Primary checkout is missing: ${isolation.primaryRoot}` };
		}
		// lstat does not follow symlinks, so symlinks fail isDirectory()
		if (!worktreeStat.isDirectory()) {
			return { status: "tampered", reason: "Isolated worktree root is not a real directory." };
		}
		if (!primaryStat.isDirectory()) {
			return { status: "tampered", reason: "Primary checkout root is not a real directory." };
		}

		const gitEntryPath = path.join(isolation.worktreeRoot, ".git");
		const [canonicalWorktreeRoot, canonicalPrimaryRoot, canonicalCommonDir, gitEntryStat] = await Promise.all([
			fs.realpath(isolation.worktreeRoot),
			fs.realpath(isolation.primaryRoot),
			fs.realpath(isolation.commonDir).catch(() => null),
			lstatOptional(gitEntryPath),
		]);
		if (!sameCanonicalPath(isolation.worktreeRoot, canonicalWorktreeRoot)) {
			return { status: "tampered", reason: "Isolated worktree root is not canonical." };
		}
		if (!sameCanonicalPath(isolation.primaryRoot, canonicalPrimaryRoot)) {
			return { status: "tampered", reason: "Primary checkout root is not canonical." };
		}
		if (!canonicalCommonDir || !sameCanonicalPath(isolation.commonDir, canonicalCommonDir)) {
			return { status: "tampered", reason: "Recorded Git common directory is missing or not canonical." };
		}
		// lstat does not follow symlinks, so symlinks fail isFile()
		if (!gitEntryStat?.isFile()) {
			return { status: "tampered", reason: "Linked worktree .git metadata is missing or unsafe." };
		}

		const repository = await git.repo.resolve(canonicalWorktreeRoot);
		if (!repository) {
			return { status: "tampered", reason: "Isolated worktree is not a Git repository." };
		}
		const [repositoryRoot, repositoryCommonDir, repositoryGitEntry, repositoryPrimaryRoot] = await Promise.all([
			fs.realpath(repository.repoRoot).catch(() => null),
			fs.realpath(repository.commonDir).catch(() => null),
			fs.realpath(repository.gitEntryPath).catch(() => null),
			git.repo.primaryRoot(canonicalWorktreeRoot),
		]);
		if (
			!repositoryRoot ||
			!repositoryCommonDir ||
			!repositoryGitEntry ||
			!repositoryPrimaryRoot ||
			!samePath(repositoryRoot, canonicalWorktreeRoot) ||
			!samePath(repositoryCommonDir, canonicalCommonDir) ||
			!samePath(repositoryGitEntry, gitEntryPath)
		) {
			return { status: "tampered", reason: "Linked worktree Git metadata does not match the recorded binding." };
		}
		const canonicalRepositoryPrimary = await fs.realpath(repositoryPrimaryRoot).catch(() => null);
		if (!canonicalRepositoryPrimary || !samePath(canonicalRepositoryPrimary, canonicalPrimaryRoot)) {
			return { status: "tampered", reason: "Linked worktree belongs to a different primary checkout." };
		}
		if (!(await git.repo.hasValidLinkedWorktreeBacklink(repository))) {
			return { status: "tampered", reason: "Linked worktree backlink is invalid." };
		}
		if ((await git.branch.current(canonicalWorktreeRoot)) !== isolation.branch) {
			return { status: "tampered", reason: `Linked worktree is not on the recorded branch ${isolation.branch}.` };
		}

		return {
			status: "valid",
			isolation: {
				worktreeRoot: canonicalWorktreeRoot,
				primaryRoot: canonicalPrimaryRoot,
				name: isolation.name,
				branch: isolation.branch,
				commonDir: canonicalCommonDir,
			},
		};
	} catch (error) {
		return {
			status: "tampered",
			reason: error instanceof Error ? error.message : "Worktree isolation verification failed.",
		};
	}
}

/**
 * Canonicalize configured additional roots and remove unsafe aliases, primary
 * checkout roots/subdirectories, and paths already covered by the worktree.
 */
export async function filterWorktreeAdditionalDirectories(
	isolation: WorktreeIsolation,
	directories: readonly string[],
): Promise<string[]> {
	if (!hasValidShape(isolation)) return [];
	const filtered: string[] = [];
	const seen = new Set<string>();
	for (const directory of directories) {
		if (typeof directory !== "string" || directory.length === 0) continue;
		const absoluteDirectory = path.resolve(isolation.worktreeRoot, directory);
		const stat = await lstatOptional(absoluteDirectory).catch(() => null);
		// lstat does not follow symlinks, so symlinks fail isDirectory()
		if (!stat?.isDirectory()) continue;
		const canonicalDirectory = await fs.realpath(absoluteDirectory).catch(() => null);
		// Reject aliases through any symlinked path component instead of silently
		// widening authorization to a different on-disk location.
		if (!canonicalDirectory || !sameCanonicalPath(absoluteDirectory, canonicalDirectory)) continue;
		if (canonicalPathIsWithin(isolation.primaryRoot, canonicalDirectory)) continue;
		if (canonicalPathIsWithin(isolation.worktreeRoot, canonicalDirectory)) continue;
		const comparisonPath = normalizePathForComparison(canonicalDirectory);
		if (seen.has(comparisonPath)) continue;
		seen.add(comparisonPath);
		filtered.push(canonicalDirectory);
	}
	return filtered;
}
