import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorktreeIsolation } from "@oh-my-pi/pi-coding-agent/session/worktree-isolation";
import { copyWorktreeIncludes } from "@oh-my-pi/pi-coding-agent/worktree/worktree-include";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

interface IncludeFixture {
	readonly isolation: WorktreeIsolation;
	readonly primaryRoot: string;
	readonly worktreeRoot: string;
}

async function createFixture(): Promise<IncludeFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-include-"));
	tempRoots.push(root);
	const primaryRoot = path.join(root, "primary");
	const worktreeRoot = path.join(root, "worktree");
	await fs.mkdir(primaryRoot);
	await fs.mkdir(worktreeRoot);
	await runGit(primaryRoot, ["init", "-q", "-b", "main"]);
	await runGit(primaryRoot, ["config", "user.email", "include-test@example.invalid"]);
	await runGit(primaryRoot, ["config", "user.name", "Include Test"]);
	return {
		primaryRoot,
		worktreeRoot,
		isolation: {
			branch: "worktree-test",
			commonDir: path.join(primaryRoot, ".git"),
			name: "test",
			primaryRoot,
			worktreeRoot,
		},
	};
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => removeWithRetries(root)));
});

describe("worktree include copying", () => {
	test("copies only currently ignored untracked matches and preserves file and directory modes", async () => {
		const { isolation, primaryRoot, worktreeRoot } = await createFixture();
		await fs.writeFile(path.join(primaryRoot, ".gitignore"), "ignored/\n*.env\n");
		await fs.writeFile(path.join(primaryRoot, ".worktreeinclude"), "ignored/\n*.env\ntracked.txt\nvisible.txt\n");
		await fs.writeFile(path.join(primaryRoot, "tracked.txt"), "tracked\n");
		await fs.writeFile(path.join(primaryRoot, "visible.txt"), "ordinary untracked\n");
		await fs.mkdir(path.join(primaryRoot, "ignored"), { mode: 0o700 });
		await fs.writeFile(path.join(primaryRoot, "ignored", "secret.txt"), "secret\n", { mode: 0o600 });
		await fs.writeFile(path.join(primaryRoot, "local.env"), "TOKEN=local\n", { mode: 0o640 });
		await runGit(primaryRoot, ["add", ".gitignore", ".worktreeinclude", "tracked.txt"]);
		await runGit(primaryRoot, ["commit", "-q", "-m", "fixture"]);

		const result = await copyWorktreeIncludes(isolation);

		expect(result.copiedPaths).toEqual(["ignored/secret.txt", "local.env"]);
		expect(await fs.readFile(path.join(worktreeRoot, "ignored", "secret.txt"), "utf8")).toBe("secret\n");
		expect(await fs.readFile(path.join(worktreeRoot, "local.env"), "utf8")).toBe("TOKEN=local\n");
		expect(await fs.stat(path.join(worktreeRoot, "tracked.txt")).catch(() => null)).toBeNull();
		expect(await fs.stat(path.join(worktreeRoot, "visible.txt")).catch(() => null)).toBeNull();
		if (process.platform !== "win32") {
			expect((await fs.stat(path.join(worktreeRoot, "ignored"))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(worktreeRoot, "ignored", "secret.txt"))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.join(worktreeRoot, "local.env"))).mode & 0o777).toBe(0o640);
		}
	});

	test("uses .worktreeinclude negation with Git-native ignore semantics", async () => {
		const { isolation, primaryRoot, worktreeRoot } = await createFixture();
		await fs.writeFile(path.join(primaryRoot, ".gitignore"), "cache/\n");
		await fs.writeFile(path.join(primaryRoot, ".worktreeinclude"), "cache/*\n!cache/private.txt\n");
		await fs.mkdir(path.join(primaryRoot, "cache"));
		await fs.writeFile(path.join(primaryRoot, "cache", "public.txt"), "copy\n");
		await fs.writeFile(path.join(primaryRoot, "cache", "private.txt"), "do not copy\n");

		const result = await copyWorktreeIncludes(isolation);

		expect(result.copiedPaths).toEqual(["cache/public.txt"]);
		expect(await fs.readFile(path.join(worktreeRoot, "cache", "public.txt"), "utf8")).toBe("copy\n");
		expect(await fs.stat(path.join(worktreeRoot, "cache", "private.txt")).catch(() => null)).toBeNull();
	});

	test.skipIf(process.platform === "win32")(
		"rejects selected symlinks without following them and rolls back earlier copies",
		async () => {
			const { isolation, primaryRoot, worktreeRoot } = await createFixture();
			const outside = path.join(path.dirname(primaryRoot), "outside.txt");
			await fs.writeFile(outside, "must stay outside\n");
			await fs.writeFile(path.join(primaryRoot, ".gitignore"), "*.env\nz-link\n");
			await fs.writeFile(path.join(primaryRoot, ".worktreeinclude"), "*.env\nz-link\n");
			await fs.writeFile(path.join(primaryRoot, "a-copy.env"), "copied first\n");
			await fs.symlink(outside, path.join(primaryRoot, "z-link"));

			await expect(copyWorktreeIncludes(isolation)).rejects.toThrow(/symlink selected by \.worktreeinclude/);
			expect(await fs.stat(path.join(worktreeRoot, "a-copy.env")).catch(() => null)).toBeNull();
			expect(await fs.readFile(outside, "utf8")).toBe("must stay outside\n");
		},
	);

	test("does not overwrite an existing destination and rolls back the same batch", async () => {
		const { isolation, primaryRoot, worktreeRoot } = await createFixture();
		await fs.writeFile(path.join(primaryRoot, ".gitignore"), "*.env\n");
		await fs.writeFile(path.join(primaryRoot, ".worktreeinclude"), "*.env\n");
		await fs.writeFile(path.join(primaryRoot, "a.env"), "first\n");
		await fs.writeFile(path.join(primaryRoot, "z.env"), "source\n");
		await fs.writeFile(path.join(worktreeRoot, "z.env"), "existing\n");

		await expect(copyWorktreeIncludes(isolation)).rejects.toThrow(/Refusing to overwrite/);
		expect(await fs.stat(path.join(worktreeRoot, "a.env")).catch(() => null)).toBeNull();
		expect(await fs.readFile(path.join(worktreeRoot, "z.env"), "utf8")).toBe("existing\n");
	});

	test("copies valid ignored dot-prefixed child files such as ..cache/token", async () => {
		const { isolation, primaryRoot, worktreeRoot } = await createFixture();
		await fs.writeFile(path.join(primaryRoot, ".gitignore"), "..cache/\n");
		await fs.writeFile(path.join(primaryRoot, ".worktreeinclude"), "..cache/token\n");
		await fs.mkdir(path.join(primaryRoot, "..cache"));
		await fs.writeFile(path.join(primaryRoot, "..cache", "token"), "secret-token\n");
		await runGit(primaryRoot, ["add", ".gitignore", ".worktreeinclude"]);
		await runGit(primaryRoot, ["commit", "-q", "-m", "fixture"]);

		const result = await copyWorktreeIncludes(isolation);

		expect(result.copiedPaths).toEqual(["..cache/token"]);
		expect(await fs.readFile(path.join(worktreeRoot, "..cache", "token"), "utf8")).toBe("secret-token\n");
	});
});
