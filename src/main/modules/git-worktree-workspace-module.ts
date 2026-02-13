/**
 * GitWorktreeWorkspaceModule - Manages workspace-related git worktree operations.
 *
 * Consolidates worktree lifecycle hooks across multiple operations:
 * - open-project: register project, discover workspaces, fire-and-forget cleanup
 * - close-project: unregister project, clear state
 * - create-workspace: create worktree or activate existing workspace
 * - delete-workspace: resolve workspace path, remove worktree
 * - switch-workspace: resolve workspace path
 * - get-workspace-status: resolve workspace path, check dirty status
 * - open-workspace: fetch bases and default base branch
 *
 * Uses GitWorktreeProvider directly (no ProjectScopedWorkspaceProvider adapter).
 * Maintains its own workspace state in closure-scoped maps.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import type { Workspace } from "../../services/git/types";
import type { PathProvider } from "../../services/platform/path-provider";
import type { Logger } from "../../services/logging/types";
import type { CreateWorkspaceIntent } from "../operations/create-workspace";
import type { CreateHookResult } from "../operations/create-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult } from "../operations/delete-workspace";
import type { DiscoverHookResult, DiscoverHookInput } from "../operations/open-project";
import type { CloseHookInput } from "../operations/close-project";
import type { GetStatusHookResult } from "../operations/get-workspace-status";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import { CREATE_WORKSPACE_OPERATION_ID } from "../operations/create-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import { extractWorkspaceName } from "../api/id-utils";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Hook Context Types (target architecture)
// =============================================================================

interface ResolveWorkspaceInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

interface GetStatusInput extends HookContext {
  readonly workspacePath: string;
}

interface FetchBasesInput extends HookContext {
  readonly projectPath: string;
}

// =============================================================================
// Hook Result Types
// =============================================================================

/** Result from the open-project "setup" hook point. */
export interface WorkspaceSetupHookResult {
  readonly workspaces: readonly Workspace[];
  readonly defaultBaseBranch?: string;
}

/** Result from the delete-workspace "resolve-workspace" hook point. */
interface ResolveWorkspaceResult {
  readonly workspacePath?: string;
}

/** Result from the open-workspace "fetch-bases" hook point. */
export interface FetchBasesHookResult {
  readonly bases: readonly { name: string; isRemote: boolean }[];
  readonly defaultBaseBranch?: string;
}

// =============================================================================
// Constants
// =============================================================================

const OPEN_WORKSPACE_OPERATION_ID = "open-workspace";

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a module that manages workspace-related git worktree operations.
 *
 * @param globalProvider - Global GitWorktreeProvider for all git operations
 * @param pathProvider - PathProvider for resolving workspace directories
 * @param logger - Logger for warnings and errors
 * @returns IntentModule with hook contributions
 */
