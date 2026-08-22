import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import type { WorktreeIsolation } from "../session/worktree-isolation";
import * as git from "../utils/git";

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
const COPY_BUFFER_BYTES = 64 * 1024;

export interface WorktreeIncludeResult {
	readonly copiedPaths: readonly string[];
	readonly skippedSymlinks: readonly string[];
}

export class WorktreeIncludeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorktreeIncludeError";
	}
}

/**
 * Lexically verify that candidate is within root without calling realpathSync.
 * Used during the copy walk where canonical roots + per-component lstat walk
 * already prove no symlink escapes, avoiding expensive synchronous realpath calls in the copy loop.
 */
function lexicalPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatRequired(target: string, label: string): Promise<fsSync.Stats> {
	try {
		return await fs.lstat(target);
	} catch (error) {
		throw new WorktreeIncludeError(`${label} is no longer available: ${target}`, { cause: error });
	}
}

async function ensureDestinationDirectory(
	sourceRoot: string,
	destinationRoot: string,
	relativeDirectory: string,
	createdDirectories: string[],
	verifiedSourceDirs: Map<string, number>,
	verifiedDestinationDirs: Set<string>,
): Promise<void> {
	if (!relativeDirectory || relativeDirectory === ".") return;

	let currentRel = "";
	for (const component of relativeDirectory.split(path.sep)) {
		currentRel = currentRel ? path.join(currentRel, component) : component;
		const source = path.join(sourceRoot, currentRel);
		const destination = path.join(destinationRoot, currentRel);

		let sourceMode = verifiedSourceDirs.get(currentRel);
		if (sourceMode === undefined) {
			const sourceStat = await lstatRequired(source, `Source directory for ${relativeDirectory}`);
			if (sourceStat.isSymbolicLink()) {
				throw new WorktreeIncludeError(`Refusing symlink selected by .worktreeinclude: ${relativeDirectory}`);
			}
			if (!sourceStat.isDirectory()) {
				throw new WorktreeIncludeError(
					`Refusing unsafe source directory selected by .worktreeinclude: ${relativeDirectory}`,
				);
			}
			sourceMode = sourceStat.mode;
			verifiedSourceDirs.set(currentRel, sourceMode);
		}

		if (verifiedDestinationDirs.has(currentRel)) continue;

		try {
			const destinationStat = await fs.lstat(destination);
			if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
				throw new WorktreeIncludeError(
					`Refusing unsafe destination path while copying .worktreeinclude: ${relativeDirectory}`,
				);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
			try {
				await fs.mkdir(destination, { mode: sourceMode & 0o777 });
				createdDirectories.push(destination);
				await fs.chmod(destination, sourceMode & 0o777);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				const destinationStat = await fs.lstat(destination);
				if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
					throw new WorktreeIncludeError(
						`Refusing unsafe destination path while copying .worktreeinclude: ${relativeDirectory}`,
						{ cause: mkdirError },
					);
				}
			}
		}

		verifiedDestinationDirs.add(currentRel);
	}
}

async function copyRegularFile(
	sourcePath: string,
	destinationPath: string,
	relativePath: string,
	buffer: Uint8Array,
	createdFiles: string[],
	signal?: AbortSignal,
): Promise<void> {
	let source: fs.FileHandle | undefined;
	let destination: fs.FileHandle | undefined;
	try {
		source = await fs.open(sourcePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
		const sourceStat = await source.stat();
		if (!sourceStat.isFile()) {
			throw new WorktreeIncludeError(`Only regular files may be copied from .worktreeinclude: ${relativePath}`);
		}

		try {
			destination = await fs.open(
				destinationPath,
				fsSync.constants.O_WRONLY |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_EXCL |
					fsSync.constants.O_NOFOLLOW,
				sourceStat.mode & 0o777,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new WorktreeIncludeError(`Refusing to overwrite an existing worktree path: ${relativePath}`, {
					cause: error,
				});
			}
			throw error;
		}
		createdFiles.push(destinationPath);

		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			let written = 0;
			while (written < bytesRead) {
				const result = await destination.write(buffer, written, bytesRead - written, null);
				written += result.bytesWritten;
			}
		}
		await destination.chmod(sourceStat.mode & 0o777);
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof WorktreeIncludeError) throw error;
		throw new WorktreeIncludeError(`Failed to copy .worktreeinclude path ${relativePath}`, { cause: error });
	} finally {
		await Promise.allSettled(
			[source?.close(), destination?.close()].filter((value): value is Promise<void> => value !== undefined),
		);
	}
}

