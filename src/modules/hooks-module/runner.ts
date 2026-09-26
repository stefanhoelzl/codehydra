/**
 * Finds and runs a repository's hook scripts.
 *
 * A hook is one file — `.codehydra/hooks/<name>` in the acted-on worktree —
 * exactly as git does it: if the file is there it runs, otherwise nothing
 * happens. No subdirectories, no ordering, no naming conventions to learn
 * beyond the `on-` prefix that marks an entry nothing waits for, and the
 * `.win` / `.linux` / `.mac` suffix that pins a file to one platform. The
 * extension is free (the shebang decides what interprets it, so a `.py` hook
 * is as ordinary as a `.sh` one), and discovery is a directory listing at the
 * moment the hook point runs, so editing a hook takes effect on the next
 * workspace without a cache or a watcher in the way.
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
 * No timeout. A hook runs until it finishes or the user cancels it: a blocking
 * run takes an `AbortSignal`, and aborting it kills the hook's process tree and
 * fails the run like any other broken hook.
 */

import type { z } from "zod/v4";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import {
  PROCESS_KILL_FORCE_TIMEOUT_MS,
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  type ProcessResult,
  type ProcessRunner,
  type SpawnedProcess,
} from "../../boundaries/platform/process";
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
  /** The workspace is opening: its editor is on the way, so hold output for it. */
  opening(workspacePath: string): void;
  /**
   * The workspace's editor is gone and is not coming back (torn down for a
   * deletion, or the workspace is deleted): drop what is held for it, and hold
   * nothing more until it opens again. The log keeps every line regardless.
   */
  closed(workspacePath: string): void;
}

export interface HookRunnerDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
  /** Prepended to the hook's PATH so `ch` is callable from a script. */
  readonly binDir: Path;
  readonly sink: HookOutputSink;
  /** Decides which platform-suffixed files apply. Default: this process's. */
  readonly platform?: NodeJS.Platform;
}

/** The one hook file an entry resolved to on this platform. */
export interface RunnableHook {
  readonly kind: "file";
  readonly entry: string;
  readonly path: Path;
}

/**
 * Several files claim one entry on this platform, so none of them runs.
 *
 * Kept as a result rather than thrown at discovery: whether it matters is the
 * caller's to decide after the trust question — a project answered Never runs
 * nothing, so its stale backup file must not fail a deletion either.
 */
export interface AmbiguousHook {
  readonly kind: "ambiguous";
  readonly entry: string;
  readonly candidates: readonly Path[];
}

/** What a repository defines for an entry, when it defines anything. */
export type FoundHook = RunnableHook | AmbiguousHook;

/** Per-run controls for a blocking hook. */
export interface RunHookOptions {
  /** Aborting it cancels the hook: its process tree is killed and the run fails. */
  readonly signal?: AbortSignal;
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
 * `after-worktree-created.win.cmd`.
 */
export function namesEntry(filename: string, entry: string): boolean {
  return filename === entry || filename.startsWith(`${entry}.`);
}

/** The suffix that pins a hook file to the platform it runs on. */
const PLATFORM_SUFFIXES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  win32: "win",
  linux: "linux",
  darwin: "mac",
};

const ALL_PLATFORM_SUFFIXES: ReadonlySet<string> = new Set(Object.values(PLATFORM_SUFFIXES));

/**
 * The platform a filename pins its entry to, or undefined for one that runs
 * everywhere. Only the segment right after the entry name counts — the whole
 * segment, so `x.windows.cmd` is an ordinary unsuffixed file.
 */
function platformSuffixOf(filename: string, entry: string): string | undefined {
  if (filename === entry) return undefined;
  const segment = filename.slice(entry.length + 1).split(".")[0] ?? "";
  return ALL_PLATFORM_SUFFIXES.has(segment) ? segment : undefined;
}

