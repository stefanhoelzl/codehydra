/**
 * GitWorktreeWorkspaceModule - Manages workspace-related git worktree operations.
 *
 * Consolidates worktree lifecycle hooks across multiple operations:
 * - open-project: register project, discover workspaces, fire-and-forget cleanup
 * - close-project: unregister project
 * - open-workspace: create worktree
 * - get-project-bases: list bases (local read), refresh bases (git fetch)
 * - delete-workspace: remove worktree
 * - get-workspace-status: check dirty status
 * - list-projects: each project's default base branch
 *
 * The workspaces themselves live in the core workspace registry
 * (`workspace-registry-module.ts`): this module tells it what discovery and
 * creation found and when a worktree is gone, and the registry answers resolve,
 * switch and list for every project type alike.
 *
 * Uses GitWorktreeProvider directly (no ProjectScopedWorkspaceProvider adapter).
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import type { UnmanagedWorktree } from "../boundaries/platform/git-types";
import type { UiPresenter } from "./presentation/presentation-module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { notify } from "./presentation/notification-card";
import type { DialogSection } from "../shared/dialog-types";
import type { WorkspacesRoot } from "./workspaces-root/workspaces-root";
import type { Logger } from "../boundaries/platform/logging-types";
import type { CreateHookResult, FinalizeHookResult } from "../intents/open-workspace";
import { OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import type { ListBasesHookResult } from "../intents/get-project-bases";
import { GET_PROJECT_BASES_OPERATION_ID } from "../intents/get-project-bases";
import type { DeleteHookResult, PreflightHookResult } from "../intents/delete-workspace";
import type { DiscoverHookResult, PrepareHookResult } from "../intents/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../intents/close-project";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  type GetStatusHookResult,
} from "../intents/get-workspace-status";
import {
  LIST_PROJECTS_OPERATION_ID,
  type ListWorkspacesHookResult,
  type ListWorkspacesHookEntry,
} from "../intents/list-projects";
import { Path } from "../utils/path/path";
import { getErrorMessage, WorkspaceError } from "../shared/errors/service-errors";
import { projectPathSchema, workspacePathSchema } from "../intents/contract";
import type { ProjectPath, WorkspacePath } from "../intents/contract";
import { toDiscoveredWorkspaces } from "../utils/workspace-conversion";
import { defineHooks } from "../intents/declarations";
import { REQUIRES_FREE_NAME, type WorkspaceRegistry } from "./workspace-registry-module";

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a module that manages workspace-related git worktree operations.
 *
 * @param gitWorktreeProvider - Global GitWorktreeProvider for all git operations
 * @param workspacesRoot - Where each project's worktrees are created
 * @param logger - Logger for warnings and errors
 * @param ui - Presenter for the add-project worktree picker
 * @param dispatcher - Dispatcher for the picker's failure notice (`notification:show`)
 * @param registry - The core workspace registry, told what exists
 * @returns IntentModule with hook contributions
 */
