/**
 * CleanupModule - Sweeps the data root of things nothing uses any more.
 *
 * Hook handlers:
 * - app:start / start: run every rule, fire-and-forget.
 *
 * Fire-and-forget is deliberate. Reclaiming gigabytes can take seconds and
 * nothing waits on the result, so awaiting it would only delay the UI. It is
 * safe precisely because every path a rule touches is one nothing else writes:
 * retired directories no code references, log files older than the current
 * session, and bundle versions other than the live one. The one sweep that is
 * order-critical — clearing the temp root before a workspace writes its agent
 * config into it — deliberately stays in temp-dir-module, where it is awaited
 * in the earlier "init" hook.
 *
 * Rules are declared by the composition root and run in order, so a rule that
 * retires a path can precede one that sweeps its parent.
 *
 * Every rule is best-effort: a failure is logged at warn and the remaining
 * rules still run. Cleanup must never be the reason the app fails to start.
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logger } from "../boundaries/platform/logging";
import type { FileSystemBoundary, DirEntry } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import { Path } from "../utils/path/path";
import { getErrorMessage } from "../shared/error-utils";
import { FileSystemError } from "../shared/errors/service-errors";
import { APP_START_OPERATION_ID } from "../intents/app-start";

// =============================================================================
// Rules
// =============================================================================

/**
 * Delete a path we no longer use, whole. For a directory left behind by a
 * rename or a retired feature — nothing reads it, so there is nothing to keep.
 */
export interface RetireRule {
  readonly kind: "retire";
  /** Path relative to the data root. */
  readonly path: string;
}

/**
 * Keep the newest `keep` entries of a directory, by name.
 *
 * By name, not by timestamp: session log files are named for the launch that
 * wrote them (`2026-08-28T07-35-51-<id>.log`), so a lexicographic sort is
 * already chronological, and it needs no `stat` per entry. Names that are not
 * session logs rank oldest, which is what we want — a stray file in the log
 * directory is exactly the thing to sweep first.
 */
export interface KeepRecentRule {
  readonly kind: "keepRecent";
  /** Path relative to the data root. */
  readonly path: string;
  /** How many entries survive. */
  readonly keep: number;
}

/**
 * Delete childless directories directly under a path.
 *
 * For a tree whose leaves are already pruned by whoever owns them (hibernation
 * screenshots are deleted on wake and on workspace delete) but whose per-owner
 * directories are left behind when the owner goes away.
 */
export interface PruneEmptyRule {
  readonly kind: "pruneEmpty";
  /** Path relative to the data root. */
  readonly path: string;
}

/**
 * Keep only the live version of a downloaded bundle, delete every other child.
 *
 * `live` is read when the rule runs, not when it is declared, so it reflects
 * the resolved configuration. An empty live version (an agent that ships its
 * binary rather than downloading one) means no version directory is expected,
 * so everything goes.
 */
export interface BundleRule {
  readonly kind: "bundle";
  /** Path relative to the data root. */
  readonly path: string;
  /** The version this launch resolved, or null when nothing is downloaded. */
  readonly live: () => string | null;
  /**
   * Skip in development builds. Dev shares its data root with the binaries
   * that `pnpm install` and the test helpers download, and those are pinned to
   * versions the running app does not resolve.
   */
  readonly packagedOnly: true;
}

export type CleanupRule = RetireRule | KeepRecentRule | PruneEmptyRule | BundleRule;

// =============================================================================
// Dependencies
// =============================================================================

export interface CleanupModuleDeps {
  readonly fileSystem: Pick<FileSystemBoundary, "rm" | "readdir">;
  readonly pathProvider: Pick<PathProvider, "dataPath">;
  readonly logger: Logger;
  /** False in development builds; gates `packagedOnly` rules. */
  readonly isPackagedBuild: boolean;
  readonly rules: readonly CleanupRule[];
}

// =============================================================================
// Helpers
// =============================================================================

/** A session log file, named for the launch that wrote it. */
const SESSION_LOG_NAME = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Order entries newest-first for `keepRecent`. Session logs sort by name
 * (chronological by construction); anything else ranks oldest, whatever it is
 * called.
 */
