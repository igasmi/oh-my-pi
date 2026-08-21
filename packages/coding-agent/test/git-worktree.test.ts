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
});
