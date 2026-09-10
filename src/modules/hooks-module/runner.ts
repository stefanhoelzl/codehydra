/**
 * Finds and runs a repository's hook scripts.
 *
 * A hook is one file — `.codehydra/hooks/<name>` in the acted-on worktree —
 * exactly as git does it: if the file is there it runs, otherwise nothing
 * happens. No subdirectories, no ordering, no naming conventions to learn
 * beyond the `on-` prefix that marks an entry nothing waits for. The extension is free (the shebang decides what
 * interprets it, so a `.py` hook is as ordinary as a `.sh` one), and discovery
 * is a bare `stat` at the moment the hook point runs, so editing a hook takes
 * effect on the next workspace without a cache or a watcher in the way.
 *
 * The file is handed to `ProcessRunner` with `shell: true` — `sh -c <path>` on
 * POSIX, `cmd /d /s /c <path>` on Windows — the same spawn shape
 * `auto-workspace`'s cmd-runner uses. POSIX still honours the shebang and the
 * exec bit through it, so a file that lost its exec bit fails loudly (126)
 * rather than being skipped in the silence git chose.
 *
 * The exchange is JSON on stdin, JSON (or nothing) on stdout. stderr is never
 * parsed: it is human output, and it goes to the log and to the workspace's
 * output channel so a script can be as chatty as its author likes without
 * corrupting the contract.
 *
 * No timeout. A hook runs until it finishes; the escape from one that wedges a
 * deletion is the progress panel's Dismiss, which force-deletes and skips hooks
 * entirely.
 */

import type { z } from "zod/v4";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import { Path } from "../../utils/path/path";
import { FileSystemError } from "../../shared/errors/service-errors";
import { getErrorMessage } from "../../shared/error-utils";
import { HOOKS_DIR, HOOKS_ROOT } from "./hook-map";

// =============================================================================
// Types
// =============================================================================

/** Where a hook's human output should be shown, beyond the log. */
export interface HookOutputSink {
  /** One line of a hook's stderr, tagged with the entry that produced it. */
  write(workspacePath: string, entry: string, line: string): void;
}

export interface HookRunnerDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
  /** Prepended to the hook's PATH so `ch` is callable from a script. */
  readonly binDir: Path;
  readonly sink: HookOutputSink;
}

/** A hook file that exists and is about to run. */
export interface FoundHook {
  readonly entry: string;
  readonly path: Path;
}

/**
 * Raised when a hook could not be run, or ran and failed.
 *
 * Distinct from a hook that *returned* a refusal: for a gate, this is the
 * "could not tell" half of the contract, and the caller fails it closed.
 */
export class HookFailedError extends Error {
  constructor(
    readonly entry: string,
    message: string
  ) {
    super(message);
    this.name = "HookFailedError";
  }
}

// =============================================================================
// Discovery
// =============================================================================

/** The directory a repository's hooks live in. */
export function hookDir(worktree: Path): Path {
  return new Path(worktree, HOOKS_ROOT, HOOKS_DIR);
}

/**
 * Does this filename name the given entry?
 *
 * The bare name, or the name plus any extension. The extension never decides
 * whether something is a hook — a shebang does that — but it has to be *allowed*
 * for two reasons: `after-worktree-created.py` is how most people would write
 * one, and on Windows an extensionless file cannot be run by `cmd` at all, so a
 * repository supporting Windows has no choice but to ship
 * `after-worktree-created.cmd`.
 */
export function namesEntry(filename: string, entry: string): boolean {
  return filename === entry || filename.startsWith(`${entry}.`);
}

/**
 * The hook file for this entry, or undefined when the repository defines none.
 *
 * A missing or unreadable directory answers "no hook" rather than throwing: a
 * repository that has never heard of CodeHydra is the overwhelmingly common
 * case, and it must cost nothing and say nothing.
 *
 * Listing the directory rather than probing the one path is what makes the
 * entry's kind visible — a directory sitting where a hook file should be is a
 * mistake worth naming, since it is what someone reaching for the git model's
 * multi-script cousin would try first.
 */