function newestFirst(a: DirEntry, b: DirEntry): number {
  const aIsLog = SESSION_LOG_NAME.test(a.name);
  const bIsLog = SESSION_LOG_NAME.test(b.name);
  if (aIsLog !== bIsLog) {
    return aIsLog ? -1 : 1;
  }
  return b.name.localeCompare(a.name);
}

// =============================================================================
// Module Factory
// =============================================================================

export function createCleanupModule(deps: CleanupModuleDeps): IntentModule {
  const { fileSystem, pathProvider, logger, isPackagedBuild, rules } = deps;

  /** Delete one path, whether it is a file or a whole tree. */
  async function remove(target: Path): Promise<void> {
    await fileSystem.rm(target, { recursive: true, force: true });
  }

  /**
   * List a directory, treating "it isn't there" as "nothing to do". A rule
   * whose target never existed on this machine is the normal case, not a
   * failure worth reporting. Any other error — an unreadable directory, say —
   * propagates, so the rule reports it rather than quietly behaving as though
   * the directory were empty and there was nothing to clean.
   */
  async function listOrEmpty(target: Path): Promise<readonly DirEntry[]> {
    try {
      return await fileSystem.readdir(target);
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function runRetire(rule: RetireRule): Promise<number> {
    const target = pathProvider.dataPath(rule.path);

    // Ask the parent whether the target is even there. `rm` with `force` would
    // happily no-op on an absent path, but then every launch would report
    // retiring paths that no machine has had for months. Checking via the
    // parent listing works for a retired file as well as a retired tree.
    const siblings = await listOrEmpty(target.dirname);
    if (!siblings.some((entry) => entry.name === target.basename)) {
      return 0;
    }

    await remove(target);
    return 1;
  }

  async function runKeepRecent(rule: KeepRecentRule): Promise<number> {
    const dir = pathProvider.dataPath(rule.path);
    const entries = [...(await listOrEmpty(dir))].sort(newestFirst);
    const doomed = entries.slice(rule.keep);

    let removed = 0;
    for (const entry of doomed) {
      await remove(new Path(dir, entry.name));
      removed++;
    }
    return removed;
  }

  async function runPruneEmpty(rule: PruneEmptyRule): Promise<number> {
    const dir = pathProvider.dataPath(rule.path);
    const entries = await listOrEmpty(dir);

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }
      const child = new Path(dir, entry.name);
      const contents = await listOrEmpty(child);
      if (contents.length > 0) {
        continue;
      }
      await remove(child);
      removed++;
    }
    return removed;
  }

  async function runBundle(rule: BundleRule): Promise<number> {
    if (!isPackagedBuild) {
      return 0;
    }

    const dir = pathProvider.dataPath(rule.path);
    const live = rule.live();
    const entries = await listOrEmpty(dir);

    let removed = 0;
    for (const entry of entries) {
      if (entry.name === live) {
        continue;
      }
      await remove(new Path(dir, entry.name));
      removed++;
    }
    return removed;
  }

  function runRule(rule: CleanupRule): Promise<number> {
    switch (rule.kind) {
      case "retire":
        return runRetire(rule);
      case "keepRecent":
        return runKeepRecent(rule);
      case "pruneEmpty":
        return runPruneEmpty(rule);
      case "bundle":
        return runBundle(rule);
    }
  }

  /**
   * Run every rule in declaration order, isolating failures so one unwritable
   * directory cannot cost us the rest of the sweep.
   */
  async function sweep(): Promise<void> {
    let total = 0;
    const done: string[] = [];

    for (const rule of rules) {
      try {
        const removed = await runRule(rule);
        if (removed > 0) {
          total += removed;
          done.push(`${rule.kind} ${rule.path} (${removed})`);
        }
      } catch (error) {
        logger.warn("Cleanup rule failed", {
          rule: rule.kind,
          path: rule.path,
          error: getErrorMessage(error),
        });
      }
    }

    if (total > 0) {
      logger.info("Cleanup removed stale entries", { entries: total, rules: done.join(", ") });
    }
  }

  return {
    name: "cleanup",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: (): Promise<void> => {
            // Fire-and-forget: sweep() never rejects (each rule is isolated),
            // but the promise is deliberately not awaited, so startup does not
            // wait on gigabytes of deletion.
            void sweep();
            return Promise.resolve();
          },
        },
      },
    },
  };
}
