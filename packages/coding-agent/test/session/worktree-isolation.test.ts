import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	assertWorktreeMutationAllowed,
	classifyWorktreePath,
	filterWorktreeAdditionalDirectories,
	validateWorktreeIsolation,
	type WorktreeIsolation,
	WorktreeIsolationError,
} from "@oh-my-pi/pi-coding-agent/session/worktree-isolation";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

interface WorktreeFixture {
	root: string;
	primaryRoot: string;
	worktreeRoot: string;
	isolation: WorktreeIsolation;
}

const cleanupRoots: string[] = [];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`);
	return stdout.trim();
}

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

async function createWorktreeFixture(prefix = "omp-worktree-isolation-"): Promise<WorktreeFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	const primaryRoot = path.join(root, "primary");
	const worktreeRoot = path.join(root, "linked");
	await fs.mkdir(primaryRoot);
	await runGit(primaryRoot, ["init", "-q", "-b", "main"]);
	await runGit(primaryRoot, ["config", "user.email", "worktree-isolation@example.invalid"]);
	await runGit(primaryRoot, ["config", "user.name", "Worktree Isolation Test"]);
	await fs.writeFile(path.join(primaryRoot, "tracked.txt"), "baseline\n");
	await runGit(primaryRoot, ["add", "tracked.txt"]);
	await runGit(primaryRoot, ["commit", "-q", "-m", "baseline"]);
	await runGit(primaryRoot, ["worktree", "add", "-q", "-b", "worktree-binding", worktreeRoot]);

	const repository = await git.repo.resolve(worktreeRoot);
	if (!repository) throw new Error("Expected linked worktree repository metadata");
	const canonicalPrimaryRoot = await fs.realpath(primaryRoot);
	const canonicalWorktreeRoot = await fs.realpath(worktreeRoot);
	const commonDir = await fs.realpath(repository.commonDir);
	return {
		root: await fs.realpath(root),
		primaryRoot: canonicalPrimaryRoot,
		worktreeRoot: canonicalWorktreeRoot,
		isolation: {
			worktreeRoot: canonicalWorktreeRoot,
			primaryRoot: canonicalPrimaryRoot,
			name: "binding",
			branch: "worktree-binding",
			commonDir,
			managed: true,
		},
	};
}

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("worktree isolation binding", () => {
	test("serializes and reopens a verified linked-worktree binding identically", async () => {
		const fixture = await createWorktreeFixture();
		const sessionDir = path.join(fixture.root, "sessions");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(fixture.worktreeRoot, sessionDir, storage, {
			worktreeIsolation: fixture.isolation,
		});
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");

		const reopened = await SessionManager.open(sessionFile, sessionDir, storage);
		expect(reopened.getWorktreeIsolation()).toEqual(fixture.isolation);
		expect(reopened.getHeader()?.worktreeIsolation).toEqual(fixture.isolation);

		const forkedFiles = await reopened.fork();
		expect(forkedFiles).toBeDefined();
		expect(reopened.getWorktreeIsolation()).toEqual(fixture.isolation);
	});

	test("retains the binding in memory and only inherits it when forking into the same worktree", async () => {
		const fixture = await createWorktreeFixture();
		const inMemory = SessionManager.inMemory(fixture.worktreeRoot, new MemorySessionStorage(), {
			worktreeIsolation: fixture.isolation,
		});
		expect(inMemory.getWorktreeIsolation()).toEqual(fixture.isolation);

		const sessionDir = path.join(fixture.root, "sessions");
		const source = SessionManager.create(fixture.worktreeRoot, sessionDir, new FileSessionStorage(), {
			worktreeIsolation: fixture.isolation,
		});
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Expected a persistent session file");

		const sameWorktreeFork = await SessionManager.forkFrom(
			sourceFile,
			fixture.worktreeRoot,
			path.join(fixture.root, "same-worktree-fork"),
		);
		expect(sameWorktreeFork.getWorktreeIsolation()).toEqual(fixture.isolation);

		const primaryFork = await SessionManager.forkFrom(
			sourceFile,
			fixture.primaryRoot,
			path.join(fixture.root, "primary-fork"),
		);
		expect(primaryFork.getWorktreeIsolation()).toBeUndefined();
	});

	test("continues to load headers written before worktree bindings existed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-legacy-"));
		cleanupRoots.push(root);
		const sessionFile = path.join(root, "legacy.jsonl");
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);

		const manager = await SessionManager.open(sessionFile, root);

		expect(manager.getSessionId()).toBe("legacy");
		expect(manager.getWorktreeIsolation()).toBeUndefined();
	});

	test("reports a deleted linked worktree separately from tampering", async () => {
		const fixture = await createWorktreeFixture();
		await fs.rm(fixture.worktreeRoot, { recursive: true, force: true });

		const validation = await validateWorktreeIsolation(fixture.isolation);

		expect(validation.status).toBe("missing");
	});

	test("fails closed when the worktree root is replaced by a symlink", async () => {
		const fixture = await createWorktreeFixture();
		const replacement = path.join(fixture.root, "replacement");
		await fs.mkdir(replacement);
		await fs.rm(fixture.worktreeRoot, { recursive: true, force: true });
		await fs.symlink(replacement, fixture.worktreeRoot, "dir");

		const validation = await validateWorktreeIsolation(fixture.isolation);

		expect(validation.status).toBe("tampered");
	});

	test("rejects a binding to a foreign Git common directory", async () => {
		const fixture = await createWorktreeFixture("omp-worktree-isolation-a-");
		const foreign = await createWorktreeFixture("omp-worktree-isolation-b-");

		const validation = await validateWorktreeIsolation({
			...fixture.isolation,
			commonDir: foreign.isolation.commonDir,
		});

		expect(validation.status).toBe("tampered");
	});

	test("rejects a binding whose recorded branch no longer matches", async () => {
		const fixture = await createWorktreeFixture();

		const validation = await validateWorktreeIsolation({
			...fixture.isolation,
			branch: "worktree-other",
		});

		expect(validation.status).toBe("tampered");
	});

	test("rejects a linked-worktree admin directory with a forged backlink", async () => {
		const fixture = await createWorktreeFixture();
		const repository = await git.repo.resolve(fixture.worktreeRoot);
		if (!repository) throw new Error("Expected linked worktree repository metadata");
		await fs.writeFile(path.join(repository.gitDir, "gitdir"), path.join(fixture.primaryRoot, ".git"));

		const validation = await validateWorktreeIsolation(fixture.isolation);

		expect(validation.status).toBe("tampered");
	});

	test("SessionManager.open exposes missing and tampered bindings with distinct error codes", async () => {
		const fixture = await createWorktreeFixture();
		const sessionDir = path.join(fixture.root, "sessions");
		const manager = SessionManager.create(fixture.worktreeRoot, sessionDir, new FileSessionStorage(), {
			worktreeIsolation: fixture.isolation,
		});
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		await fs.rm(fixture.worktreeRoot, { recursive: true, force: true });

		const missingError = await rejectionOf(SessionManager.open(sessionFile, sessionDir));
		expect(missingError).toBeInstanceOf(WorktreeIsolationError);
		expect((missingError as WorktreeIsolationError).code).toBe("missing");

		const replacement = path.join(fixture.root, "replacement");
		await fs.mkdir(replacement);
		await fs.symlink(replacement, fixture.worktreeRoot, "dir");
		const tamperedError = await rejectionOf(SessionManager.open(sessionFile, sessionDir));
		expect(tamperedError).toBeInstanceOf(WorktreeIsolationError);
		expect((tamperedError as WorktreeIsolationError).code).toBe("tampered");
	});

	test("primary checkout classification overrides additional-directory authorization", async () => {
		const fixture = await createWorktreeFixture();
		const primaryFile = path.join(fixture.primaryRoot, "tracked.txt");

		const classification = await classifyWorktreePath(fixture.isolation, primaryFile, {
			additionalDirectories: [fixture.primaryRoot],
		});

		expect(classification).toEqual({ kind: "primary", canonicalPath: primaryFile });
		const mutationError = await rejectionOf(
			assertWorktreeMutationAllowed(fixture.isolation, primaryFile, {
				additionalDirectories: [fixture.primaryRoot],
			}),
		);
		expect(mutationError).toBeInstanceOf(WorktreeIsolationError);
		expect((mutationError as WorktreeIsolationError).code).toBe("primary");
	});

	test("filters primary roots and symlink aliases while retaining canonical external roots", async () => {
		const fixture = await createWorktreeFixture();
		const primaryChild = path.join(fixture.primaryRoot, "child");
		const external = path.join(fixture.root, "external");
		const externalAlias = path.join(fixture.root, "external-alias");
		await fs.mkdir(primaryChild);
		await fs.mkdir(external);
		await fs.symlink(external, externalAlias, "dir");

		const filtered = await filterWorktreeAdditionalDirectories(fixture.isolation, [
			fixture.primaryRoot,
			primaryChild,
			externalAlias,
			external,
		]);

		expect(filtered).toEqual([external]);
	});

	test("classifies a followed symlink into primary as protected but the link itself as worktree-owned", async () => {
		const fixture = await createWorktreeFixture();
		const link = path.join(fixture.worktreeRoot, "primary-link");
		await fs.symlink(fixture.primaryRoot, link, "dir");

		expect(await classifyWorktreePath(fixture.isolation, link)).toEqual({
			kind: "primary",
			canonicalPath: fixture.primaryRoot,
		});
		expect(await classifyWorktreePath(fixture.isolation, link, { followFinal: false })).toEqual({
			kind: "worktree",
			canonicalPath: link,
		});
	});

	test("preserves all session manager state when newSession is called with a mismatched worktree binding", async () => {
		const fixture = await createWorktreeFixture("omp-worktree-isolation-a-");
		const foreign = await createWorktreeFixture("omp-worktree-isolation-b-");
		const sessionDir = path.join(fixture.root, "sessions");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(fixture.worktreeRoot, sessionDir, storage, {
			worktreeIsolation: fixture.isolation,
		});
		await manager.ensureOnDisk();
		manager.setSessionName("Original Session Name", "user");
		manager.appendSessionInit({ systemPrompt: "test system prompt", task: "initial task", tools: ["read"] });
		await manager.flush();

		const originalSessionId = manager.getSessionId();
		const originalSessionFile = manager.getSessionFile();
		const originalIsolation = manager.getWorktreeIsolation();
		const originalHeader = manager.getHeader();
		const originalTitle = manager.getSessionName();
		const originalTitleSource = manager.titleSource;
		const originalEntries = manager.getEntries();

		const error = await rejectionOf(manager.newSession({ worktreeIsolation: foreign.isolation }));
		expect(error).toBeInstanceOf(WorktreeIsolationError);
		expect((error as WorktreeIsolationError).code).toBe("tampered");

		expect(manager.getSessionId()).toBe(originalSessionId);
		expect(manager.getSessionFile()).toBe(originalSessionFile);
		expect(manager.getWorktreeIsolation()).toEqual(originalIsolation);
		expect(manager.getHeader()).toEqual(originalHeader);
		expect(manager.getSessionName()).toBe(originalTitle);
		expect(manager.titleSource).toBe(originalTitleSource);
		expect(manager.getEntries()).toEqual(originalEntries);
	});
});
