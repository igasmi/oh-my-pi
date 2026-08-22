import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { StartupWorktree } from "@oh-my-pi/pi-coding-agent/cli/startup-worktree";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

function createTrackedWorktree(releaseGate: Promise<void> = Promise.resolve()): {
	worktree: StartupWorktree;
	state: { locked: boolean; registered: boolean; releaseCalls: number };
	releaseStarted: Promise<void>;
} {
	const state = { locked: true, registered: true, releaseCalls: 0 };
	const releaseStarted = Promise.withResolvers<void>();
	// Mirror the applyStartupWorktree contract: `path`, `isolation.worktreeRoot`,
	// and the session cwd are the same directory. The binding is live — session
	// creation rejects a cwd/worktreeRoot mismatch — so the fake must use a real
	// directory (the test process cwd) rather than a synthetic path.
	const worktreeRoot = process.cwd();
	return {
		worktree: {
			name: "lifecycle-test",
			branch: "lifecycle-test",
			path: worktreeRoot,
			isolation: {
				worktreeRoot,
				primaryRoot: "/synthetic/primary-checkout",
				name: "lifecycle-test",
				branch: "lifecycle-test",
				commonDir: "/synthetic/repository/.git",
			},
			reused: false,
			async release() {
				state.releaseCalls++;
				releaseStarted.resolve();
				await releaseGate;
				state.locked = false;
				state.registered = false;
			},
		},
		state,
		releaseStarted: releaseStarted.promise,
	};
}

function createParsedArgs(extraArgs: string[] = []) {
	// --no-session: these tests cover lock/release lifecycle only. A persisted
	// session would eagerly create a manager in the REAL default session dir
	// (binding present, no --session-dir) and leak a process-global artifacts
	// registration into later test files.
	const parsed = parseArgs(["-w", "lifecycle-test", "--print", "--no-session", ...extraArgs]);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	return parsed;
}

describe("runRootCommand startup worktree lifecycle", () => {
	it("releases the lock and registration when startup throws after acquisition", async () => {
		const { worktree, state } = createTrackedWorktree();
		const startupError = new Error("injected auth startup failure");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

		await expect(
			runRootCommand(createParsedArgs(), ["-w", "lifecycle-test", "--print"], {
				applyStartupWorktree: async () => worktree,
				discoverAuthStorage: async () => {
					throw startupError;
				},
				settings,
			}),
		).rejects.toBe(startupError);

		expect(state).toEqual({ locked: false, registered: false, releaseCalls: 1 });
	});

	it("awaits release before an early RPC file-argument validation exit", async () => {
		const releaseGate = Promise.withResolvers<void>();
		const { worktree, state, releaseStarted } = createTrackedWorktree(releaseGate.promise);
		const parsed = createParsedArgs(["--mode", "rpc", "@prompt.txt"]);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let authDiscoveryCalled = false;
		let observedStateAtExit: typeof state | undefined;

		const command = runRootCommand(parsed, ["-w", "lifecycle-test", "--print", "--mode", "rpc", "@prompt.txt"], {
			applyStartupWorktree: async () => worktree,
			discoverAuthStorage: async () => {
				authDiscoveryCalled = true;
				throw new Error("auth discovery must not run");
			},
			exitProcess: code => {
				observedStateAtExit = { ...state };
				throw new ProcessExitSignal(code);
			},
			settings,
		});
		await releaseStarted;
		expect(observedStateAtExit).toBeUndefined();
		releaseGate.resolve();
		await expect(command).rejects.toMatchObject({ name: "ProcessExitSignal", code: 1 });

		expect(authDiscoveryCalled).toBe(false);
		expect(observedStateAtExit).toEqual({ locked: false, registered: false, releaseCalls: 1 });
		expect(state).toEqual({ locked: false, registered: false, releaseCalls: 1 });
	});

	it("passes startup dependencies in order while preserving the model-resolution exit cleanup", async () => {
		const { worktree, state } = createTrackedWorktree();
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = createParsedArgs(["--model", "missing-provider/missing-model"]);
		let observedExitCode: number | undefined;

		try {
			await expect(
				runRootCommand(parsed, ["-w", "lifecycle-test", "--print", "--model", "missing-provider/missing-model"], {
					applyStartupWorktree: async () => worktree,
					discoverAuthStorage: async () => authStorage,
					exitProcess: code => {
						observedExitCode = code;
						throw new ProcessExitSignal(code);
					},
					settings,
				}),
			).rejects.toMatchObject({ name: "ProcessExitSignal", code: 1 });
		} finally {
			authStorage.close();
		}

		expect(observedExitCode).toBe(1);
		expect(state).toEqual({ locked: false, registered: false, releaseCalls: 1 });
	});
});
