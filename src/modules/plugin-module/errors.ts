/**
 * What is wrong with plugins right now: the source of `ch plugin errors` and of
 * the error notifications.
 *
 * Two kinds of entry, kept in memory:
 *
 * - a **problem** stops a plugin running at all — a manifest that does not
 *   parse, a plugins directory entry that is not a plugin, a shell that is not
 *   installed. It stays until the next read of the plugin no longer has it.
 * - a **failure** is the last failed run of one hook or remote fetch, with
 *   its exit and its run log. It stays until that entry next succeeds, or the
 *   app restarts. (An automation's failures are the poll module's.)
 *
 * Each entry has one card for as long as it lasts (scripts/failure-cards.ts):
 * raised when it appears or its message changes, never for the same message
 * again, closed when the entry goes, with an Open log button when it has a run
 * log. The text never quotes a script's output — that can carry credentials —
 * and points at `ch plugin errors`, which lists the log.
 *
 * An entry that goes, or is replaced by a new message, is kept as past when it
 * has no run log (a problem, a script that never started, a fetch) — one with
 * a log is recorded by the log itself.
 */

/** Where a card sends the reader for the rest: the run log and the full list. */
export const ERRORS_POINTER = "see ch plugin errors";

import type { FailureCards } from "../scripts/failure-cards";
import { PastFailures } from "../scripts/failure-cards";

export interface PluginErrorEntry {
  /** `<type>:<entry>:<name>` — or `<type>:<entry>` for something wrong with a source itself. */
  readonly plugin: string;
  /** The project a workspace plugin belongs to. */
  readonly project?: string;
  /** The hook entry or automation that failed; absent for a problem. */
  readonly entry?: string;
  readonly message: string;
  /** The failed run's log file. */
  readonly logPath?: string;
  /** ISO time it was recorded. */
  readonly at: string;
}

export interface ErrorKey {
  readonly plugin: string;
  readonly project?: string;
  readonly entry?: string;
}

/** Which plugins one read of a plugins directory speaks for. */
export interface ProblemScope {
  /** `<type>:<entry>`: the source its plugin names start with. */
  readonly source: string;
  /** The project, for a repository's plugins. */
  readonly project?: string;
}

export interface PluginErrorBook {
  /**
   * The problems one read of a plugins directory found, replacing whatever
   * that directory had before — a plugin fixed or removed since is forgotten.
   */
  setProblems(
    scope: ProblemScope,
    problems: readonly { readonly plugin: string; readonly message: string }[]
  ): void;
  /** A run failed. */
  failure(
    key: Required<Pick<ErrorKey, "entry">> & ErrorKey,
    message: string,
    logPath?: string
  ): void;
  /** A run succeeded: forget its entry's failure. */
  success(key: Required<Pick<ErrorKey, "entry">> & ErrorKey): void;
  list(): readonly PluginErrorEntry[];
  /** Past entries that had no run log, since the app started. */
  past(): readonly PluginErrorEntry[];
}

function keyOf(key: ErrorKey): string {
  return JSON.stringify([key.plugin, key.project ?? null, key.entry ?? null]);
}

function describe(entry: PluginErrorEntry): string {
  const where = entry.entry !== undefined ? `${entry.plugin} ${entry.entry}` : entry.plugin;
  return `${where}: ${entry.message} — ${ERRORS_POINTER}`;
}

export function createPluginErrorBook(deps: {
  readonly cards: FailureCards;
  readonly now?: () => Date;
}): PluginErrorBook {
  const entries = new Map<string, PluginErrorEntry>();
  const past = new PastFailures<PluginErrorEntry>();
  const now = deps.now ?? ((): Date => new Date());

  function forget(id: string): void {
    const previous = entries.get(id);
    if (previous === undefined) return;
    entries.delete(id);
    past.add(id, previous);
    deps.cards.clear(id);
  }

  function record(key: ErrorKey, message: string, logPath?: string): void {
    const id = keyOf(key);
    const previous = entries.get(id);
    const entry: PluginErrorEntry = {
      plugin: key.plugin,
      ...(key.project !== undefined && { project: key.project }),
      ...(key.entry !== undefined && { entry: key.entry }),
      message,
      ...(logPath !== undefined && { logPath }),
      at: now().toISOString(),
    };
    entries.set(id, entry);
    if (previous !== undefined && previous.message !== message) past.add(id, previous);
    deps.cards.raise(id, {
      title: key.entry !== undefined ? "Plugin failed" : "Plugin cannot run",
      message: describe(entry),
      ...(logPath !== undefined && { logPath }),
    });
  }

  function inScope(entry: PluginErrorEntry, scope: ProblemScope): boolean {
    return (
      entry.entry === undefined &&
      entry.plugin.startsWith(`${scope.source}:`) &&
      entry.project === scope.project
    );
  }

  return {
    setProblems(scope, problems) {
      const current = new Set(problems.map((problem) => keyOf({ ...scope, ...problem })));
      for (const [id, entry] of entries) {
        if (inScope(entry, scope) && !current.has(id)) forget(id);
      }
      for (const problem of problems) {
        record(
          {
            plugin: problem.plugin,
            ...(scope.project !== undefined && { project: scope.project }),
          },
          problem.message
        );
      }
    },
    failure: (key, message, logPath) => record(key, message, logPath),
    success: (key) => forget(keyOf(key)),
    list: () => [...entries.values()],
    past: () => past.list(),
  };
}