export async function findHook(
  deps: Pick<HookRunnerDeps, "fileSystem" | "logger">,
  worktree: Path,
  entry: string
): Promise<FoundHook | undefined> {
  const dir = hookDir(worktree);

  let entries;
  try {
    entries = await deps.fileSystem.readdir(dir);
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
      return undefined;
    }
    deps.logger.warn("Could not read the hooks directory", {
      path: dir.toNative(),
      error: getErrorMessage(error),
    });
    return undefined;
  }

  const matches = entries
    .filter((candidate) => namesEntry(candidate.name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) return undefined;

  // Two files claiming one entry is a repository mistake — most likely a rename
  // that left the old one behind. Pick lexically so the choice is at least the
  // same on every machine, and say which one was taken.
  if (matches.length > 1) {
    deps.logger.warn("Several files claim the same hook; using the first", {
      entry,
      candidates: matches.map((candidate) => candidate.name).join(", "),
    });
  }

  const match = matches[0]!;
  if (!match.isFile) {
    deps.logger.warn("Hook entry is not a file, ignoring", {
      path: new Path(dir, match.name).toNative(),
    });
    return undefined;
  }

  return { entry, path: new Path(dir, match.name) };
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Run a hook and return whatever it printed, validated against `output`.
 *
 * Throws `HookFailedError` when the process could not be started, exited
 * non-zero, or printed something that is not the declared output shape. The
 * caller decides what that means: fatal for a gate, merely loud for setup.
 */
export async function runHook<S extends z.ZodType>(
  deps: HookRunnerDeps,
  found: FoundHook,
  worktree: Path,
  input: unknown,
  output: S
): Promise<z.infer<S>> {
  const commandLine = quoteForShell(found.path.toNative());

  deps.logger.debug("Running hook", { entry: found.entry, path: found.path.toNative() });

  const proc = deps.processRunner.run(commandLine, [], {
    shell: true,
    // The worktree the hook is about. Safe even for the deletion gate: that
    // stage runs before "release", so the CWD scan and kill still cleans up
    // after anything the hook leaves holding the directory.
    cwd: worktree.toNative(),
    env: hookEnv(deps.binDir),
    input: JSON.stringify(input),
  });

  const result = await proc.wait();

  reportStderr(deps, worktree, found.entry, result.stderr);

  if (result.exitCode !== 0) {
    throw new HookFailedError(
      found.entry,
      describeExit(found.entry, result.exitCode, result.stderr)
    );
  }

  return parseOutput(found.entry, result.stdout, output);
}

/**
 * Run a hook for its side effects only, swallowing every failure into the log.
 *
 * The fire-and-forget half: nothing is waiting on this, so nothing it does can
 * fail anything. Callers do not await it.
 */
export async function runEventHook(
  deps: HookRunnerDeps,
  found: FoundHook,
  worktree: Path,
  input: unknown
): Promise<void> {
  try {
    const commandLine = quoteForShell(found.path.toNative());
    const proc = deps.processRunner.run(commandLine, [], {
      shell: true,
      cwd: worktree.toNative(),
      env: hookEnv(deps.binDir),
      input: JSON.stringify(input),
    });
    const result = await proc.wait();
    reportStderr(deps, worktree, found.entry, result.stderr);
    if (result.exitCode !== 0) {
      // A log line and no more. Nothing is waiting on this, and a notification
      // for every failed turn of a chatty event would be its own problem.
      deps.logger.warn("Event hook failed", {
        entry: found.entry,
        exitCode: result.exitCode ?? "none",
      });
    }
  } catch (error) {
    deps.logger.warn("Event hook could not be run", {
      entry: found.entry,
      error: getErrorMessage(error),
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Quote a path for the platform shell.
 *
 * The path comes from us, not from the repository — it is the worktree plus a
 * fixed name — but worktree paths contain spaces routinely, and on Windows they
 * contain `&` and `^` often enough. POSIX single quotes are absolute (only `'`
 * needs escaping); cmd.exe has no escape *inside* double quotes, so a path
 * containing one cannot be expressed and is refused rather than mis-run.
 */
export function quoteForShell(nativePath: string): string {
  if (process.platform === "win32") {
    if (nativePath.includes('"')) {
      throw new Error(`Cannot run a hook whose path contains a double quote: ${nativePath}`);
    }
    return `"${nativePath}"`;
  }
  return `'${nativePath.replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment a hook runs in: ours, plus `ch` on PATH.
 *
 * Inheriting is deliberate — a setup script wants the user's toolchain, their
 * proxy settings, their credential helpers. The one addition is the bin
 * directory, so `ch ws set-title` and friends work from a hook without the
 * author having to find them.
 */
function hookEnv(binDir: Path): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const current = process.env[pathKey];
  const native = binDir.toNative();
  return {
    ...process.env,
    [pathKey]: current ? `${native}${nodePathDelimiter()}${current}` : native,
  };
}

function nodePathDelimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

/** Send a hook's human output to the log and the workspace's output channel. */
function reportStderr(deps: HookRunnerDeps, worktree: Path, entry: string, stderr: string): void {
  if (stderr.trim() === "") return;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    deps.logger.info("hook", { entry, line });
    deps.sink.write(worktree.toString(), entry, line);
  }
}

/** A failure message worth reading, from the little a failed process gives us. */
function describeExit(entry: string, exitCode: number | null, stderr: string): string {
  const tail = lastMeaningfulLine(stderr);
  // 126 is the shell's "found it, could not execute it" — almost always a file
  // that lost its exec bit, which is worth naming outright because the raw
  // message ("Permission denied") sends people looking at file ownership.
  const reason =
    exitCode === 126
      ? "the file is not executable (chmod +x it)"
      : exitCode === 127
        ? "the interpreter in its shebang was not found"
        : `exit ${exitCode ?? "none (killed)"}`;
  return tail ? `${entry} failed: ${reason} — ${tail}` : `${entry} failed: ${reason}`;
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1);
}

/**
 * Parse a hook's stdout.
 *
 * Nothing printed is the ordinary case — a setup script that only copies files
 * has nothing to say — and means an empty result. Anything else must be exactly
 * the declared shape: the schemas are strict, so a misspelled key is an error
 * rather than a value that silently never arrived.
 */
function parseOutput<S extends z.ZodType>(entry: string, stdout: string, output: S): z.infer<S> {
  const text = stdout.trim();
  if (text === "") {
    return output.parse({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HookFailedError(
      entry,
      `${entry} printed something that is not JSON. stdout is the result channel — ` +
        `write human output to stderr instead.`
    );
  }

  const validated = output.safeParse(parsed);
  if (!validated.success) {
    throw new HookFailedError(
      entry,
      `${entry} printed JSON that does not match its contract: ${describeIssues(validated.error)}`
    );
  }
  return validated.data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${at}${issue.message}`;
    })
    .join("; ");
}
