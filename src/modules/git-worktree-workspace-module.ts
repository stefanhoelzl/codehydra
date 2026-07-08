/**
 * GitWorktreeWorkspaceModule - Manages workspace-related git worktree operations.
 *
 * Consolidates worktree lifecycle hooks across multiple operations:
 * - resolve-workspace: shared workspace resolution (workspacePath → projectPath + workspaceName)
 * - open-project: register project, discover workspaces, fire-and-forget cleanup
 * - close-project: unregister project, clear state
 * - open-workspace: resolve caller, create worktree
 * - get-project-bases: list bases (local read), refresh bases (git fetch)
 * - delete-workspace: remove worktree
 * - switch-workspace: find candidates
 * - get-workspace-status: check dirty status
 * - list-projects: list workspaces per project
 *
 * Uses GitWorktreeProvider directly (no ProjectScopedWorkspaceProvider adapter).
 * Maintains its own workspace state in closure-scoped maps.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import type { Workspace } from "../boundaries/platform/git-types";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { Logger } from "../boundaries/platform/logging-types";
import type { WorkspaceName } from "../shared/api/types";
import type {
  OpenWorkspaceIntent,
  CreateHookInput,
  CreateHookResult,
} from "../intents/open-workspace";
import { OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import type {
  ListBasesHookInput,
  ListBasesHookResult,
  RefreshBasesHookInput,
} from "../intents/get-project-bases";
import { GET_PROJECT_BASES_OPERATION_ID } from "../intents/get-project-bases";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import type {
  DeleteHookResult,
  DeletePipelineHookInput,
  PreflightHookResult,
} from "../intents/delete-workspace";
import type { DiscoverHookResult, DiscoverHookInput } from "../intents/open-project";
import type {
  CloseHookInput,
  CloseResolveHookResult,
  CloseProjectIntent,
} from "../intents/close-project";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../intents/close-project";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../intents/switch-workspace";
import type { FindCandidatesHookResult } from "../intents/switch-workspace";
import { HIBERNATED_METADATA_KEY } from "../intents/hibernate-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  type GetStatusHookInput,
  type GetStatusHookResult,
} from "../intents/get-workspace-status";
import {
  LIST_PROJECTS_OPERATION_ID,
  type ListWorkspacesHookResult,
  type ListWorkspacesHookEntry,
} from "../intents/list-projects";
import { Path } from "../utils/path/path";
import { getErrorMessage, WorkspaceError } from "../shared/errors/service-errors";
import type { DomainEvent } from "../intents/lib/types";
import { EVENT_METADATA_CHANGED, type MetadataChangedEvent } from "../intents/set-metadata";

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a module that manages workspace-related git worktree operations.
 *
 * @param gitWorktreeProvider - Global GitWorktreeProvider for all git operations
 * @param pathProvider - PathProvider for resolving workspace directories
 * @param logger - Logger for warnings and errors
 * @returns IntentModule with hook contributions
 */
