/**
 * Moving CodeHydra's data to a new workspaces root.
 *
 * Only managed clones move. Worktrees stay where they are — copying them would
 * cost every agent its conversation, every editor its state and every worktree
 * its ignored files — and are adopted in place, so they stay workspaces while
 * new ones are created under the new root.
 *
 * Order, with the switch as the commit point:
 *
 *   1. records   legacy managed records → URL-only, so no record names a clone path
 *   2. clones    copy each managed clone to <to>/remotes
 *   3. repair    `git worktree repair` from each copy — its worktrees' `.git`
 *                files name the old clone and git fails inside them otherwise
 *   4. adopt     tag every worktree under the old root as external
 *   5. switch    record the new root; rewrite path-keyed state; move screenshots
 *   6. cleanup   delete the old clones
 *
 * A failure before the switch undoes what ran (copies deleted, repairs pointed
 * back, adoption tags removed) and the old root stays in use. After it, failures
 * are reported, never undone: the data is already where the app now looks.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging";
import type { ProgressItem } from "../../shared/dialog-types";
import { getErrorMessage } from "../../shared/errors/service-errors";
import { Path } from "../../utils/path/path";
import { extractRepoName } from "../../utils/url-utils";
import { managedClonePath, managedProjectDirName } from "../../boundaries/platform/paths";
import {
  generateProjectId,
  isManaged,
  loadAllProjects,
  saveProject,
  type StoreDirs,
} from "../local-project-module";
import {
  remotesDirUnder,
  workspacesDirUnder,
  type ProjectMove,
  type ProjectMoveListener,
} from "./workspaces-root";

/** Branch config key of the external (adopted) tag. */
const EXTERNAL_TAG_CONFIG_KEY = "codehydra.tags.external";

export interface MigrationDeps {
  readonly fs: Pick<
    FileSystemBoundary,
    "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm" | "copyTree" | "rename"
  >;
  readonly gitClient: Pick<IGitClient, "listWorktrees" | "repairWorktrees" | "unsetBranchConfig">;
  /** Adopt a worktree outside its project's workspaces directory (writes the external tag). */
  readonly adopt: (projectRoot: Path, worktreePath: Path, branch: string) => Promise<unknown>;
  /** Directory of project records (stays in the data root). */
  readonly projectsDir: string;
  /** Directory of hibernation screenshots, one subdirectory per project id. */
  readonly screenshotsDir: Path;
  /** Owners of path-keyed state, told about moved projects after the switch. */
  readonly moveListeners: readonly ProjectMoveListener[];
  /** Record the new root as the one in use. The commit point. */
  readonly commit: () => Promise<void>;
  readonly logger: Logger;
}

export interface MigrationReport {
  /** Worktrees under the old root that could not be kept (detached HEAD: no branch to tag). */
  readonly notKept: readonly string[];
  /** Old clones that could not be deleted. */
  readonly leftovers: readonly string[];
  /** Steps after the switch that failed (state rewrites, screenshots). */
  readonly warnings: readonly string[];
}

const STEP_LABELS = {
  records: "Prepare project records",
  clones: "Copy cloned repositories",
  repair: "Reconnect their worktrees",
  adopt: "Keep existing workspaces where they are",
  switch: "Switch to the new folder",
  cleanup: "Remove the old clones",
} as const;
type StepId = keyof typeof STEP_LABELS;

/** Progress rows for the migration, updated as it runs. */
export class MigrationProgress {
  private readonly rows = new Map<StepId, ProgressItem>();

  constructor(private readonly onChange: (items: readonly ProgressItem[]) => void) {
    for (const [id, label] of Object.entries(STEP_LABELS)) {
      this.rows.set(id as StepId, { id, label, status: "pending" });
    }
  }

  items(): readonly ProgressItem[] {
    return [...this.rows.values()];
  }

  set(id: StepId, status: ProgressItem["status"], message?: string): void {
    this.rows.set(id, {
      id,
      label: STEP_LABELS[id],
      status,
      ...(message !== undefined && { message }),
    });
    this.onChange(this.items());
  }
}

interface ManagedProject {
  readonly url: string;
  readonly from: Path;
  readonly to: Path;
}

interface Adopted {
  readonly projectRoot: Path;
  readonly branch: string;
}

/**
 * Move the data under `from` to `to`. Throws when a step before the switch
 * fails, after undoing what ran; the old root is then still the one in use.
 */
