/**
 * Moving CodeHydra's data to a new workspaces root.
 *
 * Only managed clones move. Worktrees stay where they are — copying them would
 * cost every agent its conversation, every editor its state and every worktree
 * its ignored files — and stay workspaces: their directories are recorded as
 * previous workspaces directories, where a worktree counts as CodeHydra's own on
 * any branch, like one under the current root. New worktrees go under the new root.
 *
 * Order, with the switch as the commit point:
 *
 *   1. records   legacy managed records → URL-only, so no record names a clone path
 *   2. clones    copy each managed clone to <to>/remotes
 *   3. repair    `git worktree repair` from each copy — its worktrees' `.git`
 *                files name the old clone and git fails inside them otherwise
 *   4. switch    record the new root, and the workspaces directories left under
 *                the old one; rewrite path-keyed state; move screenshots
 *   5. cleanup   delete the old clones
 *
 * A failure before the switch undoes what ran (copies deleted, repairs pointed
 * back) and the old root stays in use. After it, failures are reported, never
 * undone: the data is already where the app now looks.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
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
import { remotesDirUnder, workspacesDirUnder } from "./workspaces-root";

export interface MigrationDeps {
  readonly fs: Pick<
    FileSystemBoundary,
    "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm" | "copyTree" | "rename"
  >;
  readonly gitClient: Pick<IGitClient, "listWorktrees" | "repairWorktrees">;
  /** Directory of project records (stays in the data root). */
  readonly projectsDir: string;
  /** Directory of hibernation screenshots, one subdirectory per project id. */
  readonly screenshotsDir: Path;
  /** Host platform, which project ids depend on. */
  readonly platform: SupportedPlatform;
  /**
   * Record the new root as the one in use, and the workspaces directories with
   * worktrees left under the old one. The commit point.
   */
  readonly commit: (previousWorkspacesDirs: readonly Path[]) => Promise<void>;
  readonly logger: Logger;
}

export interface MigrationReport {
  /** Old clones that could not be deleted. */
  readonly leftovers: readonly string[];
}

const STEP_LABELS = {
  records: "Prepare project records",
  clones: "Copy cloned repositories",
  repair: "Reconnect existing workspaces to the moved repositories",
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

  const undo = async (): Promise<void> => {
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

    // 4. switch (commit point) -----------------------------------------------
    progress.set("switch", "running");
    // The workspaces directories that still hold worktrees stay CodeHydra's own.
    const left: Path[] = [];
    const roots = [
      ...local.map((path) => ({ root: path, oldPath: path })),
      ...managed.map((project) => ({ root: project.to, oldPath: project.from })),
    ];
    for (const { root, oldPath } of roots) {
      const oldWorkspacesDir = workspacesDirUnder(from, oldPath);
      const worktrees = await gitClient.listWorktrees(root);
      const holds = worktrees.some(
        (wt) => !wt.isMain && !wt.prunable && wt.path.isChildOf(oldWorkspacesDir)
      );
      if (holds) left.push(oldWorkspacesDir);
    }
    await deps.commit(left);
    await moveScreenshots(deps, managed);
    progress.set("switch", "done");

    // 5. cleanup -------------------------------------------------------------
    progress.set("cleanup", "running");
    const leftovers: string[] = [];
    for (const project of managed) {
      try {
        await fs.rm(project.from.dirname, { recursive: true, force: true });
      } catch (error) {
        logger
          .scoped({ path: project.from.toString() })
          .warn("Could not delete an old clone", { error: getErrorMessage(error) });
        leftovers.push(project.from.dirname.toString());
      }
    }
    progress.set("cleanup", leftovers.length === 0 ? "done" : "error");

    return { leftovers };
  } catch (error) {
    await undo();
    throw error;
  }
}

/**
 * Best-effort, once the new root is in use: a project's id hashes its path, and
 * screenshots of hibernated workspaces are filed under it.
 */
async function moveScreenshots(
  deps: MigrationDeps,
  managed: readonly ManagedProject[]
): Promise<void> {
  for (const project of managed) {
    const from = new Path(
      deps.screenshotsDir,
      generateProjectId(project.from.toString(), deps.platform)
    );
    const to = new Path(
      deps.screenshotsDir,
      generateProjectId(project.to.toString(), deps.platform)
    );
    try {
      await deps.fs.rename(from, to);
    } catch {
      // No screenshots for this project (the common case), or unmovable: a
      // hibernated workspace then shows no preview until it is next hibernated.
    }
  }
}

async function attempt(logger: Logger, what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn(`Migration rollback: could not ${what}`, { error: getErrorMessage(error) });
  }
}
