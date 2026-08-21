import * as path from "node:path";
import * as git from "../utils/git";

const SHORTHAND_PATTERN = /^#([1-9]\d*)$/;
const GITHUB_URL_PATH_PATTERN = /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/;
const GITLAB_URL_PATH_PATTERN = /^\/(?:[^/]+\/)+-\/merge_requests\/([1-9]\d*)\/?$/;
const GITHUB_HOST = "github.com";
const GITLAB_HOST = "gitlab.com";

export type PullRequestSelectorKind = "shorthand" | "github-url" | "gitlab-url";

export interface PullRequestSelector {
	readonly kind: PullRequestSelectorKind;
	readonly number: number;
	readonly raw: string;
}

export interface PullRequestFetchResult {
	readonly commit: string;
	readonly name: string;
	readonly ref: string;
}

export class PullRequestSelectorError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PullRequestSelectorError";
	}
}

function parseNumber(rawNumber: string, rawSelector: string): number {
	const number = Number(rawNumber);
	if (!Number.isSafeInteger(number) || number <= 0) {
		throw new PullRequestSelectorError(
			`Invalid pull request selector ${JSON.stringify(rawSelector)}: the request number must be a positive safe integer`,
		);
	}
	return number;
}

/**
 * Parse the only supported pull-request selector forms. Plain decimal values
 * deliberately return null so they remain ordinary worktree names.
 */
export function parsePullRequestSelector(input: string): PullRequestSelector | null {
	const shorthand = SHORTHAND_PATTERN.exec(input);
	if (shorthand) {
		return { kind: "shorthand", number: parseNumber(shorthand[1], input), raw: input };
	}
	if (input.startsWith("#")) {
		throw new PullRequestSelectorError(
			`Invalid pull request selector ${JSON.stringify(input)}: expected #N with a positive integer`,
		);
	}

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
		throw new PullRequestSelectorError(
			`Unsupported pull request selector URL ${JSON.stringify(input)}: expected an HTTP(S) GitHub pull or GitLab merge-request URL`,
		);
	}

	const github = GITHUB_URL_PATH_PATTERN.exec(url.pathname);
	if (github) {
		return { kind: "github-url", number: parseNumber(github[1], input), raw: input };
	}
	const gitlab = GITLAB_URL_PATH_PATTERN.exec(url.pathname);
	if (gitlab) {
		return { kind: "gitlab-url", number: parseNumber(gitlab[1], input), raw: input };
	}

	throw new PullRequestSelectorError(
		`Unsupported pull request selector URL ${JSON.stringify(input)}: expected /owner/repo/pull/N or /owner/repo/-/merge_requests/N`,
	);
}

function parseOriginHost(remoteUrl: string): string | null {
	try {
		const parsed = new URL(remoteUrl);
		const host = parsed.hostname.toLowerCase();
		if (host) return host;
	} catch {
		// Git also accepts SCP-style remotes such as git@github.com:owner/repo.git.
	}

	if (path.isAbsolute(remoteUrl) || path.win32.isAbsolute(remoteUrl) || remoteUrl.startsWith(".")) return null;
	const scpLike = /^(?:[^@/:]+@)?([^/:]+):.+$/.exec(remoteUrl);
	return scpLike?.[1]?.toLowerCase() ?? null;
}

function sourceRefsForHost(host: string | null, requestNumber: number): string[] {
	if (host === GITHUB_HOST) {
		return [`refs/pull/${requestNumber}/head`];
	}
	if (host === GITLAB_HOST) {
		return [`refs/merge-requests/${requestNumber}/head`];
	}
	return [`refs/pull/${requestNumber}/head`, `refs/merge-requests/${requestNumber}/head`];
}

/**
 * Fetch a selector from origin into a fixed, validated local namespace.
 * The origin host—not the selector URL—chooses GitHub vs GitLab routing.
 */
export async function fetchPullRequest(
	repoRoot: string,
	selector: PullRequestSelector,
	signal?: AbortSignal,
): Promise<PullRequestFetchResult> {
	signal?.throwIfAborted();
	if (!Number.isSafeInteger(selector.number) || selector.number <= 0) {
		throw new PullRequestSelectorError(
			`Invalid pull request selector ${JSON.stringify(selector.raw)}: the request number must be a positive safe integer`,
		);
	}
	const originUrl = await git.config.get(repoRoot, "remote.origin.url", signal);
	if (!originUrl) {
		throw new PullRequestSelectorError(
			`Cannot fetch pull request ${selector.raw}: this repository has no origin remote`,
		);
	}

	const host = parseOriginHost(originUrl);
	const sourceRefs = sourceRefsForHost(host, selector.number);
	const name = `pr-${selector.number}`;
	const targetRef = `refs/omp/worktrees/${name}`;

	return await git.withRepoLock(
		repoRoot,
		async () => {
			const failures: unknown[] = [];
			for (const sourceRef of sourceRefs) {
				try {
					await git.fetch(repoRoot, "origin", sourceRef, targetRef, { signal });
					const commit = await git.ref.resolve(repoRoot, targetRef, signal);
					if (!commit) {
						throw new PullRequestSelectorError(
							`Origin fetched ${sourceRef}, but the local pull-request ref ${targetRef} could not be resolved`,
						);
					}
					return { commit, name, ref: targetRef };
				} catch (error) {
					failures.push(error);
					signal?.throwIfAborted();
				}
			}

			const hostLabel = host ?? "an unrecognized/local host";
			const attempted = sourceRefs.join(" then ");
			throw new PullRequestSelectorError(
				`Unable to fetch pull request #${selector.number} from origin (${hostLabel}); attempted ${attempted}. Verify that the request exists and that origin is reachable.`,
				{ cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
			);
		},
		signal,
	);
}
