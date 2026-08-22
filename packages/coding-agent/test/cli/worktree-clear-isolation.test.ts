import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeSessionWorktreeOwner } from "@oh-my-pi/pi-coding-agent/cli/session-worktree-owner";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import {
	currentProcessOwner,
	ISOLATION_OWNER_FILE,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { hashPath, setWorktreesDir } from "@oh-my-pi/pi-utils";
import * as fileLockModule from "@oh-my-pi/pi-utils/file-lock";

/**
 * Regression for #6761: `omp worktree clear` (no `--all`) must delete only
 * task-isolation sandboxes whose owner process is gone. A sandbox owned by a
 * live omp process holds a running subagent's uncaptured work and must survive.
 */
describe("worktree clear isolation", () => {
	let base: string;
	let savedEnv: string | undefined;
	let savedExitCode: typeof process.exitCode;
	let output: string[];
	const tempRoots: string[] = [];

	beforeEach(async () => {
		savedEnv = process.env.OMP_WORKTREE_DIR;
		savedExitCode = process.exitCode;
		output = [];
		delete process.env.OMP_WORKTREE_DIR;
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		setWorktreesDir(base);
		vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		});
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		process.exitCode = savedExitCode;
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
		await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	async function makeSandbox(name: string): Promise<string> {
		const dir = path.join(base, name);
		await fs.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");
		return dir;
	}

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	async function runGit(cwd: string, args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
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

	async function makeSessionWorktree(
		name: string,
		options: { locked: boolean },
	): Promise<{ branch: string; dir: string; repo: string }> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-session-clear-"));
		tempRoots.push(root);
		const repo = path.join(root, "repo");
		const dir = path.join(base, `session-${name}`);
		const branch = `worktree-${name}`;
		await fs.mkdir(repo);
		await runGit(repo, ["init", "-q", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "worktree-test@example.invalid"]);
		await runGit(repo, ["config", "user.name", "Worktree Test"]);
		await Bun.write(path.join(repo, "tracked.txt"), "baseline\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "baseline"]);
		await runGit(repo, ["worktree", "add", "-q", "-b", branch, dir]);
		await Bun.write(path.join(dir, "unfinished.txt"), `${name} work\n`);
		if (options.locked) {
			const owner = await currentProcessOwner();
			const start = encodeURIComponent(owner.startToken ?? "");
			await runGit(repo, [
				"worktree",
				"lock",
				"--reason",
				`omp session ${name} (pid ${owner.pid}; start ${start})`,
				dir,
			]);
		}
		return { branch, dir, repo };
	}

	it("keeps live-owned sandboxes and reclaims dead/markerless/corrupt ones", async () => {
		const live = await makeSandbox("tlive0001");
		await writeIsolationOwner(live, "live0001"); // marker names this test process

		const dead = await makeSandbox("tdead0002");
		await Bun.write(path.join(dead, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dead0002" }));

		const orphan = await makeSandbox("tnone0003"); // no marker at all (crashed pre-marker run)

		const corrupt = await makeSandbox("tbad00004");
		await Bun.write(path.join(corrupt, ISOLATION_OWNER_FILE), "{ not json");

		// Setup race: marker written before the backend materialises `m`. The
		// dir holds only the live-owner marker and no mount yet.
		const pending = path.join(base, "tpend0005");
		await fs.mkdir(pending, { recursive: true });
		await writeIsolationOwner(pending, "pend0005");

		// Recycled pid: platforms with start-token support can distinguish this
		// stale owner from the live process that inherited its pid.
		const recycled = await makeSandbox("trecyc06");
		const currentOwner = await currentProcessOwner();
		await Bun.write(
			path.join(recycled, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "recyc06", startToken: "not-the-current-token" }),
		);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const exists = async (p: string): Promise<boolean> =>
			await fs.stat(p).then(
				() => true,
				() => false,
			);
		expect(await Bun.file(path.join(live, "m", "work.txt")).exists()).toBe(true);
		expect(await exists(dead)).toBe(false);
		expect(await exists(orphan)).toBe(false);
		expect(await exists(corrupt)).toBe(false);
		expect(await exists(pending)).toBe(true);
		expect(await exists(recycled)).toBe(currentOwner.startToken === undefined);
	});

	it("never follows managed-root symlinks during default or --all cleanup", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-outside-"));
		tempRoots.push(outside);
		const outsideMount = path.join(outside, "m");
		await fs.mkdir(outsideMount);
		const sentinel = path.join(outsideMount, "sentinel.txt");
		await Bun.write(sentinel, "must survive\n");
		const topLevelLink = path.join(base, "top-level-link");
		await fs.symlink(outside, topLevelLink, "dir");

		const placeNestedLink = async (name: string): Promise<string> => {
			const container = path.join(base, name);
			await fs.mkdir(container);
			await fs.symlink(outside, path.join(container, "intermediate-link"), "dir");
			return container;
		};

		const defaultContainer = await placeNestedLink("default-container");
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const defaultResult = JSON.parse(output.join("\n")) as {
			results: Array<{ path: string }>;
		};

		expect(defaultResult.results.map(result => result.path)).toEqual([defaultContainer]);
		expect(await fs.readFile(sentinel, "utf8")).toBe("must survive\n");
		expect((await fs.lstat(topLevelLink)).isSymbolicLink()).toBe(true);

		output.length = 0;
		const allContainer = await placeNestedLink("all-container");
		await clearWorktrees({ all: true, dryRun: false, json: true });
		const allResult = JSON.parse(output.join("\n")) as {
			results: Array<{ path: string }>;
		};

		expect(allResult.results.map(result => result.path)).toEqual([allContainer]);
		expect(await fs.readFile(sentinel, "utf8")).toBe("must survive\n");
		expect((await fs.lstat(topLevelLink)).isSymbolicLink()).toBe(true);
	});

	it("normal clear preserves registered live and idle session worktrees", async () => {
		const live = await makeSessionWorktree("live-session", { locked: true });
		const idle = await makeSessionWorktree("idle-session", { locked: false });

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(JSON.parse(output.join("\n"))).toEqual({ removed: 0, kept: 2 });
		expect(await fs.readFile(path.join(live.dir, "unfinished.txt"), "utf8")).toBe("live-session work\n");
		expect(await fs.readFile(path.join(idle.dir, "unfinished.txt"), "utf8")).toBe("idle-session work\n");
		const liveRegistration = (await git.worktree.list(live.repo)).find(
			entry => entry.branch === `refs/heads/${live.branch}`,
		);
		const idleRegistration = (await git.worktree.list(idle.repo)).find(
			entry => entry.branch === `refs/heads/${idle.branch}`,
		);
		expect(liveRegistration?.locked).toContain(`pid ${process.pid}`);
		expect(idleRegistration).toBeDefined();
		expect(idleRegistration?.locked).toBeUndefined();
	});

	it("dry-run --all excludes live-locked and live-owned sessions, but reports unlocked sessions", async () => {
		const locked = await makeSessionWorktree("dry-run-locked", { locked: true });
		const owned = await makeSessionWorktree("dry-run-owned", { locked: false });
		await writeSessionWorktreeOwner(owned.dir, "dry-run-owned");
		const idle = await makeSessionWorktree("dry-run-idle", { locked: false });

		await clearWorktrees({ all: true, dryRun: true, json: true });

		expect(JSON.parse(output.join("\n"))).toEqual({ wouldRemove: [idle.dir] });
		expect(await fs.readFile(path.join(locked.dir, "unfinished.txt"), "utf8")).toBe("dry-run-locked work\n");
		expect(await fs.readFile(path.join(owned.dir, "unfinished.txt"), "utf8")).toBe("dry-run-owned work\n");
		expect(await fs.readFile(path.join(idle.dir, "unfinished.txt"), "utf8")).toBe("dry-run-idle work\n");
	});

	it("clear --all removes unlocked sessions while preserving live-locked and live-owned ones", async () => {
		const locked = await makeSessionWorktree("live-locked", { locked: true });
		const owned = await makeSessionWorktree("live-owned", { locked: false });
		await writeSessionWorktreeOwner(owned.dir, "live-owned");
		const idle = await makeSessionWorktree("unlocked-idle", { locked: false });

		await clearWorktrees({ all: true, dryRun: false, json: true });

		expect(JSON.parse(output.join("\n"))).toMatchObject({ removed: 1, failed: 0 });
		expect(await fs.stat(idle.dir).catch(() => null)).toBeNull();
		expect(await fs.stat(locked.dir).catch(() => null)).not.toBeNull();
		expect(await fs.stat(owned.dir).catch(() => null)).not.toBeNull();
	});

	it("sweeps orphaned .owner files during clear", async () => {
		const orphanMarker = path.join(base, "deleted-session-123.owner");
		await Bun.write(orphanMarker, JSON.stringify({ pid: process.pid, name: "deleted-session" }));

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(await fs.stat(orphanMarker).catch(() => null)).toBeNull();
	});

	it("preserves a worktree that became live-owned concurrently after scan but before locked removal", async () => {
		const session = await makeSessionWorktree("racy-session", { locked: false });

		const originalWithFileLock = fileLockModule.withFileLock;
		const lockSpy = vi.spyOn(fileLockModule, "withFileLock").mockImplementation(async (filePath, fn, opts) => {
			// Simulate concurrent launch writing owner marker after clearWorktrees scanned it as unlocked
			await writeSessionWorktreeOwner(session.dir, "racy-session");
			return originalWithFileLock(filePath, fn, opts);
		});

		try {
			await clearWorktrees({ all: true, dryRun: false, json: true });

			const parsed = JSON.parse(output.join("\n"));
			expect(parsed).toMatchObject({ removed: 0 });
			expect(await fs.stat(session.dir).catch(() => null)).not.toBeNull();
			expect(await fs.readFile(path.join(session.dir, "unfinished.txt"), "utf8")).toBe("racy-session work\n");
		} finally {
			lockSpy.mockRestore();
		}
	});

	it("fails with actionable error when worktree lock is contended during clear --all", async () => {
		const session = await makeSessionWorktree("contended-clear", { locked: false });
		const canonicalPrimary = await fs.realpath(session.repo);
		const repoLockTarget = path.join(base, `.session-${hashPath(canonicalPrimary)}`);

		await fileLockModule.withFileLock(repoLockTarget, async () => {
			await clearWorktrees({ all: true, dryRun: false, json: true });
			const parsed = JSON.parse(output.join("\n"));
			expect(parsed.failed).toBe(1);
			expect(parsed.results[0].ok).toBe(false);
			expect(parsed.results[0].error).toContain("concurrent omp launch or removal");
			expect(process.exitCode).toBe(1);
		});
	});
});
