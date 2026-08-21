import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import { applyStartupWorktree, type StartupWorktree } from "@oh-my-pi/pi-coding-agent/cli/startup-worktree";
import { clearWorktrees, listWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import {
	getProjectDir,
	hashPath,
	normalizePathForComparison,
	removeWithRetries,
	setProjectDir,
	setWorktreesDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const tempRoots: string[] = [];
const repos: string[] = [];
const handles: StartupWorktree[] = [];
let savedWorktreeDir: string | undefined;

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`);
	}
	return stdout.trim();
}

interface RepoFixture {
	repo: string;
	root: string;
	worktrees: string;
}

async function createRepo(options: { commit?: boolean } = {}): Promise<RepoFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-startup-worktree-"));
	tempRoots.push(root);
	const repo = path.join(root, "repo");
	const worktrees = path.join(root, "managed-worktrees");
	await fs.mkdir(repo);
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "worktree-test@example.invalid"]);
	await runGit(repo, ["config", "user.name", "Worktree Test"]);
	if (options.commit !== false) {
		await fs.writeFile(path.join(repo, "tracked.txt"), "baseline\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "baseline"]);
	}
	repos.push(repo);
	setWorktreesDir(worktrees);
	setProjectDir(repo);
	return { repo, root, worktrees };
}

function track(worktree: StartupWorktree | null): StartupWorktree {
	if (!worktree) throw new Error("Expected a startup worktree");
	handles.push(worktree);
	return worktree;
}

async function enter(name: string): Promise<StartupWorktree> {
	return track(await applyStartupWorktree(parseArgs(["--worktree", name])));
}

async function cleanupRepoWorktrees(repo: string): Promise<void> {
	let entries: git.GitWorktreeEntry[];
	try {
		entries = await git.worktree.list(repo);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (normalizePathForComparison(entry.path) === normalizePathForComparison(repo)) continue;
		if (entry.locked !== undefined) await git.worktree.tryUnlock(repo, entry.path);
		await git.worktree.tryRemove(repo, entry.path, { force: true });
	}
}

beforeEach(() => {
	savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
	delete process.env.OMP_WORKTREE_DIR;
});

afterEach(async () => {
	vi.restoreAllMocks();
	try {
		for (const handle of handles.splice(0)) await handle.release();
		setProjectDir(originalProjectDir);
		for (const repo of repos.splice(0)) await cleanupRepoWorktrees(repo);
	} finally {
		setProjectDir(originalProjectDir);
		setWorktreesDir(undefined);
		if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
		await Promise.all(tempRoots.splice(0).map(root => removeWithRetries(root)));
	}
});

describe.serial("startup worktrees", () => {
	test("no worktree flag preserves the launch checkout, managed root, and refs", async () => {
		const { repo, worktrees } = await createRepo();
		const parsed = parseArgs(["--print", "continue normally"]);
		const launchProjectDir = getProjectDir();
		const launchProcessCwd = process.cwd();
		const worktreeState = await git.worktree.list(repo);
		const refState = await runGit(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);

		try {
			const worktree = await applyStartupWorktree(parsed);
			if (worktree) handles.push(worktree);

			expect(worktree).toBeNull();
			expect(parsed.cwd).toBeUndefined();
			expect(getProjectDir()).toBe(launchProjectDir);
			expect(process.cwd()).toBe(launchProcessCwd);
			expect(await fs.stat(worktrees).catch(() => null)).toBeNull();
			expect(await git.worktree.list(repo)).toEqual(worktreeState);
			expect(await runGit(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).toBe(refState);
		} finally {
			if (process.cwd() !== launchProcessCwd) process.chdir(launchProcessCwd);
		}
	});

	test("creates a linked checkout on a dedicated branch and enters it", async () => {
		const { repo, worktrees } = await createRepo();

		const worktree = await enter("feature-auth");

		expect(getProjectDir()).toBe(worktree.path);
		expect(normalizePathForComparison(worktree.path).startsWith(normalizePathForComparison(worktrees))).toBe(true);
		expect(await fs.readFile(path.join(worktree.path, "tracked.txt"), "utf8")).toBe("baseline\n");
		expect(await git.branch.current(worktree.path)).toBe("worktree-feature-auth");
		expect(await git.branch.current(repo)).toBe("main");
		const registered = (await git.worktree.list(repo)).find(
			entry => normalizePathForComparison(entry.path) === normalizePathForComparison(worktree.path),
		);
		expect(registered?.locked).toContain(`pid ${process.pid}`);
	});

	test("generates collision-resistant names for bare -w launches", async () => {
		const { repo } = await createRepo();
		const first = track(await applyStartupWorktree(parseArgs(["-w"])));
		await first.release();
		setProjectDir(repo);
		const second = track(await applyStartupWorktree(parseArgs(["--worktree"])));

		expect(second.path).not.toBe(first.path);
	});

	test("applies --cwd before resolving the repository to isolate", async () => {
		const { repo, root } = await createRepo();
		setProjectDir(root);
		const parsed = parseArgs(["--cwd", "repo", "--worktree", "cwd-target"]);

		await applyStartupCwd(parsed);
		const worktree = track(await applyStartupWorktree(parsed));

		expect(normalizePathForComparison((await git.repo.primaryRoot(worktree.path)) ?? "")).toBe(
			normalizePathForComparison(repo),
		);
		expect(parsed.cwd).toBe(worktree.path);
	});

	test("appears as an isolated session in the worktree management command", async () => {
		await createRepo();
		const worktree = await enter("listed-session");
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		});

		await listWorktrees({ json: true });

		const entries = JSON.parse(output.join("\n")) as Array<{
			branch?: string;
			kind: string;
			path: string;
		}>;
		const listed = entries.find(
			entry => normalizePathForComparison(entry.path) === normalizePathForComparison(worktree.path),
		);
		expect(listed).toMatchObject({
			kind: "session",
			branch: "worktree-listed-session",
		});
	});

	test("normal clear preserves a dirty linked worktree with a relative .git pointer", async () => {
		const { repo, worktrees } = await createRepo();
		const worktreePath = path.join(worktrees, "session-relative-pointer");
		const branch = "worktree-relative-pointer";
		await fs.mkdir(worktrees, { recursive: true });
		await runGit(repo, ["worktree", "add", "-q", "-b", branch, worktreePath]);

		const gitEntry = path.join(worktreePath, ".git");
		const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(gitEntry, "utf8"))?.[1];
		if (!pointer) throw new Error("Expected linked worktree metadata");
		const resolvedPointer = path.resolve(path.dirname(gitEntry), pointer);
		const relativePointer = path.relative(path.dirname(gitEntry), resolvedPointer);
		await fs.writeFile(gitEntry, `gitdir: ${relativePointer}\n`);
		await fs.writeFile(path.join(worktreePath, "unfinished.txt"), "dirty work must survive\n");

		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		});
		await listWorktrees({ json: true });
		const entries = JSON.parse(output.join("\n")) as Array<{
			branch?: string;
			kind: string;
			orphanReason?: string;
			parentRepo?: string;
			path: string;
		}>;
		const listed = entries.find(
			entry => normalizePathForComparison(entry.path) === normalizePathForComparison(worktreePath),
		);

		expect(listed).toMatchObject({
			path: worktreePath,
			kind: "session",
			branch,
		});
		expect(listed?.orphanReason).toBeUndefined();
		expect(normalizePathForComparison(listed?.parentRepo ?? "")).toBe(normalizePathForComparison(repo));

		output.length = 0;
		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(JSON.parse(output.join("\n"))).toEqual({ removed: 0, kept: 1 });
		expect(await fs.readFile(path.join(worktreePath, "unfinished.txt"), "utf8")).toBe("dirty work must survive\n");
	});

	test("worktree clear --all unlocks and removes an active managed session", async () => {
		const { repo } = await createRepo();
		const worktree = await enter("clearable-session");
		setProjectDir(repo);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		});

		await clearWorktrees({ all: true, dryRun: false, json: true });

		expect(JSON.parse(output.join("\n"))).toMatchObject({ removed: 1, failed: 0 });
		expect(await fs.stat(worktree.path).catch(() => null)).toBeNull();
		expect(
			(await git.worktree.list(repo)).some(entry => entry.branch === "refs/heads/worktree-clearable-session"),
		).toBe(false);
		expect(await git.ref.exists(repo, "refs/heads/worktree-clearable-session")).toBe(true);
	});

	test("uses the cached remote default branch instead of an unrelated local HEAD", async () => {
		const { repo, root } = await createRepo();
		const remote = path.join(root, "origin.git");
		await runGit(root, ["init", "-q", "--bare", remote]);
		await runGit(repo, ["remote", "add", "origin", remote]);
		await runGit(repo, ["push", "-q", "-u", "origin", "main"]);
		await runGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
		await runGit(repo, ["switch", "-q", "-c", "local-feature"]);
		await fs.writeFile(path.join(repo, "feature-only.txt"), "local feature\n");
		await runGit(repo, ["add", "feature-only.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "local feature"]);

		const worktree = await enter("fresh-base");

		expect(await Bun.file(path.join(worktree.path, "feature-only.txt")).exists()).toBe(false);
	});

	test("preserves upstream identity when an origin branch has the same name", async () => {
		const { repo } = await createRepo();
		const upstreamCommit = await runGit(repo, ["rev-parse", "HEAD"]);
		await runGit(repo, ["update-ref", "refs/remotes/upstream/main", upstreamCommit]);
		await runGit(repo, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"]);
		await runGit(repo, ["switch", "-q", "-c", "origin-version"]);
		await fs.writeFile(path.join(repo, "origin-only.txt"), "wrong remote\n");
		await runGit(repo, ["add", "origin-only.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "origin version"]);
		await runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

		const worktree = await enter("upstream-base");

		expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(upstreamCommit);
		expect(await Bun.file(path.join(worktree.path, "origin-only.txt")).exists()).toBe(false);
	});

	test("reopens the same name and preserves its uncommitted work", async () => {
		const { repo } = await createRepo();
		const first = await enter("persistent");
		await fs.writeFile(path.join(first.path, "unfinished.txt"), "keep me\n");
		await first.release();
		setProjectDir(repo);

		const reopened = await enter("persistent");

		expect(reopened.path).toBe(first.path);
		expect(await fs.readFile(path.join(reopened.path, "unfinished.txt"), "utf8")).toBe("keep me\n");
	});

	test("refuses to let two live sessions share one named worktree", async () => {
		const { repo } = await createRepo();
		const first = await enter("exclusive");
		setProjectDir(repo);

		await expect(enter("exclusive")).rejects.toThrow("already locked");
		expect(await fs.readFile(path.join(first.path, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	test("refuses a named branch already checked out in an unrelated worktree", async () => {
		const { repo, root } = await createRepo();
		const unrelatedPath = path.join(root, "unrelated-checkout");
		await git.branch.create(repo, "worktree-elsewhere");
		await git.worktree.add(repo, unrelatedPath, "worktree-elsewhere");

		await expect(enter("elsewhere")).rejects.toThrow("already checked out");

		const entry = (await git.worktree.list(repo)).find(
			candidate => candidate.branch === "refs/heads/worktree-elsewhere",
		);
		expect(normalizePathForComparison(entry?.path ?? "")).toBe(normalizePathForComparison(unrelatedPath));
		expect(await fs.readFile(path.join(unrelatedPath, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	test("recovers an OMP lock whose owner process has exited", async () => {
		const { repo } = await createRepo();
		const first = await enter("stale-lock");
		await first.release();
		setProjectDir(repo);
		const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		const deadPid = dead.pid;
		await dead.exited;
		await git.worktree.lock(repo, first.path, `omp session stale-lock (pid ${deadPid}; start )`);

		await enter("stale-lock");

		expect(
			(await git.worktree.list(repo)).find(
				entry => normalizePathForComparison(entry.path) === normalizePathForComparison(first.path),
			)?.locked,
		).toContain(`pid ${process.pid}`);
	});

	test("does not recover a stale OMP lock owned by a different logical name", async () => {
		const { repo } = await createRepo();
		const first = await enter("exact-lock");
		await first.release();
		setProjectDir(repo);
		const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		const deadPid = dead.pid;
		await dead.exited;
		const foreignReason = `omp session exact-lock-other (pid ${deadPid}; start )`;
		await git.worktree.lock(repo, first.path, foreignReason);

		await expect(enter("exact-lock")).rejects.toThrow(foreignReason);

		const entry = (await git.worktree.list(repo)).find(
			candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(first.path),
		);
		expect(entry?.locked).toBe(foreignReason);
	});

	test("preserves a manually locked worktree instead of taking it over", async () => {
		const { repo } = await createRepo();
		const first = await enter("manual-lock");
		await first.release();
		setProjectDir(repo);
		await git.worktree.lock(repo, first.path, "maintenance");

		await expect(enter("manual-lock")).rejects.toThrow("maintenance");
		expect(await fs.readFile(path.join(first.path, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	test("release is idempotent and preserves a foreign replacement lock", async () => {
		const { repo } = await createRepo();
		const worktree = await enter("replacement-lock");
		expect(await git.worktree.tryUnlock(repo, worktree.path)).toBe(true);
		await git.worktree.lock(repo, worktree.path, "foreign replacement");

		await worktree.release();
		await worktree.release();

		const entry = (await git.worktree.list(repo)).find(
			candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(worktree.path),
		);
		expect(entry?.locked).toBe("foreign replacement");
	});

	test("reattaches the preserved branch after its checkout directory was removed", async () => {
		const { repo } = await createRepo();
		const first = await enter("reattach");
		await fs.writeFile(path.join(first.path, "committed.txt"), "branch state\n");
		await runGit(first.path, ["add", "committed.txt"]);
		await runGit(first.path, ["commit", "-q", "-m", "branch state"]);
		await first.release();
		setProjectDir(repo);
		await fs.rm(first.path, { recursive: true, force: true });

		const reattached = await enter("reattach");

		expect(await fs.readFile(path.join(reattached.path, "committed.txt"), "utf8")).toBe("branch state\n");
	});

	test("rejects malformed linked metadata without deleting checkout data", async () => {
		const { repo } = await createRepo();
		const worktree = await enter("malformed-metadata");
		await worktree.release();
		await fs.writeFile(path.join(worktree.path, "unrelated.txt"), "preserve me\n");
		await fs.rm(path.join(worktree.path, ".git"));
		setProjectDir(repo);

		await expect(enter("malformed-metadata")).rejects.toThrow("linked git metadata is missing");

		expect(await fs.readFile(path.join(worktree.path, "unrelated.txt"), "utf8")).toBe("preserve me\n");
		expect(await git.ref.exists(repo, "refs/heads/worktree-malformed-metadata")).toBe(true);
	});

	test("rejects a foreign replacement .git pointer without deleting either checkout", async () => {
		const { repo, root } = await createRepo();
		const managed = await enter("pointer-owner");
		await managed.release();
		await fs.writeFile(path.join(managed.path, "unrelated.txt"), "preserve managed data\n");
		const foreignPath = path.join(root, "foreign-checkout");
		await git.branch.create(repo, "foreign-pointer");
		await git.worktree.add(repo, foreignPath, "foreign-pointer");
		await fs.writeFile(path.join(foreignPath, "foreign.txt"), "preserve foreign data\n");
		await fs.writeFile(path.join(managed.path, ".git"), await fs.readFile(path.join(foreignPath, ".git"), "utf8"));
		setProjectDir(repo);

		await expect(enter("pointer-owner")).rejects.toThrow("does not match the source repository registration");

		expect(await fs.readFile(path.join(managed.path, "unrelated.txt"), "utf8")).toBe("preserve managed data\n");
		expect(await fs.readFile(path.join(foreignPath, "foreign.txt"), "utf8")).toBe("preserve foreign data\n");
		expect(await git.ref.exists(repo, "refs/heads/worktree-pointer-owner")).toBe(true);
		expect(await git.ref.exists(repo, "refs/heads/foreign-pointer")).toBe(true);
	});

	test("encodes logical slash names into one managed path segment", async () => {
		await createRepo();

		const worktree = await enter("feature/auth");

		expect(await git.branch.current(worktree.path)).toBe("worktree-feature+auth");
		expect(path.basename(worktree.path)).toContain("feature+auth");
		expect(path.basename(path.dirname(worktree.path))).not.toBe("feature");
	});

	test("keeps identical names from different repositories in distinct directories under one managed root", async () => {
		const firstFixture = await createRepo();
		const sharedWorktrees = firstFixture.worktrees;
		const first = await enter("shared-name");
		await first.release();
		const secondFixture = await createRepo();
		setWorktreesDir(sharedWorktrees);
		const second = await enter("shared-name");

		expect(first.path).not.toBe(second.path);
		expect(normalizePathForComparison((await git.repo.primaryRoot(first.path)) ?? "")).toBe(
			normalizePathForComparison(firstFixture.repo),
		);
		expect(normalizePathForComparison((await git.repo.primaryRoot(second.path)) ?? "")).toBe(
			normalizePathForComparison(secondFixture.repo),
		);
	});

	test("reuses one managed checkout through canonical and symlinked repository paths", async () => {
		const { repo, root } = await createRepo();
		const alias = path.join(root, "repo-alias");
		await fs.symlink(repo, alias, "dir");
		setProjectDir(alias);
		const throughAlias = await enter("canonical-reuse");
		await throughAlias.release();
		setProjectDir(repo);

		const throughCanonicalPath = await enter("canonical-reuse");

		expect(throughCanonicalPath.path).toBe(throughAlias.path);
		expect(throughCanonicalPath.reused).toBe(true);
		expect(
			(await git.worktree.list(repo)).filter(entry => entry.branch === "refs/heads/worktree-canonical-reuse"),
		).toHaveLength(1);
	});

	test("fails closed outside git and in a repository without a commit", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-git-"));
		tempRoots.push(outside);
		setWorktreesDir(path.join(outside, "worktrees"));
		setProjectDir(outside);
		await expect(enter("outside")).rejects.toThrow("inside a git repository");

		await createRepo({ commit: false });
		await expect(enter("unborn")).rejects.toThrow("at least one commit");
	});

	test("rejects unsafe names and names that git cannot represent before creating a checkout", async () => {
		const { worktrees } = await createRepo();
		for (const name of [
			"",
			"../escape",
			"bad name",
			"double//slash",
			"plus+name",
			"x".repeat(121),
			"foo..bar",
			"foo.lock",
		]) {
			const parsed = parseArgs([]);
			parsed.worktree = name;
			await expect(applyStartupWorktree(parsed)).rejects.toThrow();
		}
		expect(await fs.stat(worktrees).catch(() => null)).toBeNull();
	});

	test("does not overwrite an unregistered directory at the managed path", async () => {
		const { repo, worktrees } = await createRepo();
		const primaryRepoRoot = await git.repo.primaryRoot(await fs.realpath(repo));
		if (!primaryRepoRoot) throw new Error("Expected a primary repository root");
		const canonicalPrimaryRepoRoot = await fs.realpath(primaryRepoRoot);
		const occupied = path.join(worktrees, `session-occupied-${hashPath(canonicalPrimaryRepoRoot)}`);
		await fs.mkdir(occupied, { recursive: true });
		await fs.writeFile(path.join(occupied, "sentinel.txt"), "do not delete\n");

		await expect(enter("occupied")).rejects.toThrow("already exists but is not registered");
		expect(await fs.readFile(path.join(occupied, "sentinel.txt"), "utf8")).toBe("do not delete\n");
		expect(await git.ref.exists(repo, "refs/heads/worktree-occupied")).toBe(false);
	});

	test("rolls back a new branch when worktree add loses an occupancy race", async () => {
		const { repo } = await createRepo();
		const originalAdd = git.worktree.add;
		let racedPath = "";
		vi.spyOn(git.worktree, "add").mockImplementation(async (cwd, worktreePath, refName, options) => {
			racedPath = worktreePath;
			await fs.mkdir(worktreePath);
			await fs.writeFile(path.join(worktreePath, "unrelated.txt"), "preserve me\n");
			await originalAdd(cwd, worktreePath, refName, options);
		});

		await expect(enter("add-failure")).rejects.toThrow();

		expect(await fs.readFile(path.join(racedPath, "unrelated.txt"), "utf8")).toBe("preserve me\n");
		expect(await git.ref.exists(repo, "refs/heads/worktree-add-failure")).toBe(false);
		expect(
			(await git.worktree.list(repo)).some(
				entry => normalizePathForComparison(entry.path) === normalizePathForComparison(racedPath),
			),
		).toBe(false);
	});

	test("preserves a concurrently advanced branch when worktree add loses an occupancy race", async () => {
		const { repo } = await createRepo();
		const originalAdd = git.worktree.add;
		const branchRef = "refs/heads/worktree-advanced-add-failure";
		let racedPath = "";
		let createdOid = "";
		let advancedOid = "";
		vi.spyOn(git.worktree, "add").mockImplementation(async (cwd, worktreePath, refName, options) => {
			racedPath = worktreePath;
			await fs.mkdir(worktreePath);
			await fs.writeFile(path.join(worktreePath, "sentinel.txt"), "preserve concurrent state\n");
			createdOid = await runGit(cwd, ["rev-parse", "--verify", branchRef]);
			const treeOid = await runGit(cwd, ["rev-parse", `${createdOid}^{tree}`]);
			advancedOid = await runGit(cwd, ["commit-tree", treeOid, "-p", createdOid, "-m", "concurrent branch advance"]);
			await runGit(cwd, ["update-ref", branchRef, advancedOid, createdOid]);
			await originalAdd(cwd, worktreePath, refName, options);
		});

		await expect(enter("advanced-add-failure")).rejects.toThrow();

		expect(await fs.readFile(path.join(racedPath, "sentinel.txt"), "utf8")).toBe("preserve concurrent state\n");
		expect(await runGit(repo, ["rev-parse", "--verify", branchRef])).toBe(advancedOid);
		expect(await runGit(repo, ["rev-parse", `${advancedOid}^`])).toBe(createdOid);
		expect(await runGit(repo, ["cat-file", "-t", advancedOid])).toBe("commit");
		expect((await git.worktree.list(repo)).some(entry => entry.branch === branchRef)).toBe(false);
	});

	test("preserves an externally registered checkout when worktree add loses the registration race", async () => {
		const { repo } = await createRepo();
		await git.branch.create(repo, "external-race-owner");
		const originalAdd = git.worktree.add;
		let racedPath = "";
		vi.spyOn(git.worktree, "add").mockImplementation(async (cwd, worktreePath) => {
			racedPath = worktreePath;
			await originalAdd(cwd, worktreePath, "external-race-owner", { lockReason: "external owner" });
			await fs.writeFile(path.join(worktreePath, "external.txt"), "preserve external checkout\n");
			throw new Error("external registration won");
		});

		await expect(enter("external-add-race")).rejects.toThrow("external registration won");

		const entry = (await git.worktree.list(repo)).find(
			candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(racedPath),
		);
		expect(entry).toMatchObject({
			branch: "refs/heads/external-race-owner",
			locked: "external owner",
		});
		expect(await fs.readFile(path.join(racedPath, "external.txt"), "utf8")).toBe("preserve external checkout\n");
		expect(await git.ref.exists(repo, "refs/heads/external-race-owner")).toBe(true);
		expect(await git.ref.exists(repo, "refs/heads/worktree-external-add-race")).toBe(false);
	});

	test("rejects every launch mode that would leave the new checkout", async () => {
		const { worktrees } = await createRepo();
		const conflicts = [
			["--continue", ["--continue"]],
			["--resume", ["--resume", "old-session"]],
			["--fork", ["--fork", "old-session"]],
			["--from-claude", ["--from-claude"]],
			["--from-codex", ["--from-codex"]],
		] as const;

		for (const [flag, args] of conflicts) {
			const parsed = parseArgs(["--worktree", "new-session", ...args]);
			await expect(applyStartupWorktree(parsed)).rejects.toThrow(`cannot be combined with ${flag}`);
		}
		expect(await fs.stat(worktrees).catch(() => null)).toBeNull();
	});

	test("serializes concurrent creation so exactly one process owner wins", async () => {
		await createRepo();
		const first = applyStartupWorktree(parseArgs(["--worktree", "race"]));
		const second = applyStartupWorktree(parseArgs(["--worktree", "race"]));

		const settled = await Promise.allSettled([first, second]);
		const fulfilled = settled.filter(result => result.status === "fulfilled" && result.value !== null);
		const rejected = settled.filter(result => result.status === "rejected");
		for (const result of fulfilled) {
			if (result.status === "fulfilled" && result.value) handles.push(result.value);
		}
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining("locked") }),
		});
	});
});
