/**
 * LocalProjectModule - The git project type's contributions for projects opened
 * from a local path, and for every git project at restore and close.
 *
 * The project store (project-store-module) owns what is common to every
 * project: records, ids, badge colors, the open-project map. This module adds
 * what is git's: a git project's record config is `{ path }` for a local
 * project, `{ remoteUrl }` for a managed clone (its path derived from the URL),
 * or `{ path, remoteUrl }` for a clone that is not where its URL derives.
 *
 * Hook registrations:
 * - project:open  → prepare: offer git init for a non-repo directory
 * - project:open  → resolve: validate .git exists for local paths; type "git" + config
 * - app:ready     → restore: a saved git project → the project:open payload { path }
 * - project:close → resolve: look up the project's remoteUrl in its record
 * - project:close → close:   remove the project's worktrees directory when empty, and
 *                            delete the project's own directory for a local project
 *                            closed with removeLocalRepo (the remote branch of that
 *                            flag belongs to RemoteProjectModule)
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import { projectPathSchema } from "../intents/contract";
import type { ProjectRef } from "../intents/contract";
import { projectRefFor } from "../utils/ref";
import { Path } from "../utils/path/path";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../boundaries/platform/paths";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logger } from "../boundaries/platform/logging";
import type { ProjectConfig } from "../shared/types/project";
import { getErrorMessage } from "../shared/errors/service-errors";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import {
  OPEN_PROJECT_OPERATION_ID,
  type PrepareHookResult,
  type ProjectTypeConfig,
  type ResolveHookResult,
} from "../intents/open-project";
import type { UiPresenter } from "./presentation/presentation-module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { notify } from "./presentation/notification-card";
import type { IGitClient } from "../boundaries/platform/git-client";
import {
  CLOSE_PROJECT_OPERATION_ID,
  type CloseResolveHookResult,
  type CloseHookResult,
} from "../intents/close-project";
import { APP_READY_OPERATION_ID, type RestoreProjectResult } from "../intents/app-ready";
import { defineHooks } from "../intents/declarations";
import {
  loadProjectRecords,
  type ProjectStoreModule,
  type StoredRecord,
} from "./project-store-module";

// =============================================================================
// Types
// =============================================================================

/** The project type name git projects are stored under. */
export const GIT_PROJECT_TYPE = "git";

/** A git project as its record describes it, with the badge color the record keeps. */
export interface StoredProject extends ProjectConfig {
  readonly color?: number;
}

/**
 * Dependencies for LocalProjectModule.
 */
export interface LocalProjectModuleDeps {
  readonly projectsDir: string;
  /**
   * Where managed (URL-cloned) projects are cloned to; their paths derive from it.
   * Read on every use: the workspaces root it lives in is settled at startup.
   */
  readonly remotesDir: () => string;
  readonly fs: Pick<FileSystemBoundary, "rm">;
  readonly store: Pick<ProjectStoreModule, "records" | "isOpen">;
  readonly gitWorktreeProvider: Pick<GitWorktreeProvider, "validateRepository">;
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly gitClient: Pick<IGitClient, "isRepositoryRoot" | "init">;
  readonly logger: Logger;
}

// =============================================================================
// Git records
// =============================================================================

/** Where project records and managed clones live. */
export interface StoreDirs {
  readonly projectsDir: string;
  readonly remotesDir: string;
}

/**
 * Whether a project is managed in the current layout: cloned from `remoteUrl`
 * into exactly the place that URL derives. Only then may its record drop the
 * path — anything else keeps storing it, so no project is reopened somewhere
 * it is not.
 */
export function isManaged(
  dirs: StoreDirs,
  projectPath: string,
  remoteUrl: string | undefined
): boolean {
  return (
    remoteUrl !== undefined && managedClonePath(dirs.remotesDir, remoteUrl).equals(projectPath)
  );
}

/**
 * The directory a git project's record is in: a managed project's is named
 * after its URL, so the record survives the clone moving; every other
 * project's is named after its path.
 */
function recordDirName(dirs: StoreDirs, projectPath: string, remoteUrl?: string): string {
  return remoteUrl !== undefined && isManaged(dirs, projectPath, remoteUrl)
    ? managedProjectDirName(remoteUrl)
    : projectDirName(projectPath);
}

/**
 * Read a git record's config. A managed project's holds its URL and the path is
 * derived from it; a local project's holds its path.
 */
function parseGitConfig(
  dirs: StoreDirs,
  config: ProjectTypeConfig
): { path: ProjectConfig["path"]; remoteUrl?: string } | undefined {
  const remoteUrl = typeof config.remoteUrl === "string" ? config.remoteUrl : undefined;
  const extras = remoteUrl !== undefined ? { remoteUrl } : {};
  try {
    if (typeof config.path === "string") {
      return { path: projectPathSchema.parse(new Path(config.path).toString()), ...extras };
    }
    if (remoteUrl !== undefined) {
      const path = managedClonePath(dirs.remotesDir, remoteUrl).toString();
      return { path: projectPathSchema.parse(path), ...extras };
    }
  } catch {
    // An unusable path - not a project
  }
  return undefined;
}

/** A git record, read: the project it describes and the config it holds verbatim. */
interface GitRecord {
  readonly project: StoredProject;
  readonly config: ProjectTypeConfig;
}

function gitRecords(dirs: StoreDirs, records: readonly StoredRecord[]): readonly GitRecord[] {
  const result: GitRecord[] = [];
  for (const record of records) {
    if (record.type !== GIT_PROJECT_TYPE) continue;
    const parsed = parseGitConfig(dirs, record.config);
    if (!parsed) continue;
    const project = record.color !== undefined ? { ...parsed, color: record.color } : parsed;
    result.push({ project, config: record.config });
  }
  return result;
}

