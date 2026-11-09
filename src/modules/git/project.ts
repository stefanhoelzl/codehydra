/**
 * The project side of the git type for projects opened from a local path, and
 * for every git project at restore and close: the git-init offer, the `.git`
 * check, the record's config and identifier, restore, and the project's own
 * directories on close.
 *
 * The project store (project-store-module) owns what is common to every
 * project: records, ids, badge colors, the open-project map.
 */

import { Path } from "../../utils/path/path";
import type { ProjectPath, ProjectRef } from "../../intents/contract";
import { projectDirName } from "../../boundaries/platform/paths";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging";
import { getErrorMessage } from "../../shared/errors/service-errors";
import type { GitWorktreeProvider } from "../../boundaries/platform/git-worktree-provider";
import type {
  OpenProjectPayload,
  PrepareHookResult,
  ProjectTypeConfig,
  ResolveHookResult,
} from "../../intents/open-project";
import type { UiPresenter } from "../presentation/presentation-module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { notify } from "../presentation/notification-card";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { CloseHookInput } from "../../intents/close-project";
import type { RestoreProjectResult } from "../../intents/app-ready";
import type { ProjectStoreModule } from "../project-store-module";
import { GIT_PROJECT_TYPE, gitProjectIdentifier, gitProjectRef } from "./ref";
import {
  gitRecords,
  newLocalConfig,
  parseGitConfig,
  recordDirName,
  type GitRecord,
  type StoreDirs,
} from "./records";

export interface GitProjectsDeps {
  readonly projectsDir: string;
  /** Where managed clones live; read on every use, the workspaces root is settled at startup. */
  readonly remotesDir: () => string;
  readonly fs: Pick<FileSystemBoundary, "rm">;
  readonly store: Pick<ProjectStoreModule, "records" | "isOpen">;
  readonly gitWorktreeProvider: Pick<GitWorktreeProvider, "validateRepository">;
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly gitClient: Pick<IGitClient, "isRepositoryRoot" | "init">;
  readonly logger: Logger;
}

export interface GitProjects {
  /** project:open prepare: offer `git init` for a local directory that is no repository. */
  offerInit(payload: OpenProjectPayload): Promise<PrepareHookResult>;
  /** project:open resolve for a local path: the record's config and identifier, `.git` checked. */
  resolveLocal(path: ProjectPath): Promise<ResolveHookResult>;
  /** app:ready restore: the project:open payload that reopens a saved git project. */
  restore(config: ProjectTypeConfig): RestoreProjectResult;
  /** The remote URL on a project's record, if it has one. */
  remoteUrlOf(projectPath: string): Promise<string | undefined>;
  /** project:close close: the project's own directories (the store removes its record). */
  removeDirectories(ctx: CloseHookInput): Promise<void>;
  /** The ref of every git project with a record, by its normalized path — open or not. */
  projectRefs(): Promise<ReadonlyMap<string, ProjectRef>>;
}

