/**
 * What is wrong with plugins right now: the source of `ch plugin errors` and of
 * the error notifications.
 *
 * Two kinds of entry, kept in memory:
 *
 * - a **problem** stops a plugin running at all — a manifest that does not
 *   parse, a plugins directory entry that is not a plugin, a shell that is not
 *   installed. It stays until the next read of the plugin no longer has it.
 * - a **failure** is the last failed run of one hook or automation, with its
 *   exit and its run log. It stays until that entry next succeeds, or the app
 *   restarts.
 *
 * A notification is raised when an entry appears or its message changes, never
 * for the same message again: an automation fails every poll cycle until it is
 * fixed, and one card saying so is enough. The text never quotes a script's
 * output — that can carry credentials — and never names the run log either:
 * each run has its own, so a card naming it would never join the identical
 * card already open. It points at `ch plugin errors`, which lists the log.
 */

/** Where a card sends the reader for the rest: the run log and the full list. */
export const ERRORS_POINTER = "see ch plugin errors";

import { notify } from "../presentation/notification-card";

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
  /**
   * A run failed. `quiet` records it without a card — an automation's
   * temporary failure, until it has lasted long enough to be worth one.
   */
  failure(
    key: Required<Pick<ErrorKey, "entry">> & ErrorKey,
    message: string,
    logPath?: string,
    options?: { readonly quiet?: boolean }
  ): void;
  /** A run succeeded: forget its entry's failure. */
  success(key: Required<Pick<ErrorKey, "entry">> & ErrorKey): void;
  list(): readonly PluginErrorEntry[];
}

function keyOf(key: ErrorKey): string {
  return JSON.stringify([key.plugin, key.project ?? null, key.entry ?? null]);
}

function describe(entry: PluginErrorEntry): string {
  const where = entry.entry !== undefined ? `${entry.plugin} ${entry.entry}` : entry.plugin;
  return `${where}: ${entry.message} — ${ERRORS_POINTER}`;
}

export function createPluginErrorBook(deps: {
  readonly dispatcher: Parameters<typeof notify>[0];
  readonly now?: () => Date;
}): PluginErrorBook {
  const entries = new Map<string, PluginErrorEntry>();
  const now = deps.now ?? ((): Date => new Date());

  function record(key: ErrorKey, message: string, logPath?: string, quiet = false): void {
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
    if (quiet || previous?.message === message) return;
    notify(deps.dispatcher, {
      type: "error",
      title: key.entry !== undefined ? "Plugin failed" : "Plugin cannot run",
      message: describe(entry),
      dismissible: true,
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
        if (inScope(entry, scope) && !current.has(id)) entries.delete(id);
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
    failure: (key, message, logPath, options) =>
      record(key, message, logPath, options?.quiet ?? false),
    success: (key) => void entries.delete(keyOf(key)),
    list: () => [...entries.values()],
  };
}