/** Every saved git project. For the workspaces root, which moves managed clones. */
export async function loadAllProjects(
  fs: Pick<FileSystemBoundary, "readdir" | "readFile">,
  dirs: StoreDirs
): Promise<readonly StoredProject[]> {
  return gitRecords(dirs, await loadProjectRecords(fs, dirs.projectsDir)).map(
    (record) => record.project
  );
}

/** The git config a project at this path is stored with when it has no record yet. */
function newLocalConfig(projectPath: string): ProjectTypeConfig {
  return { path: new Path(projectPath).toString() };
}

// =============================================================================
// Module Factory
// =============================================================================

/** The local-project module, plus what it knows of every git project with a record. */
export interface LocalProjectModule extends IntentModule {
  /**
   * The ref of every git project with a record, by its normalized path — open
   * or not. For a migration turning stored project paths into refs, which needs
   * to know whether each one was cloned (named by its origin) or is a checkout.
   */
  projectRefs(): Promise<ReadonlyMap<string, ProjectRef>>;
}

export function createLocalProjectModule(deps: LocalProjectModuleDeps): LocalProjectModule {
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
   * evidence of a failed deletion, worth keeping. The project store removes
   * the record itself.
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

  async function projectRefs(): Promise<ReadonlyMap<string, ProjectRef>> {
    const refs = new Map<string, ProjectRef>();
    for (const { project } of gitRecords(dirs(), await store.records())) {
      refs.set(new Path(project.path).toString(), projectRefFor(project.path, project.remoteUrl));
    }
    return refs;
  }

  return {
    name: "local-project",
    projectRefs,
    hooks: defineHooks({
      [OPEN_PROJECT_OPERATION_ID]: {
        // prepare: offer git init for non-git directories
        prepare: {
          handler: async (ctx): Promise<HookOutput<PrepareHookResult>> => {
            const { intent } = ctx;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths
            if (git || !path) return { result: {} };

            // Already open — skip
            if (store.isOpen(path)) return { result: {} };

            // The contract carries the path as plain data; git operations take a `Path`.
            const pathObj = new Path(path);

            // Check if it's already a git repo
            let isRepo: boolean;
            try {
              isRepo = await gitClient.isRepositoryRoot(pathObj);
            } catch {
              // Path doesn't exist or inaccessible — let resolve handle the error
              return { result: {} };
            }
            if (isRepo) return { result: {} };

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
              return { result: { canceled: true } };
            }

            await gitClient.init(pathObj, { initialCommit: "Initial commit" });
            return { result: {} };
          },
        },

        // resolve: validate .git exists for local paths; report type "git" and its config
        resolve: {
          handler: async (ctx): Promise<HookOutput<ResolveHookResult>> => {
            const { intent } = ctx;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths (not git URLs)
            if (git || !path) {
              return { result: {} };
            }

            // The record, if any: its remoteUrl restores a clone's ref and icon,
            // and its config is handed back as is, so the store finds the record.
            const record = await findRecord(path);
            const remoteUrl = record?.project.remoteUrl;
            const resolved = {
              projectPath: path,
              type: GIT_PROJECT_TYPE,
              config: record?.config ?? newLocalConfig(path),
              ...(remoteUrl !== undefined && { remoteUrl }),
            };

            // Already open — skip validation, signal short-circuit
            if (store.isOpen(path)) {
              return { result: { ...resolved, alreadyOpen: true } };
            }

            await gitWorktreeProvider.validateRepository(new Path(path));

            return { result: resolved };
          },
        },
      },

      [APP_READY_OPERATION_ID]: {
        // restore: reopen a saved git project by its path
        restore: {
          handler: async (ctx): Promise<HookOutput<RestoreProjectResult>> => {
            if (ctx.type !== GIT_PROJECT_TYPE) return { result: {} };
            const parsed = parseGitConfig(dirs(), ctx.config);
            if (!parsed) {
              logger.warn("Skipping a git project record without a usable path or URL");
              return { result: {} };
            }
            return { result: { payload: { path: parsed.path } } };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve: look up the record to get remoteUrl
        resolve: {
          handler: async (ctx): Promise<HookOutput<CloseResolveHookResult>> => {
            const remoteUrl = (await findRecord(ctx.projectPath))?.project.remoteUrl;
            return { result: remoteUrl !== undefined ? { remoteUrl } : {} };
          },
        },

        // close: clean up the project's own directories (the store removes its record)
        close: {
          handler: async (ctx): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx;

            if (removeLocalRepo && remoteUrl) {
              // Remote project with removeLocalRepo: force-delete its directories —
              // the worktrees' (path-named) and the record's (URL-named).
              const configDirs = new Set([
                projectDirName(projectPath),
                recordDirName(dirs(), projectPath, remoteUrl),
              ]);
              for (const dirName of configDirs) {
                try {
                  await fs.rm(new Path(projectsDir, dirName), {
                    recursive: true,
                    force: true,
                  });
                } catch {
                  // Fail silently
                }
              }
            } else {
              // Local project with removeLocalRepo: delete the user's own
              // working copy. The app-data dir still goes through the gentle
              // removal below — a workspaces dir left non-empty by a failed
              // worktree deletion is evidence worth keeping, not something to
              // force-rm away.
              if (removeLocalRepo) {
                await removeLocalDirectory(projectPath);
              }
              await removeWorkspacesDir(projectPath);
            }

            return { result: {} };
          },
        },
      },
    }),
  };
}
