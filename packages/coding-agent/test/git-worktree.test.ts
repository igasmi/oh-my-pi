import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";

import * as git from "../src/utils/git";

function runGit(cwd: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_ATTR_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

describe("git branch and worktree primitives", () => {
	let repoRoot: string;
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-worktree-"));
		repoRoot = path.join(tempRoot, "repo");
		await fs.mkdir(repoRoot);
		runGit(repoRoot, ["init", "--initial-branch=main"]);
		await fs.writeFile(path.join(repoRoot, "tracked.txt"), "baseline\n");
		runGit(repoRoot, ["add", "tracked.txt"]);
		runGit(repoRoot, [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"baseline",
		]);
	});

	afterEach(async () => {
		git._resetGitVersionForTesting();
		await fs.rm(tempRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
	});

	it("preserves origin versus upstream identity while deriving the short default branch", async () => {
		runGit(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		runGit(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
		runGit(repoRoot, ["update-ref", "refs/remotes/upstream/release/next", "HEAD"]);
		runGit(repoRoot, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/release/next"]);

		expect(await git.branch.defaultRef(repoRoot)).toBe("refs/remotes/origin/main");
		expect(await git.branch.default(repoRoot)).toBe("main");

		runGit(repoRoot, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
		expect(await git.branch.defaultRef(repoRoot)).toBe("refs/remotes/upstream/release/next");
		expect(await git.branch.default(repoRoot)).toBe("release/next");
	});

	it("creates a locked detached worktree atomically", async () => {
		const target = path.join(tempRoot, "locked-worktree");
		const reason = "omp startup isolation";

		await git.worktree.add(repoRoot, target, "HEAD", { detach: true, lockReason: reason });

		const entry = (await git.worktree.list(repoRoot)).find(
			candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(target),
		);
		expect(entry).toMatchObject({ detached: true, locked: reason });
		expect(normalizePathForComparison(entry?.path ?? "")).toBe(normalizePathForComparison(target));
		expect(await fs.readFile(path.join(target, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	it.skipIf(process.platform === "win32")(
		"round-trips worktree paths and lock reasons containing tabs, newlines, and backslashes",
		async () => {
			const suffix = "worktree\tline\nslash\\name";
			const target = path.join(tempRoot, suffix);
			const reason = "reason\tline\nslash\\value";
			await git.worktree.add(repoRoot, target, "HEAD", { detach: true, lockReason: reason });

			const entry = (await git.worktree.list(repoRoot)).find(candidate => path.basename(candidate.path) === suffix);
			expect(entry).toBeDefined();
			expect(path.basename(entry?.path ?? "")).toBe(suffix);
			expect(entry?.locked).toBe(reason);
			expect(entry?.detached).toBe(true);
			expect(await fs.readFile(path.join(target, "tracked.txt"), "utf8")).toBe("baseline\n");
		},
	);

	it("parses newline porcelain format with branches, detached, bare locks, reasons, and prunables", () => {
		const fixture = [
			"worktree /repo/main",
			"HEAD 1111111111111111111111111111111111111111",
			"branch refs/heads/main",
			"",
			"worktree /repo/detached",
			"HEAD 2222222222222222222222222222222222222222",
			"detached",
			"",
			"worktree /repo/locked-bare",
			"HEAD 3333333333333333333333333333333333333333",
			"branch refs/heads/locked-bare",
			"locked",
			"",
			"worktree /repo/locked-with-reason",
			"HEAD 4444444444444444444444444444444444444444",
			"branch refs/heads/locked-with-reason",
			"locked omp startup isolation",
			"",
			"worktree /repo/prunable",
			"HEAD 5555555555555555555555555555555555555555",
			"detached",
			"prunable gitdir file points to non-existent location",
			"",
			'worktree "/repo/quoted\\tpath\\nwith\\"special"',
			"HEAD 6666666666666666666666666666666666666666",
			"branch refs/heads/feature",
			"",
		].join("\n");

		const entries = git.parseWorktreeListNewline(fixture);
		expect(entries).toEqual([
			{
				path: "/repo/main",
				head: "1111111111111111111111111111111111111111",
				branch: "refs/heads/main",
				detached: false,
			},
			{
				path: "/repo/detached",
				head: "2222222222222222222222222222222222222222",
				detached: true,
			},
			{
				path: "/repo/locked-bare",
				head: "3333333333333333333333333333333333333333",
				branch: "refs/heads/locked-bare",
				detached: false,
				locked: "",
			},
			{
				path: "/repo/locked-with-reason",
				head: "4444444444444444444444444444444444444444",
				branch: "refs/heads/locked-with-reason",
				detached: false,
				locked: "omp startup isolation",
			},
			{
				path: "/repo/prunable",
				head: "5555555555555555555555555555555555555555",
				detached: true,
			},
			{
				path: '/repo/quoted\tpath\nwith"special',
				head: "6666666666666666666666666666666666666666",
				branch: "refs/heads/feature",
				detached: false,
			},
		]);
	});

	it("checks if refs contain a commit with ref.containsCommit", async () => {
		const baseSha = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();

		// Create a second branch with a new commit
		runGit(repoRoot, ["checkout", "-b", "feature"]);
		await fs.writeFile(path.join(repoRoot, "feature.txt"), "feature content\n");
		runGit(repoRoot, ["add", "feature.txt"]);
		runGit(repoRoot, [
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@test.local",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"feature commit",
		]);
		const featureSha = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();

		// Base commit is contained in both main and feature refs
		expect(await git.ref.containsCommit(repoRoot, baseSha)).toBe(true);
		expect(await git.ref.containsCommit(repoRoot, baseSha, { excludeRef: "refs/heads/feature" })).toBe(true);

		// Feature commit is contained only in refs/heads/feature
		expect(await git.ref.containsCommit(repoRoot, featureSha)).toBe(true);
		expect(await git.ref.containsCommit(repoRoot, featureSha, { excludeRef: "refs/heads/feature" })).toBe(false);

		// Non-existent commit returns false
		expect(await git.ref.containsCommit(repoRoot, "0000000000000000000000000000000000000000")).toBe(false);
	});

	it("parses and compares git versions", () => {
		expect(git.parseGitVersion("git version 2.39.3")).toEqual({ major: 2, minor: 39, patch: 3 });
		expect(git.parseGitVersion("git version 2.34.1.windows.1")).toEqual({ major: 2, minor: 34, patch: 1 });
		expect(git.parseGitVersion("git version 2.36.0 (Apple Git-146)")).toEqual({ major: 2, minor: 36, patch: 0 });
		expect(git.parseGitVersion("not git")).toBeNull();

		expect(git.isGitVersionAtLeast({ major: 2, minor: 36, patch: 0 }, 2, 36)).toBe(true);
		expect(git.isGitVersionAtLeast({ major: 2, minor: 35, patch: 9 }, 2, 36)).toBe(false);
		expect(git.isGitVersionAtLeast({ major: 3, minor: 0, patch: 0 }, 2, 36)).toBe(true);
		expect(git.isGitVersionAtLeast(null, 2, 36)).toBe(false);
	});

	it("creates a locked detached worktree on simulated git < 2.36 using two-step add and lock fallback", async () => {
		git._setGitVersionForTesting({ major: 2, minor: 35, patch: 0 });
		const target = path.join(tempRoot, "old-git-worktree");
		const reason = "old git lock reason";

		await git.worktree.add(repoRoot, target, "HEAD", { detach: true, lockReason: reason });

		const entries = await git.worktree.list(repoRoot);
		const entry = entries.find(
			candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(target),
		);
		expect(entry).toBeDefined();
		expect(entry).toMatchObject({ detached: true, locked: reason });
		expect(await fs.readFile(path.join(target, "tracked.txt"), "utf8")).toBe("baseline\n");
	});
});