export function createGitProjects(deps: GitProjectsDeps): GitProjects {
  const { projectsDir, remotesDir, fs, store, gitWorktreeProvider, ui, dispatcher, gitClient } =
    deps;
  const { logger } = deps;
  const dirs = (): StoreDirs => ({ projectsDir, remotesDir: remotesDir() });

  /** The record of the git project at this path, if it has one. */
  async function findRecord(projectPath: string): Promise<GitRecord | undefined> {
    const normalizedPath = new Path(projectPath).toString();
    const records = gitRecords(dirs(), await store.records());
    return records.find((record) => record.project.path === normalizedPath);
  }

  /**
   * Delete a local project's own directory. Best-effort: by the time the
   * close hook runs the project is already out of internal state and its
   * workspaces are gone, so throwing would leave the app inconsistent without
   * saving the directory. Instead say so — a directory the user explicitly
   * asked to delete surviving in silence is the worse outcome.
   */
  async function removeLocalDirectory(projectPath: string): Promise<void> {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger
        .scoped({ path: projectPath })
        .warn("Failed to remove project directory", { error: message });
      notify(dispatcher, {
        type: "error",
        title: "Could not remove the project directory",
        message: `${projectPath} is still on disk: ${message}`,
        dismissible: true,
      });
    }
  }

  /**
   * Remove the path-named directory a git project's worktrees live in, each
   * part only if empty. A workspaces directory still holding worktrees is
   * evidence of a failed deletion, worth keeping.
   */
  async function removeWorkspacesDir(projectPath: string): Promise<void> {
    const projectDir = new Path(projectsDir, projectDirName(projectPath));
    try {
      await fs.rm(new Path(projectDir, "workspaces"));
    } catch {
      // ENOTEMPTY (workspaces exist) or ENOENT (doesn't exist) - that's fine
    }
    try {
      await fs.rm(projectDir);
    } catch {
      // ENOTEMPTY (the record is still there) or ENOENT - that's fine
    }
  }

  return {
    async offerInit(payload) {
      const { path, git } = payload;

      // Self-select: only local paths
      if (git || !path) return {};

      // Already open — skip
      if (store.isOpen(path)) return {};

      // The contract carries the path as plain data; git operations take a `Path`.
      const pathObj = new Path(path);

      let isRepo: boolean;
      try {
        isRepo = await gitClient.isRepositoryRoot(pathObj);
      } catch {
        // Path doesn't exist or inaccessible — let resolve handle the error
        return {};
      }
      if (isRepo) return {};

      // Not a git repo — ask user
      const dialog = ui.dialog({
        sections: [
          { type: "text", content: "Initialize Git Repository?", style: "heading" },
          { type: "text", content: path.toString(), style: "subtitle" },
          {
            type: "group",
            items: [
              { type: "button", id: "init", label: "Initialize", variant: "primary" },
              {
                type: "button",
                id: "cancel",
                label: "Cancel",
                variant: "secondary",
                role: "cancel",
              },
            ],
          },
        ],
      });

      // Escape (dismiss) cancels, same as the Cancel button.
      const event = await dialog.nextEvent();
      dialog.close();

      if (event.kind === "dismiss" || event.actionId !== "init") {
        return { canceled: true };
      }

      await gitClient.init(pathObj, { initialCommit: "Initial commit" });
      return {};
    },

    async resolveLocal(path) {
      // The record, if any: its remoteUrl restores a clone's ref and icon,
      // and its config is handed back as is, so the store finds the record.
      const record = await findRecord(path);
      const remoteUrl = record?.project.remoteUrl;
      const resolved = {
        projectPath: path,
        type: GIT_PROJECT_TYPE,
        config: record?.config ?? newLocalConfig(path),
        identifier: gitProjectIdentifier(path, remoteUrl),
        ...(remoteUrl !== undefined && { remoteUrl }),
      };

      // Already open — skip validation, signal short-circuit
      if (store.isOpen(path)) return { ...resolved, alreadyOpen: true };

      await gitWorktreeProvider.validateRepository(new Path(path));
      return resolved;
    },

    restore(config) {
      const parsed = parseGitConfig(dirs(), config);
      if (!parsed) {
        logger.warn("Skipping a git project record without a usable path or URL");
        return {};
      }
      return { payload: { path: parsed.path } };
    },

    async remoteUrlOf(projectPath) {
      return (await findRecord(projectPath))?.project.remoteUrl;
    },

    async removeDirectories(ctx) {
      const { projectPath, removeLocalRepo, remoteUrl } = ctx;

      if (removeLocalRepo && remoteUrl) {
        // Managed clone with removeLocalRepo: force-delete its app-data
        // directories — the worktrees' (path-named) and the record's (URL-named).
        // The clone itself goes with removeClone.
        const configDirs = new Set([
          projectDirName(projectPath),
          recordDirName(dirs(), projectPath, remoteUrl),
        ]);
        for (const dirName of configDirs) {
          try {
            await fs.rm(new Path(projectsDir, dirName), { recursive: true, force: true });
          } catch {
            // Fail silently
          }
        }
        return;
      }

      // Local project with removeLocalRepo: delete the user's own working copy.
      // The app-data dir still goes through the gentle removal below — a
      // workspaces dir left non-empty by a failed worktree deletion is evidence
      // worth keeping, not something to force-rm away.
      if (removeLocalRepo) {
        await removeLocalDirectory(projectPath);
      }
      await removeWorkspacesDir(projectPath);
    },

    async projectRefs() {
      const refs = new Map<string, ProjectRef>();
      for (const { project } of gitRecords(dirs(), await store.records())) {
        refs.set(new Path(project.path).toString(), gitProjectRef(project.path, project.remoteUrl));
      }
      return refs;
    },
  };
}
