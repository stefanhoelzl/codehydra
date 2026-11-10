/**
 * GitProjectModule - The git project type: every git contribution, as one module.
 *
 * Core owns what is the same for every type: project records (project-store-module),
 * the workspace registry and metadata (workspace-registry-module), refs
 * (`src/utils/ref.ts`). This module adds what is git's, and nothing else — a
 * second project type is one more module of the same shape (see
 * `fake-project-type.test-utils.ts`).
 *
 * A git project is opened from a local path (`{ path }`) or a URL (`{ git }`);
 * local and cloned differ only in the record config (`{ path }`, `{ remoteUrl }`
 * or `{ path, remoteUrl }`, see records.ts). Its workspaces are its worktrees.
 *
 * Every hook point is shared by every project type, so each handler first
 * selects itself: on the open request's payload before the project has a type,
 * on the project's type (its ref, or the record's `type`) after.
 *
 * Hook registrations:
 * - project:open        → prepare:   offer git init (local path), then the worktree picker (interactive add)
 * - project:open        → resolve:   a local path's record and `.git` check, or a URL's clone
 * - project:open        → discover:  the project's worktrees, told to the registry
 * - app:ready           → restore:   a saved git project → the project:open payload { path }
 * - project:close       → resolve:   the remoteUrl on the project's record
 * - project:close       → close:     unregister the project; remove its app-data directories,
 *                                    and with removeLocalRepo its checkout or clone
 * - workspace:open      → create:    create a worktree, or reopen a discovered one
 * - app:start           → register-project-types: git's create/delete options (options.ts)
 * - project:get-option-choices → list: the branches, as `base` choices and name suggestions
 * - project:refresh     → refresh:   fetch
 * - project:list-add-actions / project:add → the "Clone from Git" button and its dialog
 * - workspace:delete    → preflight: uncommitted changes, unmerged commits
 * - workspace:delete    → delete:    remove the worktree
 * - workspace:get-status → get:      status (clean|dirty|unmerged|dirty-unmerged) and its description
 * - list-projects       → list-workspaces: each project's default base branch
 */

import type { IntentModule } from "../../intents/lib/module";
import type { HookOutput } from "../../intents/lib/operation";
import type { ProjectRef } from "../../intents/contract";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging";
import type { GitWorktreeProvider } from "../../boundaries/platform/git-worktree-provider";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { defineEvents, defineHooks } from "../../intents/declarations";
import {
  EVENT_CLONE_PROGRESS,
  OPEN_PROJECT_OPERATION_ID,
  type CloneProgressFrame,
  type ResolveHookResult,
} from "../../intents/open-project";
import { APP_READY_OPERATION_ID } from "../../intents/app-ready";
import { CLOSE_PROJECT_OPERATION_ID } from "../../intents/close-project";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import { GET_OPTION_CHOICES_OPERATION_ID } from "../../intents/get-option-choices";
import { REFRESH_PROJECT_OPERATION_ID } from "../../intents/refresh-project";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { ADD_PROJECT_OPERATION_ID, LIST_ADD_ACTIONS_OPERATION_ID } from "../../intents/add-project";
import type { AppBoundary } from "../../boundaries/shell/app";
import { GIT_PROJECT_OPTIONS } from "./options";
import { CLONE_ACTION_ID, createCloneDialog } from "./clone-dialog";
import { DELETE_WORKSPACE_OPERATION_ID } from "../../intents/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../../intents/get-workspace-status";
import { LIST_PROJECTS_OPERATION_ID } from "../../intents/list-projects";
import { projectRefOf } from "../../utils/ref";
import type { UiPresenter } from "../presentation/presentation-module";
import type { WorkspacesRoot } from "../workspaces-root/workspaces-root";
import type { ProjectStoreModule } from "../project-store-module";
import { REQUIRES_FREE_NAME, type WorkspaceRegistry } from "../workspace-registry-module";
import { GIT_PROJECT_TYPE, isGitProject } from "./ref";
import { createGitProjects } from "./project";
import { createGitClones } from "./clone";
import { createGitWorktrees } from "./worktrees";
import { createWorktreePicker } from "./worktree-picker";

export interface GitProjectModuleDeps {
  /** Where project records live (`<dataRoot>/projects`). */
  readonly projectsDir: string;
  /** Where managed clones and worktrees live; settled at startup. */
  readonly workspacesRoot: Pick<
    WorkspacesRoot,
    "remotesDir" | "workspacesDir" | "previousWorkspacesDirs"
  >;
  readonly fs: Pick<FileSystemBoundary, "readdir" | "rm">;
  readonly store: Pick<ProjectStoreModule, "records" | "isOpen">;
  readonly registry: WorkspaceRegistry;
  readonly gitWorktreeProvider: GitWorktreeProvider;
  readonly gitClient: Pick<IGitClient, "isRepositoryRoot" | "init" | "clone">;
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** Opens GitHub's "new repository" page from the clone dialog. */
  readonly appBoundary: Pick<AppBoundary, "openUrl">;
  /** Logs project open, clone and close. */
  readonly logger: Logger;
  /** Logs worktree discovery, adoption, removal and status. */
  readonly workspaceLogger: Logger;
}

/** The git module, plus what it knows of every git project with a record. */
export interface GitProjectModule extends IntentModule {
  /**
   * The ref of every git project with a record, by its normalized path — open
   * or not. For a migration turning stored project paths into refs, which needs
   * to know whether each one was cloned (named by its origin) or is a checkout.
   */
  projectRefs(): Promise<ReadonlyMap<string, ProjectRef>>;
}

