import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupWorktree } from "@oh-my-pi/pi-coding-agent/cli/startup-worktree";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { fetchPullRequest, parsePullRequestSelector } from "@oh-my-pi/pi-coding-agent/worktree/pr-selector";
import { getProjectDir, getWorktreesDir, removeWithRetries, setProjectDir, setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`);
	}
	return stdout.trim();
}

interface RemoteFixture {
	readonly bareRemote: string;
	readonly repo: string;
	readonly root: string;
}

async function createRemoteFixture(): Promise<RemoteFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-pr-"));
	tempRoots.push(root);
	const repo = path.join(root, "repo");
	const bareRemote = path.join(root, "origin.git");
	await fs.mkdir(repo);
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "pr-test@example.invalid"]);
	await runGit(repo, ["config", "user.name", "PR Test"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "tracked.txt"]);
	await runGit(repo, ["commit", "-q", "-m", "base"]);
	await runGit(root, ["init", "--bare", "-q", bareRemote]);
	await runGit(repo, ["remote", "add", "origin", bareRemote]);
	await runGit(repo, ["push", "-q", "origin", "main"]);
	return { bareRemote, repo, root };
}

async function publishRequestCommit(repo: string, remote: string, remoteRef: string): Promise<string> {
	await fs.writeFile(path.join(repo, "request.txt"), `${remoteRef}\n`);
	await runGit(repo, ["add", "request.txt"]);
	await runGit(repo, ["commit", "-q", "-m", remoteRef]);
	const commit = await runGit(repo, ["rev-parse", "HEAD"]);
	await runGit(repo, ["push", "-q", remote, `HEAD:${remoteRef}`]);
	return commit;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => removeWithRetries(root)));
});

describe("pull request selectors", () => {
	test("accepts only #N, GitHub pull URLs, and GitLab merge-request URLs", () => {
		expect(parsePullRequestSelector("#42")).toEqual({ kind: "shorthand", number: 42, raw: "#42" });
		expect(parsePullRequestSelector("https://github.com/acme/widgets/pull/17")).toEqual({
			kind: "github-url",
			number: 17,
			raw: "https://github.com/acme/widgets/pull/17",
		});
		expect(parsePullRequestSelector("https://gitlab.example/acme/platform/widgets/-/merge_requests/8")).toEqual({
			kind: "gitlab-url",
			number: 8,
			raw: "https://gitlab.example/acme/platform/widgets/-/merge_requests/8",
		});
		expect(parsePullRequestSelector("42")).toBeNull();
	});

	test("surfaces actionable errors for malformed recognized selector forms", () => {
		expect(() => parsePullRequestSelector("#0")).toThrow(/expected #N with a positive integer/);
		expect(parsePullRequestSelector("owner/repo#12")).toBeNull();
		expect(() => parsePullRequestSelector("https://github.com/acme/widgets/pull/12/files")).toThrow(
			/expected \/owner\/repo\/pull\/N/,
		);
	});

	test("fetches a GitHub pull ref from a local origin into a bounded local ref", async () => {
		const { repo } = await createRemoteFixture();
		const expectedCommit = await publishRequestCommit(repo, "origin", "refs/pull/42/head");
		const selector = parsePullRequestSelector("#42");
		if (!selector) throw new Error("Expected #42 to parse as a pull request selector");

		const result = await fetchPullRequest(repo, selector);

		expect(result).toEqual({
			commit: expectedCommit,
			name: "pr-42",
			ref: "refs/omp/worktrees/pr-42",
		});
		expect(await git.ref.resolve(repo, result.ref)).toBe(expectedCommit);
	});

	test("falls back from pull to merge-request refs for an unrecognized local origin host", async () => {
		const { repo } = await createRemoteFixture();
		const expectedCommit = await publishRequestCommit(repo, "origin", "refs/merge-requests/9/head");
		const selector = parsePullRequestSelector("https://gitlab.example/acme/widgets/-/merge_requests/9");
		if (!selector) throw new Error("Expected the GitLab merge-request URL to parse");

		const result = await fetchPullRequest(repo, selector);

		expect(result.name).toBe("pr-9");
		expect(result.commit).toBe(expectedCommit);
		expect(await git.ref.resolve(repo, "refs/omp/worktrees/pr-9")).toBe(expectedCommit);
	});

	test("routes a declared GitHub origin only through pull refs while using a local URL rewrite", async () => {
		const { bareRemote, repo } = await createRemoteFixture();
		await publishRequestCommit(repo, "origin", "refs/merge-requests/10/head");
		const declaredOrigin = "https://github.com/acme/widgets.git";
		await runGit(repo, ["config", `url.${url.pathToFileURL(bareRemote).href}.insteadOf`, declaredOrigin]);
		await runGit(repo, ["remote", "set-url", "origin", declaredOrigin]);
		const selector = parsePullRequestSelector("#10");
		if (!selector) throw new Error("Expected #10 to parse as a pull request selector");

		await expect(fetchPullRequest(repo, selector)).rejects.toThrow(
			/Unable to fetch pull request #10 from origin \(github\.com\); attempted refs\/pull\/10\/head\./,
		);
		expect(await git.ref.resolve(repo, "refs/omp/worktrees/pr-10")).toBeNull();
	});

	test("always fetches from origin and never consults an upstream remote", async () => {
		const { repo, root } = await createRemoteFixture();
		const upstream = path.join(root, "upstream.git");
		await runGit(root, ["init", "--bare", "-q", upstream]);
		await runGit(repo, ["remote", "add", "upstream", upstream]);
		await publishRequestCommit(repo, "upstream", "refs/pull/77/head");
		const selector = parsePullRequestSelector("#77");
		if (!selector) throw new Error("Expected #77 to parse as a pull request selector");

		await expect(fetchPullRequest(repo, selector)).rejects.toThrow(
			/Unable to fetch pull request #77 from origin.*attempted refs\/pull\/77\/head then refs\/merge-requests\/77\/head/,
		);
		expect(await git.ref.resolve(repo, "refs/omp/worktrees/pr-77")).toBeNull();
	});

	test("reports a missing origin without attempting another remote", async () => {
		const { repo } = await createRemoteFixture();
		await runGit(repo, ["remote", "remove", "origin"]);
		const selector = parsePullRequestSelector("#5");
		if (!selector) throw new Error("Expected #5 to parse as a pull request selector");

		await expect(fetchPullRequest(repo, selector)).rejects.toThrow(/repository has no origin remote/);
	});
});

describe("-w pull request selector integration", () => {
	test("checks out the request head into a pr-<n> worktree pinned at the fetched commit", async () => {
		const fixture = await createRemoteFixture();
		const commit = await publishRequestCommit(fixture.repo, fixture.bareRemote, "refs/pull/7/head");
		// Rewind local main so the request head differs from both HEAD and the
		// remote default — proving the branch is pinned to the fetched commit.
		await runGit(fixture.repo, ["reset", "--hard", "HEAD~1"]);

		const managed = path.join(fixture.root, "managed-worktrees");
		const previousProjectDir = getProjectDir();
		const previousWorktreesDir = getWorktreesDir();
		try {
			setProjectDir(fixture.repo);
			setWorktreesDir(managed);
			const parsed = parseArgs(["-w", "#7"]);
			const worktree = await applyStartupWorktree(parsed);
			expect(worktree).not.toBeNull();
			if (!worktree) throw new Error("applyStartupWorktree returned null for -w '#7'");
			try {
				expect(worktree.name).toBe("pr-7");
				expect(worktree.branch).toBe("worktree-pr-7");
				expect(parsed.cwd).toBe(worktree.path);
				expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(commit);
				expect(await git.branch.current(worktree.path)).toBe("worktree-pr-7");
			} finally {
				await worktree.release();
			}
		} finally {
			setProjectDir(previousProjectDir);
			setWorktreesDir(previousWorktreesDir);
		}
	});
});

describe("-w .worktreeinclude lifecycle", () => {
	async function withWorktreeGlobals<T>(repo: string, managed: string, run: () => Promise<T>): Promise<T> {
		const previousProjectDir = getProjectDir();
		const previousWorktreesDir = getWorktreesDir();
		try {
			setProjectDir(repo);
			setWorktreesDir(managed);
			return await run();
		} finally {
			setProjectDir(previousProjectDir);
			setWorktreesDir(previousWorktreesDir);
		}
	}

	async function seedIncludeFixture(repo: string): Promise<void> {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.env\n");
		await fs.writeFile(path.join(repo, "local.env"), "SECRET=1\n");
		await runGit(repo, ["add", ".gitignore"]);
		await runGit(repo, ["commit", "-q", "-m", "ignore env"]);
		await runGit(repo, ["push", "-q", "origin", "main"]);
	}

	test("a failed include copy rolls back the checkout and branch so retry re-seeds", async () => {
		const fixture = await createRemoteFixture();
		await seedIncludeFixture(fixture.repo);
		// A symlinked .worktreeinclude is rejected by copyWorktreeIncludes.
		await fs.writeFile(path.join(fixture.repo, "include-target"), "*.env\n");
		await fs.symlink(path.join(fixture.repo, "include-target"), path.join(fixture.repo, ".worktreeinclude"));
		const managed = path.join(fixture.root, "managed-worktrees");

		await withWorktreeGlobals(fixture.repo, managed, async () => {
			await expect(applyStartupWorktree(parseArgs(["-w", "inc-fail"]))).rejects.toThrow(/\.worktreeinclude/);
			// Checkout AND the branch this launch created are gone — a leftover
			// would make the retry skip seeding silently.
			const entries = await fs.readdir(managed).catch(() => []);
			expect(entries.filter(entry => entry.includes("inc-fail"))).toEqual([]);
			await expect(
				runGit(fixture.repo, ["rev-parse", "--verify", "refs/heads/worktree-inc-fail"]),
			).rejects.toThrow();

			// Fix the include file; the SAME name must now succeed and seed.
			await fs.unlink(path.join(fixture.repo, ".worktreeinclude"));
			await fs.writeFile(path.join(fixture.repo, ".worktreeinclude"), "*.env\n");
			const worktree = await applyStartupWorktree(parseArgs(["-w", "inc-fail"]));
			expect(worktree).not.toBeNull();
			if (!worktree) throw new Error("retry launch returned null");
			try {
				expect(await Bun.file(path.join(worktree.path, "local.env")).text()).toBe("SECRET=1\n");
			} finally {
				await worktree.release();
			}
		});
	});

	test("a pre-existing branch without a checkout still seeds includes into the new directory", async () => {
		const fixture = await createRemoteFixture();
		await seedIncludeFixture(fixture.repo);
		await fs.writeFile(path.join(fixture.repo, ".worktreeinclude"), "*.env\n");
		// Leftover branch, no checkout — the omp worktree clear shape. Seeding is
		// gated on directory creation, not branch reuse.
		await runGit(fixture.repo, ["branch", "worktree-leftover"]);
		const managed = path.join(fixture.root, "managed-worktrees");

		await withWorktreeGlobals(fixture.repo, managed, async () => {
			const worktree = await applyStartupWorktree(parseArgs(["-w", "leftover"]));
			expect(worktree).not.toBeNull();
			if (!worktree) throw new Error("leftover launch returned null");
			try {
				expect(worktree.reused).toBe(true);
				expect(await Bun.file(path.join(worktree.path, "local.env")).text()).toBe("SECRET=1\n");
			} finally {
				await worktree.release();
			}
		});
	});
});