export async function migrateWorkspacesRoot(
  deps: MigrationDeps,
  from: Path,
  to: Path,
  progress: MigrationProgress
): Promise<MigrationReport> {
  const { fs, gitClient, logger } = deps;
  const oldDirs: StoreDirs = {
    projectsDir: deps.projectsDir,
    remotesDir: remotesDirUnder(from).toString(),
  };

  // 1. records ---------------------------------------------------------------
  progress.set("records", "running");
  const stored = await loadAllProjects(fs, oldDirs);
  const managed: ManagedProject[] = [];
  const local: Path[] = [];
  for (const { config, dirName, legacy } of stored) {
    const url = config.remoteUrl;
    if (url === undefined || !isManaged(oldDirs, config.path, url)) {
      local.push(new Path(config.path));
      continue;
    }
    if (legacy) {
      // Strict, unlike the startup conversion: the old clone is about to be
      // deleted, so a record still naming it would reopen nothing.
      await saveProject(fs, oldDirs, config.path, url);
      if (dirName !== managedProjectDirName(url)) {
        await fs.unlink(new Path(deps.projectsDir, dirName, "config.json"));
      }
    }
    managed.push({
      url,
      from: new Path(config.path),
      to: managedClonePath(remotesDirUnder(to), url),
    });
  }
  progress.set("records", "done");

  const copied: ManagedProject[] = [];
  const repaired: { project: ManagedProject; worktrees: Path[] }[] = [];
  const adopted: Adopted[] = [];

  const undo = async (): Promise<void> => {
    for (const { projectRoot, branch } of adopted) {
      await attempt(logger, "remove adoption tag", () =>
        gitClient.unsetBranchConfig(projectRoot, branch, EXTERNAL_TAG_CONFIG_KEY)
      );
    }
    for (const { project, worktrees } of repaired) {
      await attempt(logger, "point worktrees back at the old clone", () =>
        gitClient.repairWorktrees(project.from, worktrees)
      );
    }
    for (const project of copied) {
      await attempt(logger, "delete the partial copy", () =>
        fs.rm(project.to.dirname, { recursive: true, force: true })
      );
    }
  };

  try {
    // 2. clones --------------------------------------------------------------
    progress.set("clones", "running", managed.length === 0 ? "none" : undefined);
    for (const [index, project] of managed.entries()) {
      progress.set(
        "clones",
        "running",
        `${extractRepoName(project.url)} (${index + 1} of ${managed.length})`
      );
      copied.push(project);
      await fs.mkdir(project.to.dirname);
      await fs.copyTree(project.from, project.to);
    }
    progress.set("clones", "done");

    // 3. repair --------------------------------------------------------------
    progress.set("repair", "running");
    for (const project of managed) {
      const worktrees = (await gitClient.listWorktrees(project.to))
        .filter((wt) => !wt.isMain && !wt.prunable)
        .map((wt) => wt.path);
      repaired.push({ project, worktrees });
      await gitClient.repairWorktrees(project.to, worktrees);
    }
    progress.set("repair", "done");

    // 4. adopt ---------------------------------------------------------------
    progress.set("adopt", "running");
    const notKept: string[] = [];
    const roots = [
      ...local.map((path) => ({ root: path, oldPath: path })),
      ...managed.map((project) => ({ root: project.to, oldPath: project.from })),
    ];
    for (const { root, oldPath } of roots) {
      const oldWorkspacesDir = workspacesDirUnder(from, oldPath);
      for (const wt of await gitClient.listWorktrees(root)) {
        if (wt.isMain || wt.prunable || !wt.path.isChildOf(oldWorkspacesDir)) continue;
        if (wt.branch === null) {
          notKept.push(wt.path.toString());
          continue;
        }
        await deps.adopt(root, wt.path, wt.branch);
        adopted.push({ projectRoot: root, branch: wt.branch });
      }
    }
    progress.set("adopt", "done");

    // 5. switch (commit point) -----------------------------------------------
    progress.set("switch", "running");
    await deps.commit();
    const warnings = await afterSwitch(deps, managed);
    progress.set("switch", "done");

    // 6. cleanup -------------------------------------------------------------
    progress.set("cleanup", "running");
    const leftovers: string[] = [];
    for (const project of managed) {
      try {
        await fs.rm(project.from.dirname, { recursive: true, force: true });
      } catch (error) {
        logger.warn("Could not delete an old clone", {
          path: project.from.toString(),
          error: getErrorMessage(error),
        });
        leftovers.push(project.from.dirname.toString());
      }
    }
    progress.set("cleanup", leftovers.length === 0 ? "done" : "error");

    return { notKept, leftovers, warnings };
  } catch (error) {
    await undo();
    throw error;
  }
}

/** Best-effort follow-ups once the new root is in use. Returns what failed. */
async function afterSwitch(
  deps: MigrationDeps,
  managed: readonly ManagedProject[]
): Promise<string[]> {
  const warnings: string[] = [];
  const moves: ProjectMove[] = managed.map((project) => ({
    from: project.from.toString(),
    to: project.to.toString(),
  }));
  if (moves.length === 0) return warnings;

  for (const listener of deps.moveListeners) {
    try {
      await listener(moves);
    } catch (error) {
      warnings.push(`Could not update saved settings: ${getErrorMessage(error)}`);
    }
  }

  // A project's id hashes its path, and screenshots of hibernated workspaces are
  // filed under it.
  for (const move of moves) {
    const from = new Path(deps.screenshotsDir, generateProjectId(move.from));
    const to = new Path(deps.screenshotsDir, generateProjectId(move.to));
    try {
      await deps.fs.rename(from, to);
    } catch {
      // No screenshots for this project (the common case), or unmovable: a
      // hibernated workspace then shows no preview until it is next hibernated.
    }
  }
  return warnings;
}

async function attempt(logger: Logger, what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn(`Migration rollback: could not ${what}`, { error: getErrorMessage(error) });
  }
}
