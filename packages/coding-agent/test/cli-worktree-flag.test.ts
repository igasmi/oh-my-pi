import { describe, expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("--worktree launch flag", () => {
	test("leaves worktree unset when the flag is omitted without disturbing normal launch arguments", () => {
		const parsed = parseArgs(["--print", "--model", "opus", "implement auth"]);

		expect(parsed.worktree).toBeUndefined();
		expect(parsed.print).toBe(true);
		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["implement auth"]);
	});

	test("parses long and short names without leaking them into the prompt", () => {
		const long = parseArgs(["--worktree", "feature/auth", "implement auth"]);
		const short = parseArgs(["-w", "bugfix", "fix it"]);

		expect(long.worktree).toBe("feature/auth");
		expect(long.messages).toEqual(["implement auth"]);
		expect(short.worktree).toBe("bugfix");
		expect(short.messages).toEqual(["fix it"]);
	});

	test("supports equals syntax", () => {
		const parsed = parseArgs(["--worktree=feature-auth", "implement auth"]);

		expect(parsed.worktree).toBe("feature-auth");
		expect(parsed.messages).toEqual(["implement auth"]);
	});

	test("bare forms request a generated name when followed by another flag or end of argv", () => {
		const long = parseArgs(["--worktree", "--print", "prompt"]);
		const short = parseArgs(["-w"]);

		expect(long.worktree).toBe(true);
		expect(long.print).toBe(true);
		expect(long.messages).toEqual(["prompt"]);
		expect(short.worktree).toBe(true);
	});

	test("rejects explicitly empty names while preserving the genuinely bare form", () => {
		expect(() => parseArgs(["--worktree="])).toThrow('Invalid worktree name ""');
		expect(() => parseArgs(["-w", ""])).toThrow('Invalid worktree name ""');
		expect(parseArgs(["-w"]).worktree).toBe(true);
	});

	test("POSIX separator lets a bare worktree flag precede a flag-shaped prompt", () => {
		const parsed = parseArgs(["-w", "--", "--fix-the-bug"]);

		expect(parsed.worktree).toBe(true);
		expect(parsed.messages).toEqual(["--fix-the-bug"]);
	});
});

describe("--worktree global routing", () => {
	test("hoists a launch-shaped subcommand after a named worktree flag", () => {
		expect(resolveCliArgv(["--worktree", "feature-auth", "acp"])).toEqual({
			argv: ["acp", "--worktree", "feature-auth"],
		});
	});

	test("strips worktree flags before an unrelated maintenance subcommand", () => {
		expect(resolveCliArgv(["-w", "feature-auth", "update"])).toEqual({ argv: ["update"] });
	});

	test("does not misroute a following value-taking flag as the optional worktree name", () => {
		expect(resolveCliArgv(["-w", "--model", "update", "prompt"])).toEqual({
			argv: ["launch", "-w", "--model", "update", "prompt"],
		});
	});
});
