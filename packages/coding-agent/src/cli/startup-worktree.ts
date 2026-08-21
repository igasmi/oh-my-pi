import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getProjectDir,
	getWorktreesDir,
	hashPath,
	isEnoent,
	logger,
	normalizePathForComparison,
	postmortem,
	Snowflake,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { currentProcessOwner, isProcessOwnerLive, type ProcessOwner } from "../task/isolation-ownership";
import * as git from "../utils/git";
import type { Args } from "./args";

const MAX_WORKTREE_NAME_LENGTH = 120;
const WORKTREE_NAME_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const OMP_LOCK_REASON_RE = /^omp session ([A-Za-z0-9._/-]+) \(pid (\d+); start ([^)]*)\)$/;

export class StartupWorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StartupWorktreeError";
	}
}

export interface StartupWorktree {
	/** User-facing name supplied to `--worktree`, or generated for a bare flag. */
	name: string;
	/** Local branch checked out in the worktree. */
	branch: string;
	/** Absolute normalized path to the linked worktree. */
	path: string;
	/** True when an existing managed worktree was reopened. */
	reused: boolean;
	/** Release this process's worktree lock without removing the checkout. */
	release(): Promise<void>;
}

/** Validate the logical name before it becomes either a ref or a filesystem segment. */
export function validateWorktreeName(name: string): void {
	if (name.length === 0) {
		throw new StartupWorktreeError("Worktree name must not be empty.");
	}
	if (name.length > MAX_WORKTREE_NAME_LENGTH) {
		throw new StartupWorktreeError(
			`Worktree name is too long (${name.length} characters; maximum ${MAX_WORKTREE_NAME_LENGTH}).`,
		);
	}
	const segments = name.split("/");
	if (segments.some(segment => segment === "." || segment === "..")) {
		throw new StartupWorktreeError(`Invalid worktree name ${JSON.stringify(name)}: "." and ".." are not allowed.`);
	}
	if (segments.some(segment => segment.length === 0 || !WORKTREE_NAME_SEGMENT_RE.test(segment))) {
		throw new StartupWorktreeError(
			`Invalid worktree name ${JSON.stringify(name)}: each "/"-separated segment must contain only letters, digits, dots, underscores, and dashes.`,
		);
	}
}