export function createGitWorktreeWorkspaceModule(
  globalProvider: GitWorktreeProvider,
  pathProvider: PathProvider,
  logger: Logger
): IntentModule {
  // Internal state
  const registeredProjects = new Set<string>();
  const workspaces = new Map<string, Workspace[]>();

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  function resolveWorkspacePath(projectPath: string, workspaceName: string): string | undefined {
    const key = new Path(projectPath).toString();
    const projectWorkspaces = workspaces.get(key);
    if (!projectWorkspaces) return undefined;

    const found = projectWorkspaces.find(
      (w) => extractWorkspaceName(w.path.toString()) === workspaceName
    );
    return found?.path.toString();
  }

  function unregisterWorkspaceFromState(projectPath: string, workspacePath: string): void {
    const key = new Path(projectPath).toString();
    const projectWorkspaces = workspaces.get(key);
    if (!projectWorkspaces) return;

    const normalizedPath = new Path(workspacePath).toString();
    const index = projectWorkspaces.findIndex((w) => w.path.toString() === normalizedPath);
    if (index !== -1) {
      projectWorkspaces.splice(index, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Hook Handlers
  // ---------------------------------------------------------------------------

  return {
    hooks: {
      // open-project -> discover (renamed from "setup" in plan; using existing hook point name)
      [OPEN_PROJECT_OPERATION_ID]: {
        discover: {
          handler: async (ctx: HookContext): Promise<DiscoverHookResult> => {
            const { projectPath } = ctx as DiscoverHookInput;
            const projectPathObj = new Path(projectPath);
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPathObj);

            globalProvider.registerProject(projectPathObj, workspacesDir);
            const key = projectPathObj.toString();
            registeredProjects.add(key);

            const discovered = await globalProvider.discover(projectPathObj);
            workspaces.set(key, [...discovered]);

            // Fire-and-forget cleanup
            void globalProvider.cleanupOrphanedWorkspaces(projectPathObj).catch((err: unknown) => {
              logger.warn("Workspace cleanup failed", {
                projectPath,
                error: getErrorMessage(err),
              });
            });

            const defaultBaseBranch = await globalProvider.defaultBase(projectPathObj);

            return {
              workspaces: discovered,
              ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
            };
          },
        },
      },

      // close-project -> close
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<Record<string, never>> => {
            const { projectPath } = ctx as CloseHookInput;
            const projectPathObj = new Path(projectPath);

            globalProvider.unregisterProject(projectPathObj);
            const key = projectPathObj.toString();
            registeredProjects.delete(key);
            workspaces.delete(key);

            return {};
          },
        },
      },

      // create-workspace -> create
      [CREATE_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<CreateHookResult> => {
            const intent = ctx.intent as CreateWorkspaceIntent;
            const { payload } = intent;

            // Existing workspace path: populate from existing data, skip worktree creation
            if (payload.existingWorkspace) {
              const existing = payload.existingWorkspace;
              const workspacePath = existing.path;
              const branch = existing.branch ?? existing.name;
              const metadata = existing.metadata;
              const projectPath = payload.projectPath!;

              const key = new Path(projectPath).toString();
              const projectWorkspaces = workspaces.get(key) ?? [];

              // Avoid duplicates
              const normalizedPath = new Path(workspacePath).toString();
              const alreadyExists = projectWorkspaces.some(
                (w) => w.path.toString() === normalizedPath
              );

              if (!alreadyExists) {
                const ws: Workspace = {
                  name: existing.name,
                  path: new Path(workspacePath),
                  branch: existing.branch,
                  metadata,
                };
                projectWorkspaces.push(ws);
                workspaces.set(key, projectWorkspaces);
              }

              return { workspacePath, branch, metadata, projectPath };
            }

            // New workspace: create via provider
            if (!payload.projectPath) {
              throw new Error("projectPath is required for new workspace creation");
            }

            const projectPath = payload.projectPath;
            const projectPathObj = new Path(projectPath);

            const internalWorkspace = await globalProvider.createWorkspace(
              projectPathObj,
              payload.name,
              payload.base
            );

            // Update state
            const key = projectPathObj.toString();
            const projectWorkspaces = workspaces.get(key) ?? [];

            const normalizedPath = internalWorkspace.path.toString();
            const alreadyExists = projectWorkspaces.some(
              (w) => w.path.toString() === normalizedPath
            );

            if (!alreadyExists) {
              projectWorkspaces.push(internalWorkspace);
              workspaces.set(key, projectWorkspaces);
            }

            return {
              workspacePath: internalWorkspace.path.toString(),
              branch: internalWorkspace.branch ?? internalWorkspace.name,
              metadata: internalWorkspace.metadata,
              projectPath,
            };
          },
        },
      },

      // delete-workspace -> resolve-workspace + delete
      [DELETE_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceResult> => {
            const intent = ctx.intent as DeleteWorkspaceIntent;
            const { payload } = intent;
            const workspacePath = resolveWorkspacePath(payload.projectPath, payload.workspaceName);
            return workspacePath ? { workspacePath } : {};
          },
        },
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const intent = ctx.intent as DeleteWorkspaceIntent;
            const { payload } = intent;

            if (payload.removeWorktree) {
              try {
                await globalProvider.removeWorkspace(
                  new Path(payload.projectPath),
                  new Path(payload.workspacePath),
                  !payload.keepBranch
                );
              } catch (error) {
                if (payload.force) {
                  logger.warn("WorktreeModule: error in force mode (ignored)", {
                    error: getErrorMessage(error),
                  });
                  unregisterWorkspaceFromState(payload.projectPath, payload.workspacePath);
                  return { error: getErrorMessage(error) };
                }
                throw error;
              }
            }

            unregisterWorkspaceFromState(payload.projectPath, payload.workspacePath);
            return {};
          },
        },
      },

      // switch-workspace -> resolve-workspace
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceResult> => {
            const { projectPath, workspaceName } = ctx as ResolveWorkspaceInput;
            const workspacePath = resolveWorkspacePath(projectPath, workspaceName);
            return workspacePath ? { workspacePath } : {};
          },
        },
      },

      // get-workspace-status -> resolve-workspace + get
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceResult> => {
            const { projectPath, workspaceName } = ctx as ResolveWorkspaceInput;
            const workspacePath = resolveWorkspacePath(projectPath, workspaceName);
            return workspacePath ? { workspacePath } : {};
          },
        },
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusInput;
            const isDirty = await globalProvider.isDirty(new Path(workspacePath));
            return { isDirty };
          },
        },
      },

      // open-workspace -> fetch-bases
      [OPEN_WORKSPACE_OPERATION_ID]: {
        "fetch-bases": {
          handler: async (ctx: HookContext): Promise<FetchBasesHookResult> => {
            const { projectPath } = ctx as FetchBasesInput;
            const projectPathObj = new Path(projectPath);

            const bases = await globalProvider.listBases(projectPathObj);
            const defaultBaseBranch = await globalProvider.defaultBase(projectPathObj);

            return {
              bases,
              ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
            };
          },
        },
      },
    },
  };
}