export function createGitProjectModule(deps: GitProjectModuleDeps): GitProjectModule {
  const { workspacesRoot, fs, gitClient, dispatcher, logger } = deps;

  const projects = createGitProjects({
    projectsDir: deps.projectsDir,
    remotesDir: () => workspacesRoot.remotesDir().toString(),
    fs,
    store: deps.store,
    gitWorktreeProvider: deps.gitWorktreeProvider,
    ui: deps.ui,
    dispatcher,
    gitClient,
    logger,
  });
  const clones = createGitClones({
    fs,
    gitClient,
    remotesDir: () => workspacesRoot.remotesDir(),
    logger,
    dispatcher,
  });
  const worktrees = createGitWorktrees({
    gitWorktreeProvider: deps.gitWorktreeProvider,
    workspacesRoot,
    logger: deps.workspaceLogger,
    pickWorktrees: createWorktreePicker(deps.ui),
    dispatcher,
    registry: deps.registry,
  });
  const cloneDialog = createCloneDialog({
    ui: deps.ui,
    dispatcher,
    appBoundary: deps.appBoundary,
    logger,
  });

  return {
    name: "git",
    projectRefs: () => projects.projectRefs(),
    events: defineEvents({
      [EVENT_CLONE_PROGRESS]: {
        handler: async (event): Promise<void> => {
          cloneDialog.progress(event.payload);
        },
      },
    }),
    hooks: defineHooks({
      [OPEN_PROJECT_OPERATION_ID]: {
        // A directory that is no repository yet gets the git-init offer first; only
        // then can it have worktrees to offer. Canceling either cancels the open.
        prepare: {
          handler: async (ctx) => {
            const init = await projects.offerInit(ctx.intent.payload);
            if (init.canceled) return { result: init };
            return { result: await worktrees.offerWorktrees(ctx.intent.payload) };
          },
        },

        // Streams clone progress for a URL; the open-project operation adds the url
        // and emits clone:progress.
        resolve: {
          handler: async function* (
            ctx
          ): AsyncGenerator<CloneProgressFrame, HookOutput<ResolveHookResult>, void> {
            const { path, git } = ctx.intent.payload;
            if (git) return { result: yield* clones.resolveUrl(git) };
            if (path) return { result: await projects.resolveLocal(path) };
            return {};
          },
        },

        discover: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return {};
            return { result: await worktrees.discover(ctx) };
          },
        },
      },

      [APP_READY_OPERATION_ID]: {
        restore: {
          handler: async (ctx) => {
            if (ctx.type !== GIT_PROJECT_TYPE) return { result: {} };
            return { result: projects.restore(ctx.config) };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return { result: {} };
            const remoteUrl = await projects.remoteUrlOf(ctx.projectPath);
            return { result: remoteUrl !== undefined ? { remoteUrl } : {} };
          },
        },

        // The registry forgets the workspaces and the store removes the record;
        // git lets go of the project and removes only its own files.
        close: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return { result: {} };
            worktrees.forget(ctx.projectPath);
            await projects.removeDirectories(ctx);
            if (ctx.removeLocalRepo && ctx.remoteUrl) {
              await clones.removeClone(ctx.projectPath);
            }
            return { result: {} };
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          // After the registry checked a fresh name is free.
          requires: REQUIRES_FREE_NAME,
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return {};
            return { result: await worktrees.create(ctx, ctx.intent.payload) };
          },
        },
      },

      // What a git project lets a caller choose: describes the type, not a
      // project, so it answers for every startup without selecting itself.
      [APP_START_OPERATION_ID]: {
        "register-project-types": {
          handler: async () => ({ result: GIT_PROJECT_OPTIONS }),
        },
      },

      [GET_OPTION_CHOICES_OPERATION_ID]: {
        list: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return {};
            return { result: await worktrees.listChoices(ctx.projectPath, ctx.fresh) };
          },
        },
      },

      [REFRESH_PROJECT_OPERATION_ID]: {
        refresh: {
          handler: async (ctx): Promise<void> => {
            if (!isGitProject(ctx.projectRef)) return;
            await worktrees.refreshBases(ctx.projectPath);
          },
        },
      },

      // The New workspace form's "Clone from Git" button.
      [LIST_ADD_ACTIONS_OPERATION_ID]: {
        list: {
          handler: async () => ({
            result: {
              actions: [{ id: CLONE_ACTION_ID, icon: "source-control", title: "Clone from Git" }],
            },
          }),
        },
      },
      [ADD_PROJECT_OPERATION_ID]: {
        run: {
          handler: async (ctx) => {
            if (ctx.intent.payload.action !== CLONE_ACTION_ID) return {};
            return { result: { project: await cloneDialog.run() } };
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        preflight: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return {};
            return { result: await worktrees.preflight(ctx, ctx.intent.payload) };
          },
        },
        delete: {
          handler: async (ctx) => {
            if (!isGitProject(ctx.projectRef)) return {};
            return { result: await worktrees.remove(ctx, ctx.intent.payload) };
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx) => {
            if (!isGitProject(projectRefOf(ctx.workspaceRef))) return {};
            return { result: await worktrees.status(ctx) };
          },
        },
      },

      // The workspaces come from the registry; the operation merges entries by path.
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-workspaces": {
          handler: async () => ({ result: worktrees.defaultBases() }),
        },
      },
    }),
  };
}