/**
 * Which of these files would run for the entry on this platform, sorted.
 *
 * A file suffixed for this platform wins; without one, the unsuffixed files
 * apply, and files suffixed for other platforms never do. That lets one
 * repository ship `x` (a shebang script) beside `x.win.cmd`. More than one
 * result is the caller's error to report — there is no tiebreak, because every
 * tiebreak picks a stale backup over the real hook for somebody.
 */
export function selectHookFiles(
  filenames: readonly string[],
  entry: string,
  platform: NodeJS.Platform
): string[] {
  const named = filenames.filter((name) => namesEntry(name, entry)).sort();
  const own = PLATFORM_SUFFIXES[platform];
  const specific =
    own === undefined ? [] : named.filter((name) => platformSuffixOf(name, entry) === own);
  if (specific.length > 0) return specific;
  return named.filter((name) => platformSuffixOf(name, entry) === undefined);
}

/**
 * The hook file for this entry, or undefined when the repository defines none.
 *
 * A missing or unreadable directory answers "no hook" rather than throwing: a
 * repository that has never heard of CodeHydra is the overwhelmingly common
 * case, and it must cost nothing and say nothing.
 *
 * Listing the directory rather than probing one path is what makes the
 * candidates' kinds visible — a directory or symlink sitting where a hook file
 * should be is a mistake worth naming, since a directory is what someone
 * reaching for the git model's multi-script cousin would try first. Neither is
 * run, and neither takes part in the choice, so it cannot shadow a real file.
 */
export async function findHook(
  deps: Pick<HookRunnerDeps, "fileSystem" | "logger" | "platform">,
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

  const files: string[] = [];
  for (const candidate of entries) {
    if (!namesEntry(candidate.name, entry)) continue;
    if (candidate.isFile) {
      files.push(candidate.name);
    } else {
      deps.logger.warn("Hook entry is not a file, ignoring", {
        path: new Path(dir, candidate.name).toNative(),
      });
    }
  }

  const selected = selectHookFiles(files, entry, deps.platform ?? process.platform);
  if (selected.length === 0) return undefined;
  if (selected.length > 1) {
    return {
      kind: "ambiguous",
      entry,
      candidates: selected.map((name) => new Path(dir, name)),
    };
  }
  return { kind: "file", entry, path: new Path(dir, selected[0]!) };
}

/**
 * The failure an ambiguous entry amounts to: nothing ran, and the message names
 * every file so the stale one is easy to spot.
 */