export function createGitWorktreeWorkspaceModule(
  gitWorktreeProvider: GitWorktreeProvider,
  workspacesRoot: Pick<WorkspacesRoot, "workspacesDir" | "previousWorkspacesDirs">,
  logger: Logger,
  ui: Pick<UiPresenter, "dialog">,
  dispatcher: Pick<Dispatcher, "dispatch">,
  registry: WorkspaceRegistry
): IntentModule {
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

  // ---------------------------------------------------------------------------
  // Add-project worktree picker
  // ---------------------------------------------------------------------------

  const ACTION_CONTINUE = "continue";
  const ACTION_CANCEL = "cancel";
  const SELECT_ALL_ID = "select-all";
  const CHECKBOX_ID_PREFIX = "wt-";

  /**
   * One line identifying a worktree: the name the workspace would take (its
   * branch), then where it lives.
   */
  function worktreeLabel(wt: UnmanagedWorktree): string {
    return `${wt.name} — ${wt.path.toString()}`;
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
    const sections: DialogSection[] = [
      { type: "text", content: "Open existing worktrees?", style: "heading" },
      { type: "text", content: projectPath, style: "subtitle" },
      {
        type: "checkbox",
        id: SELECT_ALL_ID,
        label: "Select all",
        // Reflects the rows rather than driving them alone: unticking one row
        // unticks this too, which is what a select-all box is expected to do.
        value: unmanaged.length > 0 && selected.size === unmanaged.length,
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
      unmanaged.forEach((_wt, index) => {
        selected.add(index);
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
    return unmanaged.filter((_wt, index) => selected.has(index));
  }

  // ---------------------------------------------------------------------------
  // Hook Handlers
  // ---------------------------------------------------------------------------

  return {
    name: "git-worktree",
    hooks: defineHooks({
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
          handler: async (ctx): Promise<HookOutput<PrepareHookResult>> => {
            const { intent } = ctx;
            const { path, git, initial } = intent.payload;

            // Self-select: interactive add, local path only. A fresh clone has no
            // pre-existing worktrees, so the picker would always be empty for one.
            if (!initial || git || !path) return { result: {} };

            const projectPathObj = new Path(path);
            const workspacesDir = workspacesRoot.workspacesDir(projectPathObj);

            let unmanaged: readonly UnmanagedWorktree[];
            try {
              unmanaged = await gitWorktreeProvider.listUnmanagedWorktrees(
                projectPathObj,
                workspacesDir,
                workspacesRoot.previousWorkspacesDirs()
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
            if (unmanaged.length === 0) return { result: {} };

            const picked = await runPicker(path, unmanaged);
            if (picked === null) return { result: { canceled: true } };

            const failed: string[] = [];
            for (const wt of picked) {
              try {
                await gitWorktreeProvider.adoptWorktree(projectPathObj, wt.path, wt.branch);
              } catch (error: unknown) {
                failed.push(wt.name);
                logger.scoped({ path: wt.path.toString() }).warn("Failed to adopt worktree", {
                  branch: wt.branch,
                  error: getErrorMessage(error),
                });
              }
            }

            // The tag IS the ownership record, so a failed write means the worktree
            // is not a workspace — say so rather than let it silently disappear on
            // the next restart.
            if (failed.length > 0) {
              notify(dispatcher, {
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
          handler: async (ctx): Promise<HookOutput<DiscoverHookResult>> => {
            const { projectPath, projectRef } = ctx;
            const projectPathObj = new Path(projectPath);
            const workspacesDir = workspacesRoot.workspacesDir(projectPathObj);

            const key = projectKey(projectPathObj.toString());
            const project = { ref: projectRef, path: key };

            // Already open: report the list the app holds rather than re-read git.
            // project:open runs again for an open project (an automation naming it
            // by URL), and a fresh discover can skip a worktree the sidebar, agent
            // and views still hold, leaving a workspace nothing can resolve.
            const known = registry.workspacesOf(projectRef);
            if (known !== undefined) {
              const defaultBaseBranch = projectDefaults.get(key);
              return {
                result: {
                  workspaces: toDiscoveredWorkspaces(known),
                  ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
                },
              };
            }

            gitWorktreeProvider.registerProject(
              projectPathObj,
              workspacesDir,
              workspacesRoot.previousWorkspacesDirs()
            );

            const discovered = await gitWorktreeProvider.discover(projectPathObj);
            registry.openProject(project);
            for (const ws of discovered) registry.track(project, ws);

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

      // close-project -> close (the registry lists and forgets the workspaces)
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx): Promise<HookOutput<Record<string, never>>> => {
            const projectPathObj = new Path(ctx.projectPath);
            gitWorktreeProvider.unregisterProject(projectPathObj);
            projectDefaults.delete(projectKey(projectPathObj.toString()));
            return { result: {} };
          },
        },
      },

      // open-workspace -> create
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          // After the registry checked a fresh name is free.
          requires: REQUIRES_FREE_NAME,
          handler: async (ctx): Promise<HookOutput<CreateHookResult>> => {
            const { intent } = ctx;
            const { payload } = intent;
            const { projectPath, projectRef, fresh } = ctx;
            const project = { ref: projectRef, path: projectKey(projectPath) };

            // Reopen: populate from the existing workspace's data, skip worktree creation
            const existing = payload.existingWorkspace;
            if (!fresh && existing !== undefined) {
              const workspacePath = existing.path;
              const metadata = existing.metadata;
              // The recorded base, not the payload's: callers reopening a
              // workspace know nothing better than its metadata, and a base
              // that was never recorded stays absent rather than invented.
              const recordedBase = metadata["base"];

              registry.track(project, {
                name: existing.name,
                path: new Path(workspacePath),
                branch: existing.branch,
                metadata,
              });

              return {
                result: {
                  workspacePath,
                  branch: existing.branch,
                  metadata,
                  ...(recordedBase !== undefined && { resolvedBase: recordedBase }),
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
              const message = getErrorMessage(error);
              throw new WorkspaceError(`${message} (base: '${base}')`);
            }

            registry.track(project, internalWorkspace);

            return {
              result: {
                workspacePath: workspaceKey(internalWorkspace.path.toString()),
                branch: internalWorkspace.branch,
                metadata: internalWorkspace.metadata,
                resolvedBase: base,
              },
            };
          },
        },

        finalize: {
          /**
           * Re-read the workspace's metadata so `workspace:created` (and the
           * Workspace this operation returns) carry what the metadata store
           * actually holds when creation completes.
           *
           * The `create` snapshot plus the metadata hook handlers *report* is
           * only as complete as its reporters. An agent that acts on its own
           * workspace during creation — OpenCode sends its initial prompt from
           * the setup hook, and `codehydra_workspace_set_title` is one MCP call
           * away — writes through `workspace:set-metadata`, which is not a hook
           * result and so is invisible to that fold. Its `metadata:changed`
           * event then lands on a row the presenter is about to overwrite with
           * the stale snapshot, and the change vanishes until a restart re-reads
           * the metadata.
           *
           * Reading here fixes it for every writer rather than for the ones that
           * remember to report, and keeps the presenter's "install the
           * authoritative snapshot" semantics correct by making it authoritative.
           * Merged last (open-workspace.ts folds finalize results after setup's),
           * so it supersedes both.
           */
          handler: async (ctx): Promise<HookOutput<FinalizeHookResult>> => {
            const { workspacePath } = ctx;
            try {
              const metadata = await gitWorktreeProvider.getMetadata(new Path(workspacePath));
              return { result: { metadata } };
            } catch (error: unknown) {
              // Best-effort: a workspace whose metadata cannot be read still
              // opens, carrying the snapshot it already had.
              logger
                .scoped({ path: workspacePath })
                .warn("Failed to re-read workspace metadata on finalize", {
                  error: getErrorMessage(error),
                });
              return { result: {} };
            }
          },
        },
      },

      // get-project-bases -> list + refresh
      [GET_PROJECT_BASES_OPERATION_ID]: {
        list: {
          handler: async (ctx): Promise<HookOutput<ListBasesHookResult>> => {
            const { projectPath } = ctx;
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
          handler: async (ctx): Promise<void> => {
            const { projectPath } = ctx;
            await gitWorktreeProvider.updateBases(new Path(projectPath));
          },
        },
      },

      // delete-workspace -> preflight + delete (resolve hook removed, now uses resolve-workspace dispatch)
      [DELETE_WORKSPACE_OPERATION_ID]: {
        preflight: {
          handler: async (ctx): Promise<HookOutput<PreflightHookResult>> => {
            const { projectPath, workspacePath: wsPath } = ctx;
            const { payload } = ctx.intent;

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
          handler: async (ctx): Promise<HookOutput<DeleteHookResult>> => {
            const { projectPath, workspacePath: wsPath } = ctx;
            const { payload } = ctx.intent;

            if (!payload.removeWorktree) {
              // Runtime teardown only: the worktree stays, the registry lets go of it.
              registry.untrack(new Path(wsPath), "closed");
              return { result: {} };
            }

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
                // Dismissed: the workspace goes, whatever is left on disk
                registry.untrack(new Path(wsPath), "deleted");
              }
              // Non-force: the workspace stays registered, so the user can retry
              return { result: { error: getErrorMessage(error) } };
            }

            registry.untrack(new Path(wsPath), "deleted");
            return { result: {} };
          },
        },
      },

      // get-workspace-status -> get (resolve hook removed)
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx): Promise<HookOutput<GetStatusHookResult>> => {
            const { workspacePath: wsPath, closing: closingReason } = ctx;

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
              logger
                .scoped({ path: wsPath })
                .debug("Skipping git status for closing workspace", { reason: closingReason });
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

      // list-projects -> list-workspaces: each project's default base branch. The
      // workspaces come from the registry; the operation merges entries by path.
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-workspaces": {
          handler: async (): Promise<HookOutput<ListWorkspacesHookResult>> => {
            const entries: ListWorkspacesHookEntry[] = [];
            for (const [projectPath, defaultBaseBranch] of projectDefaults) {
              entries.push({ projectPath, workspaces: [], defaultBaseBranch });
            }
            return { result: { entries } };
          },
        },
      },
    }),
  };
}
