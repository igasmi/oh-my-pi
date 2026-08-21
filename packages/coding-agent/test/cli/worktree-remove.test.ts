import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RemoveWorktreeOptions, removeWorktree } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import Worktree from "@oh-my-pi/pi-coding-agent/commands/worktree";
import { currentProcessOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { hashPath, normalizePathForComparison, setWorktreesDir } from "@oh-my-pi/pi-utils";

interface SessionFixture {
	branch: string;
	dir: string;
	name: string;
	repo: string;
}

describe("worktree remove", () => {
	let base: string;
	let cwd: string;
	let output: string[];
	let savedExitCode: typeof process.exitCode;
	const tempRoots: string[] = [];

	beforeEach(async () => {
		savedExitCode = process.exitCode;
		process.exitCode = 0;
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-remove-base-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-remove-cwd-"));
		tempRoots.push(base, cwd);
		setWorktreesDir(base);
		output = [];
		vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		});
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		process.exitCode = savedExitCode !== undefined ? savedExitCode : 0;
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	async function runGit(dir: string, args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", windowsHide: true });
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

	async function makeSession(name: string, repoLabel: string): Promise<SessionFixture> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-wt-remove-${repoLabel}-`));
		tempRoots.push(root);
		const repo = path.join(root, "repo");
		await fs.mkdir(repo);
		await runGit(repo, ["init", "-q", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "worktree-remove@example.invalid"]);
		await runGit(repo, ["config", "user.name", "Worktree Remove Test"]);
		await Bun.write(path.join(repo, "tracked.txt"), `${repoLabel}\n`);
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "baseline"]);

		const canonicalRepo = await fs.realpath(repo);
		const encodedName = name.replaceAll("/", "+");
		const branch = `worktree-${encodedName}`;
		const dir = path.join(await fs.realpath(base), `session-${encodedName}-${hashPath(canonicalRepo)}`);
		await runGit(repo, ["worktree", "add", "-q", "-b", branch, dir]);
		return { branch, dir, name, repo: canonicalRepo };
	}

	function options(target: string, overrides: Partial<RemoveWorktreeOptions> = {}): RemoveWorktreeOptions {
		return { cwd, dryRun: false, force: false, json: true, target, ...overrides };
	}

	async function exactOmpLock(session: SessionFixture, pid: number, startToken = ""): Promise<void> {
		const reason = `omp session ${session.name} (pid ${pid}; start ${encodeURIComponent(startToken)})`;
		await runGit(session.repo, ["worktree", "lock", "--reason", reason, session.dir]);
	}

	async function deadPid(): Promise<number> {
		const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	it("previews one exact path with stable JSON without affecting a sibling", async () => {
		const target = await makeSession("feature/auth", "preview-target");
		const sibling = await makeSession("feature/auth", "preview-sibling");

		const result = await removeWorktree(options(target.dir, { dryRun: true }));

		expect(result.branch).toBe(target.branch);
		expect(result.branchAction).toBe("would-delete");
		expect(result.candidates).toEqual([]);
		expect(result.name).toBe(target.name);
		expect(normalizePathForComparison(result.path!)).toBe(normalizePathForComparison(target.dir));
		expect(result.reason).toBeNull();
		expect(result.status).toBe("would-remove");
		expect(result.target).toBe(target.dir);
		expect(JSON.parse(output.join("\n"))).toEqual(result);
		expect(await fs.stat(target.dir)).toBeDefined();
		expect(await fs.stat(sibling.dir)).toBeDefined();
		expect(await git.ref.exists(target.repo, `refs/heads/${target.branch}`)).toBe(true);
		expect(await git.ref.exists(sibling.repo, `refs/heads/${sibling.branch}`)).toBe(true);
	});

	it("resolves slash names within the current repo and CAS-deletes only its proven OMP branch", async () => {
		const target = await makeSession("feature/scoped", "scoped-target");
		const sibling = await makeSession("feature/scoped", "scoped-sibling");

		const result = await removeWorktree(options("feature/scoped", { cwd: target.repo }));

		expect(result.status).toBe("removed");
		expect(path.basename(result.path!)).toBe(path.basename(target.dir));
		expect(normalizePathForComparison(path.dirname(result.path!))).toBe(
			normalizePathForComparison(path.dirname(target.dir)),
		);
		expect(result.branchAction).toBe("deleted");
		expect(await fs.stat(target.dir).catch(() => null)).toBeNull();
		expect(await git.ref.exists(target.repo, `refs/heads/${target.branch}`)).toBe(false);
		expect(await fs.stat(sibling.dir)).toBeDefined();
		expect(await git.ref.exists(sibling.repo, `refs/heads/${sibling.branch}`)).toBe(true);
	});

	it("rejects a globally ambiguous name and reports every candidate without mutation", async () => {
		const first = await makeSession("ambiguous", "ambiguous-first");
		const second = await makeSession("ambiguous", "ambiguous-second");

		const result = await removeWorktree(options("ambiguous"));

		expect(result.status).toBe("refused");
		expect(result.reason).toContain("ambiguous");
		expect(result.candidates.map(normalizePathForComparison).sort()).toEqual(
			[first.dir, second.dir].map(normalizePathForComparison).sort(),
		);
		expect(JSON.parse(output.join("\n"))).toEqual(result);
		expect(await fs.stat(first.dir)).toBeDefined();
		expect(await fs.stat(second.dir)).toBeDefined();
	});

	it("refuses untracked state and unique commits independently", async () => {
		const dirty = await makeSession("dirty", "dirty");
		await Bun.write(path.join(dirty.dir, "untracked.txt"), "unfinished\n");
		const dirtyResult = await removeWorktree(options("dirty", { cwd: dirty.repo }));
		expect(dirtyResult.status).toBe("refused");
		expect(dirtyResult.reason).toContain("untracked");
		expect(await fs.stat(dirty.dir)).toBeDefined();

		const unique = await makeSession("unique", "unique");
		await Bun.write(path.join(unique.dir, "tracked.txt"), "unique commit\n");
		await runGit(unique.dir, ["add", "tracked.txt"]);
		await runGit(unique.dir, ["commit", "-q", "-m", "unique"]);
		const uniqueResult = await removeWorktree(options("unique", { cwd: unique.repo }));
		expect(uniqueResult.status).toBe("refused");
		expect(uniqueResult.reason).toContain("unique or unpublished commits");
		expect(await fs.stat(unique.dir)).toBeDefined();
	});

	it("preserves unique commits, branch, and worktree when colliding branch and tag short names exist", async () => {
		const session = await makeSession("collision", "collision");
		await runGit(session.repo, ["tag", session.branch, "main"]);

		await Bun.write(path.join(session.dir, "tracked.txt"), "unique commit on colliding branch\n");
		await runGit(session.dir, ["add", "tracked.txt"]);
		await runGit(session.dir, ["commit", "-q", "-m", "unique colliding commit"]);

		const result = await removeWorktree(options(session.name, { cwd: session.repo }));

		expect(result.status).toBe("refused");
		expect(result.reason).toContain("unique or unpublished commits");
		expect(await fs.stat(session.dir)).toBeDefined();
		expect(await git.ref.exists(session.repo, `refs/heads/${session.branch}`)).toBe(true);
		expect(await git.ref.exists(session.repo, `refs/tags/${session.branch}`)).toBe(true);
	});

	it("refuses live exact OMP locks and all foreign locks by default", async () => {
		const live = await makeSession("live", "live");
		const owner = await currentProcessOwner();
		await exactOmpLock(live, owner.pid, owner.startToken);
		const liveResult = await removeWorktree(options("live", { cwd: live.repo }));
		expect(liveResult.status).toBe("refused");
		expect(liveResult.reason).toContain("live OMP session");

		const foreign = await makeSession("foreign", "foreign");
		await runGit(foreign.repo, ["worktree", "lock", "--reason", "another tool owns this", foreign.dir]);
		const foreignResult = await removeWorktree(options("foreign", { cwd: foreign.repo }));
		expect(foreignResult.status).toBe("refused");
		expect(foreignResult.reason).toContain("foreign lock");
		expect(await fs.stat(live.dir)).toBeDefined();
		expect(await fs.stat(foreign.dir)).toBeDefined();
	});

	it("reclaims a stale exact OMP lock and removes its proven branch", async () => {
		const stale = await makeSession("stale", "stale");
		await exactOmpLock(stale, await deadPid());

		const result = await removeWorktree(options("stale", { cwd: stale.repo }));

		expect(result.status).toBe("removed");
		expect(result.branchAction).toBe("deleted");
		expect(await fs.stat(stale.dir).catch(() => null)).toBeNull();
		expect(await git.ref.exists(stale.repo, `refs/heads/${stale.branch}`)).toBe(false);
	});

	it("keeps an unlocked branch when the managed path does not prove OMP branch ownership", async () => {
		const target = await makeSession("unproven", "unproven");
		const userBranch = "user-owned-branch";
		await runGit(target.dir, ["branch", "-m", userBranch]);

		const result = await removeWorktree(options(target.dir));

		expect(result.status).toBe("removed");
		expect(result.branch).toBe(userBranch);
		expect(result.branchAction).toBe("kept");
		expect(await fs.stat(target.dir).catch(() => null)).toBeNull();
		expect(await git.ref.exists(target.repo, `refs/heads/${userBranch}`)).toBe(true);
	});

	it("force overrides target-local safety checks but preserves a foreign-owned branch and siblings", async () => {
		const target = await makeSession("forced", "forced-target");
		const sibling = await makeSession("sibling", "forced-sibling");
		await Bun.write(path.join(target.dir, "tracked.txt"), "forced commit\n");
		await runGit(target.dir, ["add", "tracked.txt"]);
		await runGit(target.dir, ["commit", "-q", "-m", "forced unique"]);
		await Bun.write(path.join(target.dir, "untracked.txt"), "discard me\n");
		await runGit(target.repo, ["worktree", "lock", "--reason", "foreign owner", target.dir]);

		const result = await removeWorktree(options(target.dir, { force: true }));

		expect(result.status).toBe("removed");
		expect(result.branchAction).toBe("kept");
		expect(await fs.stat(target.dir).catch(() => null)).toBeNull();
		expect(await git.ref.exists(target.repo, `refs/heads/${target.branch}`)).toBe(true);
		expect(await fs.stat(sibling.dir)).toBeDefined();
		expect(await git.ref.exists(sibling.repo, `refs/heads/${sibling.branch}`)).toBe(true);
	});

	it("does not resolve a symlink to an exact registered path", async () => {
		const target = await makeSession("symlink", "symlink");
		const alias = path.join(cwd, "worktree-link");
		await fs.symlink(target.dir, alias, "dir");

		const result = await removeWorktree(options(alias, { force: true }));

		expect(result.status).toBe("not-found");
		expect(await fs.stat(target.dir)).toBeDefined();
		expect(await git.ref.exists(target.repo, `refs/heads/${target.branch}`)).toBe(true);
	});

	it("sets process.exitCode to 1 at the command boundary on refused or missing targets", async () => {
		const cmd = new Worktree(["remove", "missing-target"], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map(),
		});
		await cmd.run();
		expect(process.exitCode).toBe(1);
	});
});
