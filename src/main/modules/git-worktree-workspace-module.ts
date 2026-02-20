/**
 * GitWorktreeWorkspaceModule - Manages workspace-related git worktree operations.
 *
 * Consolidates worktree lifecycle hooks across multiple operations:
 * - resolve-workspace: shared workspace resolution (workspacePath → projectPath + workspaceName)
 * - open-project: register project, discover workspaces, fire-and-forget cleanup
 * - close-project: unregister project, clear state
 * - open-workspace: resolve caller, create worktree, fetch bases
 * - delete-workspace: remove worktree
 * - switch-workspace: find candidates
 * - get-workspace-status: check dirty status
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
import type { WorkspaceName } from "../../shared/api/types";
import type {
  OpenWorkspaceIntent,
  CreateHookInput,
  CreateHookResult,
  ResolveCallerHookInput,
  ResolveCallerHookResult,
} from "../operations/open-workspace";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import type { DiscoverHookResult, DiscoverHookInput } from "../operations/open-project";
import type { CloseHookInput } from "../operations/close-project";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import type { FindCandidatesHookResult } from "../operations/switch-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../operations/resolve-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  type GetStatusHookInput,
  type GetStatusHookResult,
} from "../operations/get-workspace-status";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Hook Context Types
// =============================================================================

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

/** Result from the open-workspace "fetch-bases" hook point. */
export interface FetchBasesHookResult {
  readonly bases: readonly { name: string; isRemote: boolean }[];
  readonly defaultBaseBranch?: string;
}

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

  /**
   * Shared reverse-lookup: workspacePath → (projectPath, workspaceName).
   * Used by the resolve-workspace operation.
   */
  function resolveFromWorkspacePath(workspacePath: string):
    | {
        projectPath: string;
        workspaceName: WorkspaceName;
      }
    | undefined {
    const normalizedPath = new Path(workspacePath).toString();

    for (const [projectKey, wsList] of workspaces) {
      for (const ws of wsList) {
        if (ws.path.toString() === normalizedPath) {
          return {
            projectPath: projectKey,
            workspaceName: extractWorkspaceName(ws.path.toString()),
          };
        }
      }
    }

    return undefined;
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
      // resolve-workspace -> resolve (single registration replaces 8 per-operation hooks)
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath } = ctx as ResolveHookInput;
            const resolved = resolveFromWorkspacePath(workspacePath);
            return resolved ?? {};
          },
        },
      },

      // open-project -> discover
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

      // open-workspace -> resolve-caller + create + fetch-bases
      [OPEN_WORKSPACE_OPERATION_ID]: {
        "resolve-caller": {
          handler: async (ctx: HookContext): Promise<ResolveCallerHookResult> => {
            const { callerWorkspacePath } = ctx as ResolveCallerHookInput;
            const result = resolveFromWorkspacePath(callerWorkspacePath);
            if (!result) return {};
            return { projectPath: result.projectPath, workspaceName: result.workspaceName };
          },
        },
        create: {
          handler: async (ctx: HookContext): Promise<CreateHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { payload } = intent;
            const { projectPath } = ctx as CreateHookInput;

            // Existing workspace path: populate from existing data, skip worktree creation
            if (payload.existingWorkspace) {
              const existing = payload.existingWorkspace;
              const workspacePath = existing.path;
              const branch = existing.branch ?? existing.name;
              const metadata = existing.metadata;

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

              return { workspacePath, branch, metadata };
            }

            // New workspace: create via provider
            const projectPathObj = new Path(projectPath);

            const internalWorkspace = await globalProvider.createWorkspace(
              projectPathObj,
              payload.workspaceName!,
              payload.base!
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
            };
          },
        },

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

      // delete-workspace -> delete (resolve hook removed, now uses resolve-workspace dispatch)
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { projectPath, workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.removeWorktree) {
              try {
                await globalProvider.removeWorkspace(
                  new Path(projectPath),
                  new Path(wsPath),
                  !payload.keepBranch
                );
              } catch (error) {
                if (payload.force) {
                  logger.warn("WorktreeModule: error in force mode (ignored)", {
                    error: getErrorMessage(error),
                  });
                  unregisterWorkspaceFromState(projectPath, wsPath);
                  return { error: getErrorMessage(error) };
                }
                throw error;
              }
            }

            unregisterWorkspaceFromState(projectPath, wsPath);
            return {};
          },
        },
      },

      // switch-workspace -> find-candidates (resolve hook removed)
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<FindCandidatesHookResult> => {
            const candidates: Array<{
              projectPath: string;
              projectName: string;
              workspacePath: string;
            }> = [];
            for (const [key, wsList] of workspaces) {
              const projectName = new Path(key).basename;
              for (const ws of wsList) {
                candidates.push({
                  projectPath: key,
                  projectName,
                  workspacePath: ws.path.toString(),
                });
              }
            }
            return { candidates };
          },
        },
      },

      // get-workspace-status -> get (resolve hook removed)
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath: wsPath } = ctx as GetStatusHookInput;
            const isDirty = await globalProvider.isDirty(new Path(wsPath));
            return { isDirty };
          },
        },
      },
    },
  };
}