export function ambiguityError(hook: AmbiguousHook): HookFailedError {
  const names = hook.candidates.map((candidate) => candidate.basename).join(", ");
  return new HookFailedError(
    hook.entry,
    `${hook.entry} did not run: several files claim it on this platform (${names}). ` +
      `Keep one, or pin them with a .win, .linux or .mac suffix.`
  );
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Run a hook and return whatever it printed, validated against `output`.
 *
 * Throws `HookFailedError` when the entry is ambiguous, the process could not
 * be started, exited non-zero, printed something that is not the declared
 * output shape, or was canceled through `options.signal`. The caller decides
 * what that means: fatal for a gate, merely loud for setup.
 */
export async function runHook<S extends z.ZodType>(
  deps: HookRunnerDeps,
  found: FoundHook,
  worktree: Path,
  input: unknown,
  output: S,
  options?: RunHookOptions
): Promise<z.infer<S>> {
  if (found.kind === "ambiguous") throw ambiguityError(found);
  // Canceled before it started (the app is quitting): nothing to spawn and kill.
  if (options?.signal?.aborted === true) throw canceledError(deps, found.entry);

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

  const result = await waitUnlessCanceled(proc, options?.signal);
  if (result === "canceled") throw canceledError(deps, found.entry);

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
 * fail anything. Callers do not await it. An ambiguous entry is the caller's to
 * report (it is a repository mistake, not a run), so this takes only a file.
 * Aborting `options.signal` kills it, as it does a blocking hook.
 */
export async function runEventHook(
  deps: HookRunnerDeps,
  found: RunnableHook,
  worktree: Path,
  input: unknown,
  options?: RunHookOptions
): Promise<void> {
  if (options?.signal?.aborted === true) return;
  try {
    const commandLine = quoteForShell(found.path.toNative());
    const proc = deps.processRunner.run(commandLine, [], {
      shell: true,
      cwd: worktree.toNative(),
      env: hookEnv(deps.binDir),
      input: JSON.stringify(input),
    });
    const result = await waitUnlessCanceled(proc, options?.signal);
    if (result === "canceled") {
      deps.logger.info("Event hook canceled", { entry: found.entry });
      return;
    }
    reportStderr(deps, worktree, found.entry, result.stderr);
    if (result.exitCode !== 0) {
      // A log line and no more. Nothing is waiting on this, and a notification
      // for every failed turn of a chatty event would be its own problem.
      deps.logger.warn("Event hook failed", {
        entry: found.entry,
        reason: exitReason(result.exitCode),
      });
    }
  } catch (error) {
    deps.logger.warn("Event hook could not be run", {
      entry: found.entry,
      error: getErrorMessage(error),
    });
  }
}

function canceledError(deps: HookRunnerDeps, entry: string): HookFailedError {
  deps.logger.warn("Hook canceled", { entry });
  return new HookFailedError(entry, `${entry} was canceled`);
}

/**
 * Wait for a hook to exit, or kill it when the signal aborts first.
 *
 * Once canceled the run is over from the caller's point of view, whether or
 * not the kill landed: the tree kill is as thorough as the platform allows,
 * and a process that survives it must not hold a workspace open forever — the
 * very thing Cancel exists to end.
 */
async function waitUnlessCanceled(
  proc: SpawnedProcess,
  signal: AbortSignal | undefined
): Promise<ProcessResult | "canceled"> {
  if (signal === undefined) return proc.wait();

  const cancel = async (): Promise<"canceled"> => {
    await proc.kill(PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS);
    return "canceled";
  };
  if (signal.aborted) return cancel();

  return new Promise((resolve) => {
    const onAbort = (): void => {
      void cancel().then(resolve);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void proc.wait().then((result) => {
      // Killed by our own cancel: `onAbort` answers once the kill is done.
      if (signal.aborted) return;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
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
    // warn, the default level: the log is where a hook's output is read when
    // it never reached an editor (a deletion gate, a failed open), and a line a
    // script chose to print is worth more than the default level would keep.
    deps.logger.warn("hook", { entry, line });
    deps.sink.write(worktree.toString(), entry, line);
  }
}

/** A failure message worth reading, from the little a failed process gives us. */
function describeExit(entry: string, exitCode: number | null, stderr: string): string {
  const tail = lastMeaningfulLine(stderr);
  const reason = exitReason(exitCode);
  return tail ? `${entry} failed: ${reason} — ${tail}` : `${entry} failed: ${reason}`;
}

/**
 * The exit code, with the shell's two conventional codes spelled out.
 *
 * Hedged on purpose. 126 is "found it, could not execute it" and 127 "not
 * found" — but a script that runs a missing command, or a non-executable one,
 * exits with the same codes, so neither can honestly be pinned on the hook file
 * itself. Naming the likely cause beats the raw "Permission denied", which
 * sends people looking at file ownership.
 */
function exitReason(exitCode: number | null): string {
  switch (exitCode) {
    case null:
      return "no exit code (killed)";
    case 126:
      return "exit 126: a file could not be executed (is it chmod +x?)";
    case 127:
      return "exit 127: a command was not found (the shebang interpreter, or one the script ran)";
    default:
      return `exit ${exitCode}`;
  }
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
      // A rejected record key (a tag name) says only "Invalid key in record";
      // the reason is on the key's own issues.
      const message =
        issue.code === "invalid_key"
          ? issue.issues.map((keyIssue) => keyIssue.message).join("; ")
          : issue.message;
      return `${at}${message}`;
    })
    .join("; ");
}
