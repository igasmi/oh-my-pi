/**
 * List and clean up agent-managed git worktrees under `~/.omp/wt`.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { worktreeHelp as commandHelp } from "../cli/command-help";
import { clearWorktrees, listWorktrees, removeWorktree } from "../cli/worktree-cli";
import { Settings } from "../config/settings";

export default class Worktree extends Command {
	static description = commandHelp.description;
	static aliases = ["wt"];

	static args = {
		// `list` (default) inspects the worktree dir; `clear` removes entries;
		// `remove` resolves and removes one registered target.
		action: Args.string({
			description: "list (default), clear, or remove",
			required: false,
			options: ["list", "clear", "remove"],
			default: "list",
		}),
		target: Args.string({
			description: "Worktree name or exact registered path (remove)",
			required: false,
		}),
	};

	static flags = {
		force: Flags.boolean({
			char: "f",
			description: "Remove the resolved target despite locks, changes, or unique commits (remove)",
			default: false,
		}),
		all: Flags.boolean({
			description:
				"Clear every entry except live-locked or owner-held sessions, including live PR checkouts (clear)",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would be removed without touching the filesystem (clear/remove)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"omp worktree",
		"omp worktree list --json",
		"omp worktree remove feature/auth",
		"omp worktree remove /absolute/path --dry-run",
		"omp worktree remove feature/auth --force --json",
		"omp worktree clear",
		"omp worktree clear --dry-run",
		"omp worktree clear --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Worktree);
		// Load settings so the `worktree.base` override is applied before we scan
		// — otherwise this command would inspect ~/.omp/wt while the agent created
		// its worktrees under the configured base.
		await Settings.init({ cwd: getProjectDir() });
		if (args.action === "clear") {
			await clearWorktrees({
				all: flags.all ?? false,
				dryRun: flags["dry-run"] ?? false,
				json: flags.json ?? false,
			});
			return;
		}
		if (args.action === "remove") {
			const result = await removeWorktree({
				cwd: process.cwd(),
				dryRun: flags["dry-run"] ?? false,
				force: flags.force ?? false,
				json: flags.json ?? false,
				target: args.target ?? "",
			});
			if (result.status === "not-found" || result.status === "refused") {
				process.exitCode = 1;
			}
			return;
		}
		await listWorktrees({ json: flags.json ?? false });
	}
}
