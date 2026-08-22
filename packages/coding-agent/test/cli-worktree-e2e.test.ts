import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const CLI_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 10_000;
const WORKTREE_BRANCH = "refs/heads/worktree-cli-e2e";
const INHERITED_ENV_DENYLIST = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
] as const;

interface CommandResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface WorktreeEntry {
	branch?: string;
	locked: boolean;
	path: string;
}

interface RequestObservation {
	authorization: string | null;
	body: unknown;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} exited ${exitCode}`);
	}
	return stdout.trim();
}

async function runCli(cwd: string, env: Record<string, string>, args: string[]): Promise<CommandResult> {
	const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: CLI_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function createCliEnv(root: string, agentDir: string, worktreeDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of INHERITED_ENV_DENYLIST) delete env[key];
	return {
		...env,
		PI_CODING_AGENT_DIR: agentDir,
		OMP_WORKTREE_DIR: worktreeDir,
		XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
		XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
		XDG_DATA_HOME: path.join(root, "xdg", "data"),
		XDG_STATE_HOME: path.join(root, "xdg", "state"),
		NO_COLOR: "1",
		CI: "true",
	};
}

function parseWorktrees(porcelain: string): WorktreeEntry[] {
	return porcelain
		.split("\n\n")
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const lines = block.split("\n");
			const worktree = lines.find(line => line.startsWith("worktree "));
			if (!worktree) throw new Error(`Malformed git worktree entry: ${block}`);
			return {
				path: worktree.slice("worktree ".length),
				branch: lines.find(line => line.startsWith("branch "))?.slice("branch ".length),
				locked: lines.some(line => line === "locked" || line.startsWith("locked ")),
			};
		});
}

function collectRequestText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(collectRequestText).join("\n");
	if (value && typeof value === "object") return Object.values(value).map(collectRequestText).join("\n");
	return "";
}

function expectRequestCwd(request: RequestObservation, cwd: string): void {
	const requestText = collectRequestText(request.body);
	const observed = requestText.match(/current working directory: '([^']+)'/)?.[1];
	expect(observed, `Request did not report a current working directory: ${JSON.stringify(requestText)}`).toBeDefined();
	expect(
		normalizePathForComparison(observed!),
		`CLI request ran in ${JSON.stringify(observed)} instead of ${JSON.stringify(cwd)}`,
	).toBe(normalizePathForComparison(cwd));
	expect(request.authorization).toBe("Bearer local-e2e-key");
}

async function expectNoManagedArtifacts(repo: string, worktreeDir: string): Promise<void> {
	expect(await fs.stat(worktreeDir).catch(() => null)).toBeNull();
	expect(parseWorktrees(await runGit(repo, ["worktree", "list", "--porcelain"]))).toEqual([
		{ path: repo, branch: "refs/heads/main", locked: false },
	]);
	expect(await runGit(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/worktree-"])).toBe("");
}

test("real source CLI preserves no-flag cwd inside and outside Git and isolates a named -w launch", async () => {
	const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-worktree-e2e-"));
	const requests: RequestObservation[] = [];
	let server: Bun.Server<undefined> | undefined;
	try {
		const root = await fs.realpath(createdRoot);
		const repo = path.join(root, "repo");
		const outsideRepo = path.join(root, "outside-repo");
		const agentDir = path.join(root, "agent");
		const worktreeDir = path.join(root, "managed-worktrees");
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({
					authorization: request.headers.get("authorization"),
					body: await request.json(),
				});
				const chunk = (delta: Record<string, string>, finishReason: string | null) =>
					JSON.stringify({
						id: "chatcmpl-worktree-e2e",
						object: "chat.completion.chunk",
						created: 0,
						model: "cwd-probe",
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					});
				return new Response(
					`data: ${chunk({ role: "assistant", content: "cwd-ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		await fs.mkdir(repo);
		await fs.mkdir(outsideRepo);
		await fs.mkdir(agentDir);
		await runGit(repo, ["init", "-q", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "cli-worktree-e2e@example.invalid"]);
		await runGit(repo, ["config", "user.name", "CLI Worktree E2E"]);
		await Bun.write(path.join(repo, "tracked.txt"), "baseline\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-q", "-m", "baseline"]);
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					"worktree-e2e": {
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						apiKey: "local-e2e-key",
						api: "openai-completions",
						models: [
							{
								id: "cwd-probe",
								name: "CWD Probe",
								reasoning: false,
								input: ["text"],
								supportsTools: false,
								contextWindow: 8192,
								maxTokens: 256,
							},
						],
					},
				},
			}),
		);

		const env = createCliEnv(root, agentDir, worktreeDir);
		const commonArgs = [
			"--provider",
			"worktree-e2e",
			"--model",
			"cwd-probe",
			"--print",
			"--no-session",
			"--no-tools",
			"--no-lsp",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--no-prewalk",
			"Report that the cwd probe completed.",
		];

		const normal = await runCli(repo, env, commonArgs);
		expect(normal.exitCode, normal.stderr).toBe(0);
		expect(normal.stdout).toContain("cwd-ok");
		expect(requests).toHaveLength(1);
		expectRequestCwd(requests[0], repo);
		await expectNoManagedArtifacts(repo, worktreeDir);

		requests.length = 0;
		const outsideNormal = await runCli(outsideRepo, env, commonArgs);
		expect(outsideNormal.exitCode, outsideNormal.stderr).toBe(0);
		expect(outsideNormal.stdout).toContain("cwd-ok");
		expect(requests).toHaveLength(1);
		expectRequestCwd(requests[0], outsideRepo);
		expect(await fs.stat(path.join(outsideRepo, ".git")).catch(() => null)).toBeNull();
		await expectNoManagedArtifacts(repo, worktreeDir);

		requests.length = 0;
		const outsideIsolated = await runCli(outsideRepo, env, ["-w", "outside-git", ...commonArgs]);
		expect(outsideIsolated.exitCode).toBe(1);
		expect(outsideIsolated.stdout).toBe("");
		expect(outsideIsolated.stderr).toBe("Error: --worktree must be run inside a git repository.\n");
		expect(requests).toHaveLength(0);
		expect(await fs.stat(path.join(outsideRepo, ".git")).catch(() => null)).toBeNull();
		await expectNoManagedArtifacts(repo, worktreeDir);

		requests.length = 0;
		const isolated = await runCli(repo, env, ["-w", "cli-e2e", ...commonArgs]);
		expect(isolated.exitCode, isolated.stderr).toBe(0);
		expect(isolated.stdout).toContain("cwd-ok");
		expect(requests).toHaveLength(1);

		const entries = parseWorktrees(await runGit(repo, ["worktree", "list", "--porcelain"]));
		const managed = entries.find(entry => entry.branch === WORKTREE_BRANCH);
		expect(managed).toBeDefined();
		if (!managed) throw new Error("Named CLI worktree was not registered");
		expect(path.dirname(managed.path)).toBe(worktreeDir);
		expect(managed.path).not.toBe(repo);
		expect(managed.locked).toBe(false);
		expectRequestCwd(requests[0], managed.path);
		expect(await Bun.file(path.join(managed.path, "tracked.txt")).text()).toBe("baseline\n");
		expect(await runGit(managed.path, ["branch", "--show-current"])).toBe("worktree-cli-e2e");
		expect(await runGit(repo, ["branch", "--show-current"])).toBe("main");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("baseline\n");

		// Persisted launch: the session header must carry the verified isolation
		// binding — this is the contract that keeps resume/fork validation and
		// the primary-checkout write guard alive.
		requests.length = 0;
		const persistedArgs = commonArgs.filter(arg => arg !== "--no-session");
		const persisted = await runCli(repo, env, ["-w", "cli-e2e", ...persistedArgs]);
		expect(persisted.exitCode, persisted.stderr).toBe(0);
		const sessionFiles: string[] = [];
		// Session storage may resolve under the agent dir or the XDG data dir
		// depending on the dirs policy; both live under the fixture root.
		for await (const file of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
			sessionFiles.push(file);
		}
		// The header is not necessarily line 1 (a title slot may precede it), so
		// scan every line of every session file for the `session` entry.
		const headers = (
			await Promise.all(
				sessionFiles.map(async file =>
					(await Bun.file(file).text()).split("\n").map(line => {
						try {
							return JSON.parse(line) as {
								type?: string;
								cwd?: string;
								worktreeIsolation?: { worktreeRoot: string; primaryRoot: string; branch: string };
							};
						} catch {
							return null;
						}
					}),
				),
			)
		).flat();
		const bound = headers.find(header => header?.type === "session" && header.worktreeIsolation);
		expect(bound?.worktreeIsolation).toBeDefined();
		if (!bound?.worktreeIsolation) throw new Error("No session header carried a worktree isolation binding");
		expect(normalizePathForComparison(bound.worktreeIsolation.worktreeRoot)).toBe(
			normalizePathForComparison(managed.path),
		);
		expect(normalizePathForComparison(bound.worktreeIsolation.primaryRoot)).toBe(normalizePathForComparison(repo));
		expect(bound.worktreeIsolation.branch).toBe("worktree-cli-e2e");
		expect(normalizePathForComparison(bound.cwd ?? "")).toBe(normalizePathForComparison(managed.path));
	} finally {
		try {
			if (server) await server.stop(true);
		} finally {
			await fs.rm(createdRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
}, 90_000);