export function createGitWorktreeWorkspaceModule(
  gitWorktreeProvider: GitWorktreeProvider,
  pathProvider: PathProvider,
  logger: Logger
): IntentModule {
  // Internal state
  const workspaces = new Map<string, Workspace[]>();
  const deletionPending = new Map<string, { projectPath: string; workspace: Workspace }>();
  // Per-project default base branch, computed at project:open (discover) and
  // refreshed by the get-project-bases list hook. Surfaced via list-workspaces
  // so the creation form can seed the base field without a git round-trip.
  const projectDefaults = new Map<string, string>();

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
        branch: string | null;
      }
    | undefined {
    const normalizedPath = new Path(workspacePath).toString();

    for (const [projectKey, wsList] of getMergedWorkspaces()) {
      for (const ws of wsList) {
        if (ws.path.toString() === normalizedPath) {
          return {
            projectPath: projectKey,
            // The stored name, NOT the basename of ws.path: Path lowercases
            // on Windows, so a path-derived name breaks the renderer's
            // case-sensitive name matching for uppercase workspace names.
            workspaceName: ws.name as WorkspaceName,
            branch: ws.branch,
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

  function addToDeletionPending(projectPath: string, workspacePath: string): void {
    const key = new Path(projectPath).toString();
    const normalizedWsPath = new Path(workspacePath).toString();
    const wsList = workspaces.get(key);
    if (!wsList) return;
    const ws = wsList.find((w) => w.path.toString() === normalizedWsPath);
    if (!ws) return;
    deletionPending.set(normalizedWsPath, { projectPath: key, workspace: ws });
  }

  function removeFromDeletionPending(workspacePath: string): void {
    const normalizedWsPath = new Path(workspacePath).toString();
    deletionPending.delete(normalizedWsPath);
  }

  /**
   * Returns the full workspace list: git cache merged with deletion-pending entries.
   * This is the single source of truth for resolve/list/find-candidates consumers.
   */
  function getMergedWorkspaces(): Map<string, Workspace[]> {
    const merged = new Map<string, Workspace[]>();
    const seen = new Set<string>();

    for (const [key, wsList] of workspaces) {
      merged.set(key, [...wsList]);
      for (const ws of wsList) seen.add(ws.path.toString());
    }

    for (const [wsPath, entry] of deletionPending) {
      if (seen.has(wsPath)) continue;
      const list = merged.get(entry.projectPath) ?? [];
      list.push(entry.workspace);
      merged.set(entry.projectPath, list);
    }

    return merged;
  }

  // ---------------------------------------------------------------------------
  // Hook Handlers
  // ---------------------------------------------------------------------------

  return {
    name: "git-worktree",
    hooks: {
      // resolve-workspace -> resolve (single registration replaces 8 per-operation hooks)
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<ResolveHookResult>> => {
            const { workspacePath } = ctx as ResolveHookInput;
            const resolved = resolveFromWorkspacePath(workspacePath);
            return { result: resolved ?? {} };
          },
        },
      },

      // open-project -> discover
      [OPEN_PROJECT_OPERATION_ID]: {
        discover: {
          handler: async (ctx: HookContext): Promise<HookOutput<DiscoverHookResult>> => {
            const { projectPath } = ctx as DiscoverHookInput;
            const projectPathObj = new Path(projectPath);
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPathObj);

            gitWorktreeProvider.registerProject(projectPathObj, workspacesDir);
            const key = projectPathObj.toString();

            const discovered = await gitWorktreeProvider.discover(projectPathObj);
            workspaces.set(key, [...discovered]);

            // Fire-and-forget cleanup
            void gitWorktreeProvider
              .cleanupOrphanedWorkspaces(projectPathObj)
              .catch((err: unknown) => {
                logger.warn("Workspace cleanup failed", {
                  projectPath,
                  error: getErrorMessage(err),
                });
              });

            const defaultBaseBranch = await gitWorktreeProvider.defaultBase(projectPathObj);
            if (defaultBaseBranch !== undefined) {
              projectDefaults.set(key, defaultBaseBranch);
            }

            return {
              result: {
                workspaces: discovered,
                ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
              },
            };
          },
        },
      },

      // close-project -> resolve + close
      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve: contribute the project's workspace list. The operation
        // tears each down (runtime teardown), upgrades to full deletion on a
        // confirmed removeAll, and the confirm dialog shows the count.
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseResolveHookResult>> => {
            const intent = ctx.intent as CloseProjectIntent;
            const key = new Path(intent.payload.projectPath).toString();
            const list = workspaces.get(key) ?? [];
            // IPC-shaped contract: paths cross the hook boundary as strings.
            return {
              result: {
                workspaces: list.map((workspace) => ({ path: workspace.path.toString() })),
              },
            };
          },
        },
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<Record<string, never>>> => {
            const { projectPath } = ctx as CloseHookInput;
            const projectPathObj = new Path(projectPath);

            gitWorktreeProvider.unregisterProject(projectPathObj);
            const key = projectPathObj.toString();
            workspaces.delete(key);
            projectDefaults.delete(key);

            // Clear deletion-pending entries for this project
            for (const [wsPath, entry] of deletionPending) {
              if (entry.projectPath === key) {
                deletionPending.delete(wsPath);
              }
            }

            return { result: {} };
          },
        },
      },

      // open-workspace -> create
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<HookOutput<CreateHookResult>> => {
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

              return {
                result: {
                  workspacePath,
                  branch,
                  metadata,
                  ...(payload.base !== undefined && { resolvedBase: payload.base }),
                },
              };
            }

            // New workspace: create via provider
            const projectPathObj = new Path(projectPath);

            // Resolve base: explicit or default
            const base = payload.base ?? (await gitWorktreeProvider.defaultBase(projectPathObj));
            if (!base) {
              throw new WorkspaceError(
                "No base branch specified and no default branch could be detected"
              );
            }

            let internalWorkspace;
            try {
              internalWorkspace = await gitWorktreeProvider.createWorkspace(
                projectPathObj,
                payload.workspaceName!,
                base,
                payload.tracking
              );
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              throw new WorkspaceError(`${message} (base: '${base}')`);
            }

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
              result: {
                workspacePath: internalWorkspace.path.toString(),
                branch: internalWorkspace.branch ?? internalWorkspace.name,
                metadata: internalWorkspace.metadata,
                resolvedBase: base,
              },
            };
          },
        },
      },

      // get-project-bases -> list + refresh
      [GET_PROJECT_BASES_OPERATION_ID]: {
        list: {
          handler: async (ctx: HookContext): Promise<HookOutput<ListBasesHookResult>> => {
            const { projectPath } = ctx as ListBasesHookInput;
            const projectPathObj = new Path(projectPath);

            // Enumerate once and reuse for the default (avoids a second full
            // branch enumeration inside defaultBase).
            const bases = await gitWorktreeProvider.listBases(projectPathObj);
            const defaultBaseBranch = await gitWorktreeProvider.defaultBase(projectPathObj, bases);
            if (defaultBaseBranch !== undefined) {
              projectDefaults.set(projectPathObj.toString(), defaultBaseBranch);
            }

            return {
              result: {
                bases,
                ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
              },
            };
          },
        },
        refresh: {
          handler: async (ctx: HookContext): Promise<void> => {
            const { projectPath } = ctx as RefreshBasesHookInput;
            await gitWorktreeProvider.updateBases(new Path(projectPath));
          },
        },
      },

      // delete-workspace -> preflight + delete (resolve hook removed, now uses resolve-workspace dispatch)
      [DELETE_WORKSPACE_OPERATION_ID]: {
        preflight: {
          handler: async (ctx: HookContext): Promise<HookOutput<PreflightHookResult>> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            try {
              const isDirty = await gitWorktreeProvider.isDirty(new Path(wsPath));
              const unmergedCommits = await gitWorktreeProvider.countUnmergedCommits(
                new Path(wsPath)
              );
              return { result: { isDirty, unmergedCommits } };
            } catch (error) {
              return { result: { error: getErrorMessage(error) } };
            }
          },
        },
        delete: {
          handler: async (ctx: HookContext): Promise<HookOutput<DeleteHookResult>> => {
            const { projectPath, workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.removeWorktree) {
              // Snapshot workspace into deletionPending before removal attempt
              addToDeletionPending(projectPath, wsPath);

              try {
                await gitWorktreeProvider.removeWorkspace(
                  new Path(projectPath),
                  new Path(wsPath),
                  !payload.keepBranch
                );
              } catch (error) {
                if (payload.force) {
                  logger.warn("WorktreeModule: error in force mode (ignored)", {
                    error: getErrorMessage(error),
                  });
                  // Dismiss: remove from both maps
                  removeFromDeletionPending(wsPath);
                  unregisterWorkspaceFromState(projectPath, wsPath);
                }
                // Non-force: workspace stays in deletionPending for resolve/list
                return { result: { error: getErrorMessage(error) } };
              }

              // Success: clean up deletionPending
              removeFromDeletionPending(wsPath);
            }

            unregisterWorkspaceFromState(projectPath, wsPath);
            return { result: {} };
          },
        },
      },

      // switch-workspace -> find-candidates (resolve hook removed)
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<HookOutput<FindCandidatesHookResult>> => {
            const candidates: Array<{
              projectPath: string;
              projectName: string;
              workspacePath: string;
              workspaceName: string;
              hibernated?: boolean;
            }> = [];
            for (const [key, wsList] of getMergedWorkspaces()) {
              const projectName = new Path(key).basename;
              for (const ws of wsList) {
                const hibernated = ws.metadata[HIBERNATED_METADATA_KEY] === "true";
                candidates.push({
                  projectPath: key,
                  projectName,
                  workspacePath: ws.path.toString(),
                  workspaceName: ws.name,
                  ...(hibernated && { hibernated: true }),
                });
              }
            }
            return { result: { candidates } };
          },
        },
      },

      // get-workspace-status -> get (resolve hook removed)
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<HookOutput<GetStatusHookResult>> => {
            const { workspacePath: wsPath } = ctx as GetStatusHookInput;
            const isDirty = await gitWorktreeProvider.isDirty(new Path(wsPath));
            const unmergedCommits = await gitWorktreeProvider.countUnmergedCommits(
              new Path(wsPath)
            );
            return { result: { isDirty, unmergedCommits } };
          },
        },
      },

      // list-projects -> list-workspaces
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-workspaces": {
          handler: async (): Promise<HookOutput<ListWorkspacesHookResult>> => {
            const entries: ListWorkspacesHookEntry[] = [];
            for (const [key, wsList] of getMergedWorkspaces()) {
              const defaultBaseBranch = projectDefaults.get(key);
              entries.push({
                projectPath: key,
                workspaces: wsList,
                ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
              });
            }
            return { result: { entries } };
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Domain Event Subscriptions
    // -------------------------------------------------------------------------

    events: {
      [EVENT_METADATA_CHANGED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath, key, value } = (event as MetadataChangedEvent).payload;

          for (const [projectKey, wsList] of workspaces) {
            const index = wsList.findIndex((ws) => ws.path.toString() === workspacePath);
            if (index === -1) continue;

            const ws = wsList[index]!;
            const updatedMetadata =
              value !== null
                ? { ...ws.metadata, [key]: value }
                : Object.fromEntries(Object.entries(ws.metadata).filter(([k]) => k !== key));

            wsList[index] = {
              name: ws.name,
              path: ws.path,
              branch: ws.branch,
              metadata: updatedMetadata,
            };

            // Each workspace path is unique — no need to continue searching
            workspaces.set(projectKey, wsList);
            return;
          }
        },
      },
    },
  };
}
