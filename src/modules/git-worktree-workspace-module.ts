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
import type { UnmanagedWorktree, Workspace } from "../boundaries/platform/git-types";
import type { UiPresenter } from "./presentation/presentation-module";
import type { DialogSection } from "../shared/dialog-types";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { Logger } from "../boundaries/platform/logging-types";
import type { WorkspaceName } from "../shared/api/types";
import type {
  OpenWorkspaceIntent,
  CreateHookInput,
  CreateHookResult,
  FinalizeHookInput,
  FinalizeHookResult,
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
import type {
  DiscoverHookResult,
  DiscoverHookInput,
  OpenProjectIntent,
  PrepareHookResult,
} from "../intents/open-project";
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
import { projectPathSchema, workspacePathSchema } from "../intents/contract";
import type { ProjectPath, WorkspacePath } from "../intents/contract";
import { toDiscoveredWorkspaces } from "../utils/workspace-conversion";

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a module that manages workspace-related git worktree operations.
 *
 * @param gitWorktreeProvider - Global GitWorktreeProvider for all git operations
 * @param pathProvider - PathProvider for resolving workspace directories
 * @param logger - Logger for warnings and errors
 * @param ui - Presenter for the add-project worktree picker and its failure notice
 * @returns IntentModule with hook contributions
 */
export function createGitWorktreeWorkspaceModule(
  gitWorktreeProvider: GitWorktreeProvider,
  pathProvider: PathProvider,
  logger: Logger,
  ui: Pick<UiPresenter, "dialog" | "notification">
): IntentModule {
  // Internal state
  // Keyed by branded paths: these maps feed hook results directly, so keeping the brand on
  // the key means a project/workspace path never has to be re-minted on the way out.
  const workspaces = new Map<ProjectPath, Workspace[]>();
  const deletionPending = new Map<
    WorkspacePath,
    { projectPath: ProjectPath; workspace: Workspace }
  >();
  // Per-project default base branch, computed at project:open (discover) and
  // refreshed by the get-project-bases list hook. Surfaced via list-workspaces
  // so the creation form can seed the base field without a git round-trip.
  const projectDefaults = new Map<ProjectPath, string>();

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalize a path and keep its brand. `new Path(p).toString()` is how this module
   * canonicalizes its map keys, but it returns a plain string — parsing re-mints the brand so
   * a key can go straight back onto a hook result without a cast.
   */
  const projectKey = (p: string): ProjectPath => projectPathSchema.parse(new Path(p).toString());
  const workspaceKey = (p: string): WorkspacePath =>
    workspacePathSchema.parse(new Path(p).toString());

  /**
   * True when `candidate` is the workspace at `workspaceRoot`, or lies inside it.
   *
   * The separator check is what stops `/repo/wt/feature` claiming a sibling
   * called `/repo/wt/feature-2`, which a bare `startsWith` would.
   */
  function isWithin(candidate: string, workspaceRoot: string): boolean {
    return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}/`);
  }

  /**
   * Shared reverse-lookup: a path → (projectPath, workspaceName).
   * Used by the resolve-workspace operation.
   *
   * Matches the deepest workspace containing the path rather than requiring the
   * workspace root exactly, so a caller that only knows its working directory —
   * the `ch` CLI, run from anywhere inside a worktree — resolves the same way a
   * caller holding the root does. An exact match is the longest possible one, so
   * it still wins; nesting resolves to the innermost workspace.
   */
  function resolveFromWorkspacePath(workspacePath: WorkspacePath):
    | {
        projectPath: ProjectPath;
        workspaceName: WorkspaceName;
        branch: string | null;
        metadata: Readonly<Record<string, string>>;
      }
    | undefined {
    const normalizedPath = new Path(workspacePath).toString();

    let best:
      | {
          projectPath: ProjectPath;
          workspaceName: WorkspaceName;
          branch: string | null;
          metadata: Readonly<Record<string, string>>;
          rootLength: number;
        }
      | undefined;

    for (const [projectKey, wsList] of getMergedWorkspaces()) {
      for (const ws of wsList) {
        const root = ws.path.toString();
        if (!isWithin(normalizedPath, root)) continue;
        if (best !== undefined && root.length <= best.rootLength) continue;

        best = {
          projectPath: projectKey,
          // The stored name, NOT the basename of ws.path: Path lowercases
          // on Windows, so a path-derived name breaks the renderer's
          // case-sensitive name matching for uppercase workspace names.
          workspaceName: ws.name as WorkspaceName,
          branch: ws.branch,
          metadata: ws.metadata,
          rootLength: root.length,
        };
      }
    }

    if (best === undefined) return undefined;
    return {
      projectPath: best.projectPath,
      workspaceName: best.workspaceName,
      branch: best.branch,
      metadata: best.metadata,
    };
  }

  function unregisterWorkspaceFromState(
    projectPath: ProjectPath,
    workspacePath: WorkspacePath
  ): void {
    const key = projectKey(projectPath);
    const projectWorkspaces = workspaces.get(key);
    if (!projectWorkspaces) return;

    const normalizedPath = new Path(workspacePath).toString();
    const index = projectWorkspaces.findIndex((w) => w.path.toString() === normalizedPath);
    if (index !== -1) {
      projectWorkspaces.splice(index, 1);
    }
  }

  function addToDeletionPending(projectPath: ProjectPath, workspacePath: WorkspacePath): void {
    const key = projectKey(projectPath);
    const normalizedWsPath = workspaceKey(workspacePath);
    const wsList = workspaces.get(key);
    if (!wsList) return;
    const ws = wsList.find((w) => w.path.toString() === normalizedWsPath);
    if (!ws) return;
    deletionPending.set(normalizedWsPath, { projectPath: key, workspace: ws });
  }

  function removeFromDeletionPending(workspacePath: WorkspacePath): void {
    const normalizedWsPath = workspaceKey(workspacePath);
    deletionPending.delete(normalizedWsPath);
  }

  /**
   * Returns the full workspace list: git cache merged with deletion-pending entries.
   * This is the single source of truth for resolve/list/find-candidates consumers.
   */
  function getMergedWorkspaces(): Map<ProjectPath, Workspace[]> {
    const merged = new Map<ProjectPath, Workspace[]>();
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
  // Add-project worktree picker
  // ---------------------------------------------------------------------------

  const ACTION_CONTINUE = "continue";
  const ACTION_CANCEL = "cancel";
  const SELECT_ALL_ID = "select-all";
  const CHECKBOX_ID_PREFIX = "wt-";

  /**
   * One line identifying a worktree: the name the workspace would take, then where
   * it lives. The branch is only worth a mention when it differs from the directory
   * name — for CodeHydra's own naming they are the same word, and repeating it once
   * per row is noise.
   */
  function worktreeLabel(wt: UnmanagedWorktree): string {
    const branch = wt.branch !== null && wt.branch !== wt.name ? ` (${wt.branch})` : "";
    const detached = wt.adoptable ? "" : " — detached HEAD, cannot be adopted";
    return `${wt.name}${branch} — ${wt.path.toString()}${detached}`;
  }

  /**
   * Build the picker's sections from the current selection.
   *
   * One checkbox per worktree, nothing else: a separate line of detail per row
   * would be centered by the dialog's default layout and separated from its own
   * checkbox by a full section gap, which reads as two unrelated things.
   *
   * Every checkbox echoes the module's own model value on every render. That is what
   * the controlled-value contract requires to force a box: the renderer adopts a
   * pushed value it has not seen yet, so "Select all" only re-ticks a box the user
   * unticked if the value it last saw was the untick.
   */
  function buildPickerSections(
    projectPath: string,
    unmanaged: readonly UnmanagedWorktree[],
    selected: ReadonlySet<number>
  ): DialogSection[] {
    const adoptable = unmanaged.filter((wt) => wt.adoptable);
    const sections: DialogSection[] = [
      { type: "text", content: "Open existing worktrees?", style: "heading" },
      { type: "text", content: projectPath, style: "subtitle" },
      {
        type: "checkbox",
        id: SELECT_ALL_ID,
        label: "Select all",
        // Reflects the rows rather than driving them alone: unticking one row
        // unticks this too, which is what a select-all box is expected to do.
        value: adoptable.length > 0 && adoptable.every((wt) => selected.has(unmanaged.indexOf(wt))),
        changeEvent: true,
      },
    ];

    unmanaged.forEach((wt, index) => {
      sections.push({
        type: "checkbox",
        id: `${CHECKBOX_ID_PREFIX}${index}`,
        label: worktreeLabel(wt),
        value: selected.has(index),
        changeEvent: true,
        disabled: !wt.adoptable,
      });
    });

    sections.push({
      type: "group",
      reverse: true,
      items: [
        { type: "button", id: ACTION_CONTINUE, label: "Continue", variant: "primary" },
        {
          type: "button",
          id: ACTION_CANCEL,
          label: "Cancel",
          variant: "secondary",
          role: "cancel",
        },
      ],
    });

    return sections;
  }

  /** Map a checkbox field id back to its index in the unmanaged list. */
  function checkboxIndex(fieldId: string): number | undefined {
    if (!fieldId.startsWith(CHECKBOX_ID_PREFIX)) return undefined;
    const index = Number(fieldId.slice(CHECKBOX_ID_PREFIX.length));
    return Number.isInteger(index) ? index : undefined;
  }

  /**
   * Show the picker and return the worktrees the user ticked, or null if they
   * canceled (which aborts the whole project add).
   */
  async function runPicker(
    projectPath: string,
    unmanaged: readonly UnmanagedWorktree[]
  ): Promise<UnmanagedWorktree[] | null> {
    const selected = new Set<number>();

    const setAll = (checked: boolean): void => {
      selected.clear();
      if (!checked) return;
      unmanaged.forEach((wt, index) => {
        if (wt.adoptable) selected.add(index);
      });
    };

    const applyValues = (data: Readonly<Record<string, string>> | undefined): void => {
      if (!data) return;
      for (const [fieldId, value] of Object.entries(data)) {
        const index = checkboxIndex(fieldId);
        if (index === undefined) continue;
        if (value === "true") selected.add(index);
        else selected.delete(index);
      }
    };

    const dialog = ui.dialog({
      sections: buildPickerSections(projectPath, unmanaged, selected),
    });
    const rerender = (): void => {
      dialog.update({ sections: buildPickerSections(projectPath, unmanaged, selected) });
    };

    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.onChange((event) => {
        if (event.fieldId === SELECT_ALL_ID) setAll(event.data[SELECT_ALL_ID] === "true");
        else applyValues(event.data);
        rerender();
      });
      dialog.onEvent((event) => {
        if (event.actionId === ACTION_CONTINUE) {
          // The submit payload is the authority: a debounced change event for the
          // last toggle may still be in flight.
          applyValues(event.data);
          resolve(true);
          return;
        }
        resolve(false);
      });
      dialog.onDismiss(() => {
        resolve(false);
      });
    });
    dialog.close();

    if (!confirmed) return null;
    return unmanaged.filter((wt, index) => wt.adoptable && selected.has(index));
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

      // open-project -> prepare (worktree picker) + discover
      [OPEN_PROJECT_OPERATION_ID]: {
        // prepare: offer the project's pre-existing worktrees for adoption.
        //
        // Only for an interactive add of a local path. Startup restore and
        // auto-workspace re-run this same operation with the same payload, and must
        // never interrupt with a dialog — `initial` is what separates them.
        //
        // Ordering against the git-init prompt on this hook point does not matter: a
        // directory that is not yet a repository has no worktrees to list, and one
        // that just became a repository has only its main worktree.
        prepare: {
          handler: async (ctx: HookContext): Promise<HookOutput<PrepareHookResult>> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git, initial } = intent.payload;

            // Self-select: interactive add, local path only. A fresh clone has no
            // pre-existing worktrees, so the picker would always be empty for one.
            if (!initial || git || !path) return { result: {} };

            const projectPathObj = new Path(path);
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPathObj);

            let unmanaged: readonly UnmanagedWorktree[];
            try {
              unmanaged = await gitWorktreeProvider.listUnmanagedWorktrees(
                projectPathObj,
                workspacesDir
              );
            } catch (error: unknown) {
              // Not a repository yet (the git-init prompt may not have run), or git
              // is unhappy — either way the open proceeds and resolve reports it.
              logger.warn("Failed to list worktrees for the add-project picker", {
                projectPath: path,
                error: getErrorMessage(error),
              });
              return { result: {} };
            }

            // Nothing the user could act on: say nothing. discover() logs the
            // worktrees it skips, so agent scratch worktrees stay diagnosable
            // without putting a dialog in the way of adding a project.
            if (!unmanaged.some((wt) => wt.adoptable)) return { result: {} };

            const picked = await runPicker(path, unmanaged);
            if (picked === null) return { result: { canceled: true } };

            const failed: string[] = [];
            for (const wt of picked) {
              if (wt.branch === null) continue;
              try {
                await gitWorktreeProvider.adoptWorktree(projectPathObj, wt.path, wt.branch);
              } catch (error: unknown) {
                failed.push(wt.name);
                logger.warn("Failed to adopt worktree", {
                  path: wt.path.toString(),
                  branch: wt.branch,
                  error: getErrorMessage(error),
                });
              }
            }

            // The tag IS the ownership record, so a failed write means the worktree
            // is not a workspace — say so rather than let it silently disappear on
            // the next restart.
            if (failed.length > 0) {
              ui.notification({
                title: "Could not open some worktrees",
                message: `${failed.join(", ")} could not be marked as CodeHydra workspaces.`,
                type: "error",
                dismissible: true,
              });
            }

            return { result: {} };
          },
        },
        discover: {
          handler: async (ctx: HookContext): Promise<HookOutput<DiscoverHookResult>> => {
            const { projectPath } = ctx as DiscoverHookInput;
            const projectPathObj = new Path(projectPath);
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPathObj);

            gitWorktreeProvider.registerProject(projectPathObj, workspacesDir);
            const key = projectKey(projectPathObj.toString());

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
                workspaces: toDiscoveredWorkspaces(discovered),
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
            const key = projectKey(intent.payload.projectPath);
            const list = workspaces.get(key) ?? [];
            // The contract carries paths as plain branded data, not `Path` instances.
            return {
              result: {
                workspaces: list.map((workspace) => ({
                  path: workspaceKey(workspace.path.toString()),
                })),
              },
            };
          },
        },
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<Record<string, never>>> => {
            const { projectPath } = ctx as CloseHookInput;
            const projectPathObj = new Path(projectPath);

            gitWorktreeProvider.unregisterProject(projectPathObj);
            const key = projectKey(projectPathObj.toString());
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

              const key = projectKey(projectPath);
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
            const key = projectKey(projectPathObj.toString());
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
                workspacePath: workspaceKey(internalWorkspace.path.toString()),
                branch: internalWorkspace.branch ?? internalWorkspace.name,
                metadata: internalWorkspace.metadata,
                resolvedBase: base,
              },
            };
          },
        },

        finalize: {
          /**
           * Re-read the workspace's metadata so `workspace:created` (and the
           * Workspace this operation returns) carry what git config actually
           * holds when creation completes.
           *
           * The `create` snapshot plus the metadata hook handlers *report* is
           * only as complete as its reporters. An agent that acts on its own
           * workspace during creation — OpenCode sends its initial prompt from
           * the setup hook, and `codehydra_workspace_set_title` is one MCP call
           * away — writes through `workspace:set-metadata`, which is not a hook
           * result and so is invisible to that fold. Its `metadata:changed`
           * event then lands on a row the presenter is about to overwrite with
           * the stale snapshot, and the change vanishes until a restart re-reads
           * git config.
           *
           * Reading here fixes it for every writer rather than for the ones that
           * remember to report, and keeps the presenter's "install the
           * authoritative snapshot" semantics correct by making it authoritative.
           * Merged last (open-workspace.ts folds finalize results after setup's),
           * so it supersedes both.
           */
          handler: async (ctx: HookContext): Promise<HookOutput<FinalizeHookResult>> => {
            const { workspacePath } = ctx as FinalizeHookInput;
            try {
              const metadata = await gitWorktreeProvider.getMetadata(new Path(workspacePath));
              return { result: { metadata } };
            } catch (error: unknown) {
              // Best-effort: a workspace whose metadata cannot be read still
              // opens, carrying the snapshot it already had.
              logger.warn("Failed to re-read workspace metadata on finalize", {
                workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return { result: {} };
            }
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
              projectDefaults.set(projectKey(projectPathObj.toString()), defaultBaseBranch);
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
            const { projectPath, workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            // Only a worktree removal can lose work; force is an explicit
            // teardown and ignoreWarnings the caller's opt-out. A failing read
            // throws: the gate fails closed rather than reporting "nothing to
            // object to" for a workspace it could not inspect.
            if (!payload.removeWorktree || payload.force || payload.ignoreWarnings) {
              return { result: {} };
            }

            const reasons: string[] = [];
            if (await gitWorktreeProvider.isDirty(new Path(wsPath))) {
              reasons.push("Workspace has uncommitted changes");
            }

            // Unmerged commits only go missing when the branch goes with the
            // worktree — a kept branch keeps them reachable. Skipping the check
            // also skips the fetch, which is the expensive part of this gate.
            if (!payload.keepBranch) {
              // Fetch first so the count is measured against current refs;
              // without it a delete right after a server-side merge (e.g.
              // /ship) compares against a stale origin/main and rejects the
              // just-merged commits as unmerged. Best-effort — a fetch failure
              // falls through to the stale-ref read rather than blocking.
              try {
                await gitWorktreeProvider.updateBases(new Path(projectPath));
              } catch {
                // Stale refs beat no answer.
              }

              const unmerged = await gitWorktreeProvider.countUnmergedCommits(new Path(wsPath));
              if (unmerged > 0) {
                reasons.push(
                  `Workspace has ${unmerged} unmerged commit${unmerged === 1 ? "" : "s"}`
                );
              }
            }

            if (reasons.length === 0) return { result: {} };
            return { result: { blocked: true, reason: reasons.join("; ") } };
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
              projectPath: ProjectPath;
              projectName: string;
              workspacePath: WorkspacePath;
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
                  workspacePath: workspaceKey(ws.path.toString()),
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
            const { workspacePath: wsPath, closing: closingReason } = ctx as GetStatusHookInput;

            // Both reads below spawn a git subprocess with the workspace as its
            // CWD. On Windows that alone is enough to make `git worktree remove`
            // fail with "Permission denied" on the directory, so never run them
            // against a workspace a teardown pipeline owns. The operation
            // re-reads `closing` immediately before this hook point, so it is
            // fresh even when a slow refresh preceded us.
            if (closingReason !== null) {
              // Same answer isDirty already gives for a torn-down worktree
              // (see GitWorktreeProvider.isDirty) — a workspace on its way out
              // has no uncommitted work to report.
              logger.debug("Skipping git status for closing workspace", {
                workspacePath: wsPath,
                reason: closingReason,
              });
              return { result: { isDirty: false, unmergedCommits: 0 } };
            }

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
                workspaces: toDiscoveredWorkspaces(wsList),
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
