import * as fs from "node:fs";
import * as path from "node:path";
import { HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@oh-my-pi/hashline";
import {
	type LocalProtocolOptions,
	resolveLocalRoot,
	resolveLocalUrlToPath,
	resolveVaultUrlToPath,
} from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";
const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`);

/** Resolve the `local://` options the session uses, preferring its own
 *  {@link LocalProtocolOptions} (the mapping `read`/`write`/`eval` resolve
 *  through) over the bare `getArtifactsDir`/`getSessionId` pair. Subagents and
 *  multi-session hosts (cmux/ACP, embedded SDK) pin `local://` to a parent/foreign
 *  root via `localProtocolOptions`; the sandbox root the plan-mode guard derives
 *  must match where the artifact actually lives, or it rejects a legitimate plan
 *  edit (and tag-based path recovery onto the sandbox would miss it). */
function planLocalProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

/** Resolve the absolute path of the session's `local://` artifact sandbox.
 *  Returns `null` when the session has no artifact wiring (e.g. tests). */
function localSandboxRoot(session: ToolSession): string | null {
	try {
		return path.resolve(resolveLocalRoot(planLocalProtocolOptions(session)));
	} catch {
		return null;
	}
}

/** True when `absolutePath` resolves inside `root` (== root or under it). */
function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	const sep = `${root}${path.sep}`;
	return absolutePath.startsWith(sep);
}

/** Strip the hashline `[path#TAG]` wrapper from a write/edit target so the inner
 *  filesystem path drives both authorization and resolution. Only unwraps inputs
 *  that match the strict hashline header shape (`[path]` or `[path#XXXX]` with a
 *  4-hex tag); anything else returns the original string so the downstream
 *  resolver surfaces the real error. Exported for callers (e.g. `write`) that
 *  make scheme/bridge-routing decisions before {@link resolvePlanPath} runs. */
export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (
		trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
		trimmed[0] !== HL_FILE_PREFIX ||
		trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
	) {
		return targetPath;
	}
	const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length);
	const tagMatch = HL_TRAILING_TAG_RE.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	// A valid header is exactly `PATH` or `PATH#XXXX`; reject any other shape
	// (selectors, non-hex tags, embedded `#`) so we never silently rewrite a
	// path the model did not author.
	if (pathPart.length === 0 || pathPart.includes(HL_FILE_HASH_SEP)) return targetPath;
	return pathPart;
}

/** True when `targetPath` resolves into the session-local artifact sandbox.
 *  Routes through {@link resolvePlanPath} so the guard and the eventual write
 *  always agree on the absolute target (including bracketed hashline headers,
 *  `local://` URLs, and bare absolute paths). Files inside the sandbox are not
 *  part of the working tree, so plan mode treats them as freely writable
 *  scratch/plan space — and tag-based path recovery may rebind onto them. */
export function targetsLocalSandbox(session: ToolSession, targetPath: string): boolean {
	const root = localSandboxRoot(session);
	if (!root) return false;
	let resolved: string;
	try {
		resolved = resolvePlanPath(session, targetPath);
	} catch {
		return false;
	}
	if (!path.isAbsolute(resolved)) return false;
	const absolute = path.resolve(resolved);
	if (isWithinRoot(absolute, root)) return true;
	// Compare realpath-normalized forms so that `/tmp/…` vs `/private/tmp/…`
	// (macOS) and other symlink-collapsed roots both resolve to the same
	// sandbox identity.
	try {
		const realRoot = fs.realpathSync.native(root);
		if (isWithinRoot(absolute, realRoot)) return true;
		const realParent = fs.realpathSync.native(path.dirname(absolute));
		return isWithinRoot(path.join(realParent, path.basename(absolute)), realRoot);
	} catch {
		return false;
	}
}

/**
 * Resolve a write/edit target to its absolute filesystem path, honoring the
 * `local://` and `vault://` schemes. Plain paths resolve against the session cwd.
 * Bracketed hashline headers (`[path#TAG]`) are unwrapped first so the inner
 * filesystem path drives resolution — keeping the plan-mode guard and the
 * eventual write in lockstep.
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const unwrapped = unwrapHashlineHeaderPath(targetPath);
	const normalized = normalizeLocalScheme(unwrapped);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) {
		return resolveLocalUrlToPath(normalized, planLocalProtocolOptions(session));
	}

	if (normalized.startsWith(VAULT_SCHEME_PREFIX)) {
		return resolveVaultUrlToPath(normalized);
	}

	return resolveToCwd(normalized, session.cwd);
}

/** Canonicalize via the nearest existing ancestor so not-yet-created targets
 *  (`write` creating parents) still resolve symlinked prefixes. */
function canonicalizeExistingPrefix(absolute: string): string {
	let base = absolute;
	const suffix: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync.native(base);
			return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
		} catch {
			const parent = path.dirname(base);
			if (parent === base) return absolute;
			suffix.push(path.basename(base));
			base = parent;
		}
	}
}

/**
 * Worktree sessions refuse first-party writes into the primary checkout. This
 * is an accident guardrail, not a sandbox — process execution (`bash`, eval)
 * is deliberately out of scope; see session/worktree-isolation.ts.
 */
function enforceWorktreeBoundary(session: ToolSession, targetPath: string): void {
	const isolation = session.getWorktreeWriteGuard?.() ?? session.getWorktreeIsolation?.();
	if (!isolation) return;
	let resolved: string;
	try {
		resolved = resolvePlanPath(session, targetPath);
	} catch {
		return; // Unresolvable targets fail with the write's own error.
	}
	if (!path.isAbsolute(resolved)) return;
	// Binding roots are canonical by the validateWorktreeIsolation contract.
	const absolute = canonicalizeExistingPrefix(path.resolve(resolved));
	if (isWithinRoot(absolute, isolation.worktreeRoot)) return;
	if (isWithinRoot(absolute, isolation.primaryRoot)) {
		throw new ToolError(
			`Worktree isolation: refusing to modify the primary checkout (${targetPath}). This session works in ${isolation.worktreeRoot}; make the change there instead.`,
		);
	}
}

function enforcePlanMode(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (targetsLocalSandbox(session, targetPath)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}

/**
 * Shared write-policy gate for every first-party mutating tool path. Enforces
 * plan-mode read-only rules and, in worktree sessions, the primary-checkout
 * guardrail (including `move` destinations).
 */
export function enforceWriteGuards(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	enforcePlanMode(session, targetPath, options);
	enforceWorktreeBoundary(session, targetPath);
	if (options?.move) enforceWorktreeBoundary(session, options.move);
}