async function rollbackCopies(
	createdFiles: readonly string[],
	createdDirectories: readonly string[],
): Promise<unknown[]> {
	const failures: unknown[] = [];
	for (const file of [...createdFiles].reverse()) {
		try {
			await fs.rm(file, { force: true });
		} catch (error) {
			failures.push(error);
		}
	}
	for (const directory of [...createdDirectories].reverse()) {
		try {
			await fs.rmdir(directory);
		} catch (error) {
			if (!isEnoent(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") failures.push(error);
		}
	}
	return failures;
}

/**
 * Copy ignored, untracked paths selected by the primary checkout's `.worktreeinclude`.
 * Git performs both ignore-rule evaluations; this function only intersects their results
 * and performs a no-follow, no-overwrite copy into the isolated worktree.
 * Empty ignored directories are not reproduced because git ls-files does not emit directory entries.
 */
export async function copyWorktreeIncludes(
	isolation: WorktreeIsolation,
	signal?: AbortSignal,
): Promise<WorktreeIncludeResult> {
	signal?.throwIfAborted();
	const sourceRoot = await fs.realpath(isolation.primaryRoot);
	const destinationRoot = await fs.realpath(isolation.worktreeRoot);
	if (pathIsWithin(sourceRoot, destinationRoot) || pathIsWithin(destinationRoot, sourceRoot)) {
		throw new WorktreeIncludeError("Primary checkout and isolated worktree roots must not contain one another");
	}
	const includePath = path.join(sourceRoot, WORKTREE_INCLUDE_FILE);

	let includeStat: fsSync.Stats;
	try {
		includeStat = await fs.lstat(includePath);
	} catch (error) {
		if (isEnoent(error)) return { copiedPaths: [], skippedSymlinks: [] };
		throw new WorktreeIncludeError(`Unable to inspect ${WORKTREE_INCLUDE_FILE}`, { cause: error });
	}
	if (includeStat.isSymbolicLink() || !includeStat.isFile()) {
		throw new WorktreeIncludeError(`${WORKTREE_INCLUDE_FILE} must be a regular file in the primary checkout`);
	}

	const [currentlyIgnored, selected] = await Promise.all([
		git.ls.ignored(sourceRoot, { excludeStandard: true, signal }),
		git.ls.ignored(sourceRoot, { excludeFile: includePath, signal }),
	]);
	const selectedSet = new Set(selected);
	const candidates = currentlyIgnored.filter(relativePath => selectedSet.has(relativePath)).sort();
	const createdFiles: string[] = [];
	const createdDirectories: string[] = [];
	const copiedPaths: string[] = [];
	const skippedSymlinks: string[] = [];
	const buffer = new Uint8Array(COPY_BUFFER_BYTES);

	const verifiedSourceDirs = new Map<string, number>();
	const verifiedDestinationDirs = new Set<string>();

	try {
		for (const relativePath of candidates) {
			signal?.throwIfAborted();
			const sourcePath = path.resolve(sourceRoot, relativePath);
			const destinationPath = path.resolve(destinationRoot, relativePath);
			if (!lexicalPathWithin(sourceRoot, sourcePath) || sourcePath === sourceRoot) {
				throw new WorktreeIncludeError(
					`Refusing .worktreeinclude path outside the source checkout: ${relativePath}`,
				);
			}
			if (!lexicalPathWithin(destinationRoot, destinationPath) || destinationPath === destinationRoot) {
				throw new WorktreeIncludeError(`Refusing .worktreeinclude containment escape: ${relativePath}`);
			}

			const relative = path.relative(sourceRoot, sourcePath);
			const components = relative.split(path.sep);
			const dirComponents = components.slice(0, -1);

			// Verify intermediate directories on source
			let currentRel = "";
			for (const component of dirComponents) {
				currentRel = currentRel ? path.join(currentRel, component) : component;
				if (!verifiedSourceDirs.has(currentRel)) {
					const currentPath = path.join(sourceRoot, currentRel);
					const stat = await lstatRequired(currentPath, `Included path ${relativePath}`);
					if (stat.isSymbolicLink()) {
						throw new WorktreeIncludeError(`Refusing symlink selected by .worktreeinclude: ${relativePath}`);
					}
					if (!stat.isDirectory()) {
						throw new WorktreeIncludeError(`Included path traverses a non-directory: ${relativePath}`);
					}
					verifiedSourceDirs.set(currentRel, stat.mode);
				}
			}

			// Check the final file component on source
			const sourceStat = await lstatRequired(sourcePath, `Included path ${relativePath}`);
			if (sourceStat.isSymbolicLink()) {
				skippedSymlinks.push(relativePath);
				continue;
			}
			if (!sourceStat.isFile()) {
				throw new WorktreeIncludeError(`Only regular files may be copied from .worktreeinclude: ${relativePath}`);
			}

			const relativeDir = path.dirname(relative);
			await ensureDestinationDirectory(
				sourceRoot,
				destinationRoot,
				relativeDir === "." ? "" : relativeDir,
				createdDirectories,
				verifiedSourceDirs,
				verifiedDestinationDirs,
			);
			await copyRegularFile(sourcePath, destinationPath, relativePath, buffer, createdFiles, signal);
			copiedPaths.push(relativePath);
		}
	} catch (error) {
		const rollbackFailures = await rollbackCopies(createdFiles, createdDirectories);
		if (rollbackFailures.length > 0) {
			throw new AggregateError(
				[error, ...rollbackFailures],
				"Failed to copy .worktreeinclude paths and could not completely roll back partial copies",
			);
		}
		throw error;
	}

	return { copiedPaths, skippedSymlinks };
}
