/**
 * One-time conversion of the adoptions earlier migrations wrote.
 *
 * Migrate used to keep the worktrees it left under the old root by adopting each
 * with the `external` tag. The tag lives on a branch, so a worktree whose agent
 * checked out another branch stopped being a workspace, and the tag labelled
 * CodeHydra's own worktrees as created outside it. Migrate now records the
 * directories instead (`paths.workspaces-previous`).
 *
 * This finds the worktrees an earlier migration adopted — tagged, and inside a
 * CodeHydra workspaces directory (`…/projects/<project>/workspaces/<name>`), which
 * the add-project picker never creates — records their directories and removes
 * their tags. A worktree the user adopted from anywhere else keeps its tag.
 */

import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging";
import { getErrorMessage } from "../../shared/errors/service-errors";
import { Path } from "../../utils/path/path";

/** The external tag's key below `branch.<name>.`. */
const EXTERNAL_TAG_CONFIG_KEY = "codehydra.tags.external";

export interface ConvertAdoptionsDeps {
  readonly gitClient: Pick<IGitClient, "getGitConfig" | "listWorktrees" | "unsetBranchConfig">;
  readonly logger: Logger;
}

/** Whether a directory is a CodeHydra workspaces directory: `…/projects/<project>/workspaces`. */
function isWorkspacesDir(dir: Path): boolean {
  return dir.basename === "workspaces" && dir.dirname.dirname.basename === "projects";
}

/** Branch name of a `branch.<name>.codehydra.tags.external` key. */
function branchOf(key: string): string {
  return key.slice("branch.".length, key.length - `.${EXTERNAL_TAG_CONFIG_KEY}`.length);
}

/**
 * Convert the migration adoptions of the given projects.
 *
 * @param record Adds workspaces directories to the recorded previous ones; called
 *   before any tag is removed, so an interruption never leaves a worktree unowned
 * @returns The worktrees converted
 */
export async function convertMigrationAdoptions(
  deps: ConvertAdoptionsDeps,
  projects: readonly Path[],
  record: (dirs: readonly Path[]) => Promise<void>
): Promise<readonly Path[]> {
  const { gitClient, logger } = deps;
  const converted: { project: Path; branch: string; path: Path }[] = [];

  for (const project of projects) {
    try {
      const tags = await gitClient.getGitConfig(project, {
        regex: `^branch\\..*\\.codehydra\\.tags\\.external$`,
      });
      if (tags.size === 0) continue;
      const tagged = new Set([...tags.keys()].map(branchOf));
      for (const wt of await gitClient.listWorktrees(project)) {
        if (wt.isMain || wt.prunable || wt.branch === null) continue;
        if (tagged.has(wt.branch) && isWorkspacesDir(wt.path.dirname)) {
          converted.push({ project, branch: wt.branch, path: wt.path });
        }
      }
    } catch (error) {
      // Not a repository any more, or git failed: its tags stay, and still work.
      logger
        .scoped({ path: project.toString() })
        .warn("Could not read adopted worktrees", { error: getErrorMessage(error) });
    }
  }
  if (converted.length === 0) return [];

  const dirs: Path[] = [];
  for (const { path } of converted) {
    if (!dirs.some((dir) => dir.equals(path.dirname))) dirs.push(path.dirname);
  }
  await record(dirs);

  for (const { project, branch, path } of converted) {
    try {
      await gitClient.unsetBranchConfig(project, branch, EXTERNAL_TAG_CONFIG_KEY);
      logger.scoped({ path: path.toString() }).info("Converted a migration adoption");
    } catch (error) {
      // Owned through its directory now; the tag only stays visible.
      logger
        .scoped({ path: path.toString() })
        .warn("Could not remove the external tag", { error: getErrorMessage(error) });
    }
  }
  return converted.map(({ path }) => path);
}