interface FileStat {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

function samePath(left: string, right: string): boolean {
	return normalizePathForComparison(path.resolve(left)) === normalizePathForComparison(path.resolve(right));
}

async function lstatOptional(filePath: string): Promise<FileStat | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function hasExpectedWorktreeMetadata(
	worktreePath: string,
	branch: string,
	sourceCommonDir: string,
): Promise<boolean> {
	const repository = await git.repo.resolve(worktreePath);
	if (!repository) return false;
	const [candidateRoot, candidateCommonDir, candidateGitEntry, expectedRoot, expectedGitEntry] = await Promise.all([
		fs.realpath(repository.repoRoot).catch(() => null),
		fs.realpath(repository.commonDir).catch(() => null),
		fs.realpath(repository.gitEntryPath).catch(() => null),
		fs.realpath(worktreePath).catch(() => null),
		fs.realpath(path.join(worktreePath, ".git")).catch(() => null),
	]);
	if (
		candidateRoot === null ||
		candidateCommonDir === null ||
		candidateGitEntry === null ||
		expectedRoot === null ||
		expectedGitEntry === null ||
		!samePath(candidateRoot, expectedRoot) ||
		!samePath(candidateCommonDir, sourceCommonDir) ||
		!samePath(candidateGitEntry, expectedGitEntry)
	) {
		return false;
	}
	if (!(await git.repo.hasValidLinkedWorktreeBacklink(repository))) return false;
	return (await git.branch.current(worktreePath)) === branch;
}

async function clearStaleOmpLock(repoRoot: string, entry: git.GitWorktreeEntry, expectedName: string): Promise<void> {
	if (entry.locked === undefined) return;
	const match = OMP_LOCK_REASON_RE.exec(entry.locked);
	const pid = match?.[1] === expectedName ? Number(match[2]) : null;
	let owner: ProcessOwner | null = null;
	if (pid !== null && Number.isSafeInteger(pid) && pid > 0) {
		try {
			const startToken = match?.[3] ? decodeURIComponent(match[3]) : undefined;
			owner = { pid, ...(startToken ? { startToken } : {}) };
		} catch {
			// A malformed token is not verifiably ours; preserve the lock.
		}
	}
	if (!owner || (await isProcessOwnerLive(owner))) {
		const reason = entry.locked ? ` (${entry.locked})` : "";
		throw new StartupWorktreeError(`Worktree ${entry.path} is already locked${reason}.`);
	}
	if (!(await git.worktree.tryUnlock(repoRoot, entry.path))) {
		throw new StartupWorktreeError(`Could not release stale worktree lock at ${entry.path}.`);
	}
}

/** Choose the exact cached remote default ref, falling back to the launch checkout's HEAD. */
export async function resolveWorktreeBaseRef(repoRoot: string): Promise<string> {
	const head = await git.head.sha(repoRoot);
	if (!head) {
		throw new StartupWorktreeError("Worktrees require a git repository with at least one commit.");
	}
	return (await git.branch.defaultRef(repoRoot)) ?? "HEAD";
}

function assertCompatibleArgs(parsed: Args): void {
	const conflicts: string[] = [];
	if (parsed.continue) conflicts.push("--continue");
	if (parsed.resume) conflicts.push("--resume");
	if (parsed.fork) conflicts.push("--fork");
	if (parsed.fromClaude) conflicts.push("--from-claude");
	if (parsed.fromCodex) conflicts.push("--from-codex");
	if (conflicts.length > 0) {
		throw new StartupWorktreeError(`--worktree cannot be combined with ${conflicts.join(", ")}.`);
	}
}

interface PreparedWorktree {
	branch: string;
	name: string;
	path: string;
	repoRoot: string;
	reused: boolean;
	lockReason: string;
}

async function prepareWorktree(cwd: string, requestedName: string | true): Promise<PreparedWorktree> {
	const sourceRepository = await git.repo.resolve(cwd);
	if (!sourceRepository) {
		throw new StartupWorktreeError("--worktree must be run inside a git repository.");
	}
	const repoRoot = await fs.realpath(sourceRepository.repoRoot);
	const primaryRepoRoot = await git.repo.primaryRoot(repoRoot);
	if (!primaryRepoRoot) {
		throw new StartupWorktreeError("--worktree must be run inside a git repository.");
	}
	const [canonicalPrimaryRepoRoot, sourceCommonDir] = await Promise.all([
		fs.realpath(primaryRepoRoot),
		fs.realpath(sourceRepository.commonDir),
	]);

	const name = requestedName === true ? `wt-${Snowflake.next()}` : requestedName;
	validateWorktreeName(name);
	// `+` is excluded by validation, so replacing logical slashes is reversible
	// and cannot create nested directories under the managed worktree root.
	const encodedName = name.replaceAll("/", "+");
	const branch = `worktree-${encodedName}`;
	if (!(await git.branch.isValidName(repoRoot, branch))) {
		throw new StartupWorktreeError(`Worktree name ${JSON.stringify(name)} does not form a valid git branch name.`);
	}

	const worktreesRoot = getWorktreesDir();
	await fs.mkdir(worktreesRoot, { recursive: true });
	const canonicalWorktreesRoot = await fs.realpath(worktreesRoot);
	const worktreePath = path.join(
		canonicalWorktreesRoot,
		`session-${encodedName}-${hashPath(canonicalPrimaryRepoRoot)}`,
	);
	const repoLockTarget = path.join(canonicalWorktreesRoot, `.session-${hashPath(canonicalPrimaryRepoRoot)}`);
	const branchRef = `refs/heads/${branch}`;
	const owner = await currentProcessOwner();
	const lockReason = `omp session ${name} (pid ${owner.pid}; start ${encodeURIComponent(owner.startToken ?? "")})`;

	return withFileLock(
		repoLockTarget,
		() =>
			git.withRepoLock(repoRoot, async () => {
				let entries = await git.worktree.list(repoRoot);
				let branchEntry = entries.find(entry => entry.branch === branchRef);
				let pathEntry = entries.find(entry => samePath(entry.path, worktreePath));

				if (branchEntry && !samePath(branchEntry.path, worktreePath)) {
					throw new StartupWorktreeError(
						`Branch ${branch} is already checked out at ${branchEntry.path}; choose another worktree name.`,
					);
				}
				if (pathEntry && pathEntry.branch !== branchRef) {
					throw new StartupWorktreeError(
						`Managed worktree path ${worktreePath} is registered to ${pathEntry.branch ?? "a detached checkout"}.`,
					);
				}

				if (branchEntry && samePath(branchEntry.path, worktreePath)) {
					const existingStat = await lstatOptional(worktreePath);
					if (!existingStat) {
						await clearStaleOmpLock(repoRoot, branchEntry, name);
						await git.worktree.prune(repoRoot);
						entries = await git.worktree.list(repoRoot);
						branchEntry = entries.find(entry => entry.branch === branchRef);
						pathEntry = entries.find(entry => samePath(entry.path, worktreePath));
					} else {
						if (!existingStat.isDirectory() || existingStat.isSymbolicLink()) {
							throw new StartupWorktreeError(`Refusing to use non-directory worktree path ${worktreePath}.`);
						}
						const gitEntry = await lstatOptional(path.join(worktreePath, ".git"));
						if (!gitEntry?.isFile() || gitEntry.isSymbolicLink()) {
							throw new StartupWorktreeError(`Refusing to use ${worktreePath}: linked git metadata is missing.`);
						}
						if (!(await hasExpectedWorktreeMetadata(worktreePath, branch, sourceCommonDir))) {
							throw new StartupWorktreeError(
								`Refusing to use ${worktreePath}: linked git metadata does not match the source repository registration.`,
							);
						}
						await clearStaleOmpLock(repoRoot, branchEntry, name);
						await git.worktree.lock(repoRoot, worktreePath, lockReason);
						return {
							branch,
							name,
							path: worktreePath,
							repoRoot,
							reused: true,
							lockReason,
						};
					}
				}

				if (branchEntry || pathEntry) {
					throw new StartupWorktreeError(`Could not recover stale worktree metadata for ${worktreePath}.`);
				}
				const occupied = await lstatOptional(worktreePath);
				if (occupied) {
					throw new StartupWorktreeError(
						`Worktree path ${worktreePath} already exists but is not registered with git; move or remove it first.`,
					);
				}

				const branchExisted = await git.ref.exists(repoRoot, branchRef);
				let createdBranchOid: string | null = null;
				if (!branchExisted) {
					const branchStart = await resolveWorktreeBaseRef(repoRoot);
					createdBranchOid = await git.ref.resolve(repoRoot, branchStart);
					if (!createdBranchOid) {
						throw new StartupWorktreeError(`Could not resolve worktree branch start point ${branchStart}.`);
					}
					await git.branch.create(repoRoot, branch, createdBranchOid);
				}
				try {
					await fs.mkdir(path.dirname(worktreePath), { recursive: true });
					await git.worktree.add(repoRoot, worktreePath, branch, { lockReason });
				} catch (error) {
					const currentEntries = await git.worktree.list(repoRoot).catch(() => null);
					const branchIsRegistered = currentEntries?.some(entry => entry.branch === branchRef) ?? true;
					if (createdBranchOid && !branchIsRegistered) {
						await git.ref.tryDelete(repoRoot, branchRef, createdBranchOid).catch(() => false);
					}
					throw error;
				}
				return {
					branch,
					name,
					path: worktreePath,
					repoRoot,
					reused: branchExisted,
					lockReason,
				};
			}),
		{ retries: 200, retryDelayMs: 50 },
	);
}

function withRelease(prepared: PreparedWorktree): StartupWorktree {
	let released = false;
	let unregister = () => {};
	const unlock = async (): Promise<void> => {
		if (released) return;
		released = true;
		try {
			const entries = await git.worktree.list(prepared.repoRoot);
			const entry = entries.find(candidate => samePath(candidate.path, prepared.path));
			if (entry?.locked === prepared.lockReason) {
				await git.worktree.tryUnlock(prepared.repoRoot, prepared.path);
			}
		} catch (error) {
			logger.debug("Failed to release startup worktree lock", {
				error: error instanceof Error ? error.message : String(error),
				path: prepared.path,
			});
		}
	};
	unregister = postmortem.register(`startup-worktree:${prepared.path}`, unlock);
	return {
		name: prepared.name,
		branch: prepared.branch,
		path: prepared.path,
		reused: prepared.reused,
		async release() {
			unregister();
			await unlock();
		},
	};
}

/** Create/reuse the requested worktree, lock it for this process, and enter it. */
export async function applyStartupWorktree(parsed: Args): Promise<StartupWorktree | null> {
	if (parsed.worktree === undefined) return null;
	assertCompatibleArgs(parsed);
	const prepared = await prepareWorktree(getProjectDir(), parsed.worktree);
	const worktree = withRelease(prepared);
	try {
		setProjectDir(worktree.path);
		worktree.path = getProjectDir();
		parsed.cwd = worktree.path;
		return worktree;
	} catch (error) {
		await worktree.release();
		throw error;
	}
}
