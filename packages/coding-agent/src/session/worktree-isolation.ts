import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, normalizePathForComparison } from "@oh-my-pi/pi-utils";
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
	/** Whether OMP owns the worktree's storage lifecycle. */
	managed?: boolean;
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

export type WorktreePathKind = "worktree" | "primary" | "additional" | "outside" | "unverifiable";

export interface WorktreePathClassification {
	kind: WorktreePathKind;
	canonicalPath?: string;
}

export interface WorktreePathClassificationOptions {
	/** Base for a relative target. Defaults to the isolated worktree root. */
	baseDir?: string;
	/** Follow the final path component when it is a symlink. Defaults to true. */
	followFinal?: boolean;
	/** Already-authorized workspace roots. Primary-checkout paths still take precedence. */
	additionalDirectories?: readonly string[];
}

function samePath(left: string, right: string): boolean {
	return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function sameCanonicalPath(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

function canonicalPathIsWithin(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	const comparisonRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
	const comparisonCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
	const relative = path.relative(comparisonRoot, comparisonCandidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasValidShape(isolation: WorktreeIsolation): boolean {
	return (
		isolation !== null &&
		typeof isolation === "object" &&
		typeof isolation.worktreeRoot === "string" &&
		path.isAbsolute(isolation.worktreeRoot) &&
		typeof isolation.primaryRoot === "string" &&
		path.isAbsolute(isolation.primaryRoot) &&
		typeof isolation.name === "string" &&
		isolation.name.length > 0 &&
		typeof isolation.branch === "string" &&
		isolation.branch.length > 0 &&
		typeof isolation.commonDir === "string" &&
		path.isAbsolute(isolation.commonDir) &&
		(isolation.managed === undefined || typeof isolation.managed === "boolean")
	);
}

async function lstatOptional(filePath: string): Promise<fsTypes.Stats | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/**
 * Verify a serialized binding against the linked worktree's live Git metadata.
 * Missing checkouts are reported separately; every malformed or inconsistent
 * binding is treated as tampering.
 */
export async function validateWorktreeIsolation(
	isolation: WorktreeIsolation,
): Promise<WorktreeIsolationValidationResult> {
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
		if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
			return { status: "tampered", reason: "Isolated worktree root is not a real directory." };
		}
		if (!primaryStat.isDirectory() || primaryStat.isSymbolicLink()) {
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
		if (!gitEntryStat?.isFile() || gitEntryStat.isSymbolicLink()) {
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
				...(isolation.managed === undefined ? {} : { managed: isolation.managed }),
			},
		};
	} catch (error) {
		return {
			status: "tampered",
			reason: error instanceof Error ? error.message : "Worktree isolation verification failed.",
		};
	}
}

async function canonicalizePath(targetPath: string, baseDir: string, followFinal: boolean): Promise<string | null> {
	const absolutePath = path.resolve(baseDir, targetPath);
	const pathToResolve = followFinal ? absolutePath : path.dirname(absolutePath);
	const unresolved: string[] = followFinal ? [] : [path.basename(absolutePath)];
	let cursor = pathToResolve;

	while (true) {
		try {
			const canonicalAncestor = await fs.realpath(cursor);
			return path.resolve(canonicalAncestor, ...unresolved.reverse());
		} catch (error) {
			if (!isEnoent(error)) return null;
			const parent = path.dirname(cursor);
			if (parent === cursor) return null;
			unresolved.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

/** Classify a mutation path after resolving symlinked ancestors and existing targets. */
export async function classifyWorktreePath(
	isolation: WorktreeIsolation,
	targetPath: string,
	options: WorktreePathClassificationOptions = {},
): Promise<WorktreePathClassification> {
	if (!hasValidShape(isolation) || typeof targetPath !== "string" || targetPath.length === 0) {
		return { kind: "unverifiable" };
	}
	const canonicalPath = await canonicalizePath(
		targetPath,
		options.baseDir ?? isolation.worktreeRoot,
		options.followFinal ?? true,
	);
	if (!canonicalPath) return { kind: "unverifiable" };

	if (canonicalPathIsWithin(isolation.worktreeRoot, canonicalPath)) return { kind: "worktree", canonicalPath };
	// The protected primary checkout always wins over additional-directory authorization.
	if (canonicalPathIsWithin(isolation.primaryRoot, canonicalPath)) return { kind: "primary", canonicalPath };

	for (const directory of options.additionalDirectories ?? []) {
		const canonicalDirectory = await canonicalizePath(directory, options.baseDir ?? isolation.worktreeRoot, true);
		if (canonicalDirectory && canonicalPathIsWithin(canonicalDirectory, canonicalPath)) {
			return { kind: "additional", canonicalPath };
		}
	}
	return { kind: "outside", canonicalPath };
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
		if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
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

/** Resolve and authorize a mutation target, returning its canonical syscall path. */
export async function assertWorktreeMutationAllowed(
	isolation: WorktreeIsolation,
	targetPath: string,
	options: WorktreePathClassificationOptions = {},
): Promise<string> {
	const classification = await classifyWorktreePath(isolation, targetPath, options);
	if (classification.kind === "primary") {
		throw new WorktreeIsolationError(
			`Worktree isolation blocks mutations in the primary checkout: ${classification.canonicalPath}`,
			"primary",
		);
	}
	if (classification.kind === "unverifiable" || !classification.canonicalPath) {
		throw new WorktreeIsolationError(`Cannot safely resolve mutation path: ${targetPath}`, "unverifiable");
	}
	return classification.canonicalPath;
}
