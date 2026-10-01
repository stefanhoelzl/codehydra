/**
 * WorkspaceLifecycleModule — the single owner of transient per-workspace
 * lifecycle facts that are contributed to `workspace:resolve`.
 *
 * "Transient" means the fact has a start and an end within one dispatch;
 * "contributed to resolve" means other modules read it and nobody else stores
 * it. Persistent domain facts (hibernated, metadata, branch) and module-internal
 * plumbing stay with their owners.
 *
 * Two facts live here:
 * - `closing` — which teardown pipeline currently owns a workspace (see
 *   `workspaceClosingSchema` in intents/contract)
 * - which workspace is active — the `active` flag on resolve, and the ref
 *   `workspace:get-active` returns
 *
 * ## Why this exists
 *
 * Workspace teardown used to race the rest of the app. Nothing marked a
 * workspace as off-limits, so while `workspace:delete` was removing the git
 * worktree, other subsystems happily kept working in that directory — most
 * damagingly an in-flight `workspace:get-status` spawning `git status` with the
 * doomed worktree as its CWD. On Windows that makes `git worktree remove` fail
 * with "Permission denied" on the directory itself, which surfaces to the user
 * as a failed delete that succeeds on retry.
 *
 * The pattern was already present, privately, in api-server-module (a
 * `deletingWorkspaces` set gating sidekick reconnects). This module lifts it out
 * so every holder of a handle under the workspace can see the same fact.
 *
 * Hooks:
 * - resolve-workspace → resolve: contribute `closing` and `active`
 * - get-active-workspace → get: return the active ref
 * - switch-workspace → activate: record the new active surface
 * - delete-workspace → shutdown: claim the workspace ("delete", or "close" for
 *     the runtime-only teardown that project:close dispatches); clear active
 * - hibernate-workspace → shutdown: claim the workspace ("hibernate"); clear
 *     active
 *
 * Events:
 * - workspace:switched → track the active workspace
 * - workspace:deleted, workspace:delete-failed,
 *   workspace:hibernated, workspace:hibernate-failed → release the claim. All
 *   four are terminal and always emitted, which includes the confirm-cancel and
 *   hibernate-failure paths.
 *
 * ## Ordering
 *
 * The claim is taken in the "shutdown" hook point rather than at dispatch: the
 * remove-confirmation dialog runs its own dirty/unmerged check while it is open,
 * and claiming at dispatch would gate the very check the dialog exists to show.
 * Post-confirm is early enough — the teardown work that races the app all
 * happens after this point.
 *
 * Within "shutdown", handlers run sequentially in registration order (see
 * `collectHookResults` in intents/lib/dispatcher). This module MUST therefore be
 * registered before any module whose shutdown handler assumes the claim is
 * already taken — see the ordering note in main.ts. Nothing needs a `requires`
 * declaration for it, and deliberately so: an unsatisfied requirement *skips* a
 * handler silently, which would turn a mandatory teardown step into one that
 * quietly does not run.
 *
 * A throwing shutdown handler already aborts the teardown before "release" and
 * "delete" run (see DeleteWorkspaceOperation), so a failed claim fails the
 * dispatch rather than proceeding with a workspace nothing has quiesced.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import type { WorkspaceClosing, WorkspaceLocator, WorkspaceRef } from "../intents/contract";
import {
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  type GetActiveWorkspaceHookResult,
} from "../intents/get-active-workspace";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_SWITCHED,
  type ActivateHookInput,
  type SwitchWorkspaceHookResult,
  type WorkspaceSwitchedEvent,
} from "../intents/switch-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type StateHookInput,
  type StateHookResult,
} from "../intents/resolve-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeletePipelineHookInput,
  type DeleteWorkspaceIntent,
  type ShutdownHookResult,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_HIBERNATED,
  EVENT_WORKSPACE_HIBERNATE_FAILED,
  type HibernatePipelineHookInput,
  type HibernateShutdownHookResult,
  type WorkspaceHibernatedEvent,
  type WorkspaceHibernateFailedEvent,
} from "../intents/hibernate-workspace";

// =============================================================================
// Module Factory
// =============================================================================

/** Create the workspace lifecycle module. */
export function createWorkspaceLifecycleModule(): IntentModule {
  /** workspace ref → the teardown that owns it. */
  const closingWorkspaces = new Map<WorkspaceRef, WorkspaceClosing>();

  /**
   * The actual active surface, fed by the switch pipeline. Intentionally
   * distinct from `cachedActiveRef`, which is a UI-level cache that sticks to
   * the hibernating workspace during the fallbackToCurrent overlay window (see
   * hibernate-workspace.ts). The resolve hook reports this value;
   * delete/hibernate shutdown clears it so a later wake's switch is not
   * short-circuited as "already active".
   */
  let activeWorkspaceRef: WorkspaceRef | null = null;

  /** UI-level cache returned by get-active-workspace. See above for why it differs. */
  let cachedActiveRef: WorkspaceLocator | null = null;

  /** Forget the active surface if it is `workspaceRef`. */
  function clearActiveIfMatches(workspaceRef: WorkspaceRef): void {
    if (activeWorkspaceRef === workspaceRef) {
      activeWorkspaceRef = null;
    }
  }

  function claim(workspaceRef: WorkspaceRef, reason: WorkspaceClosing): void {
    closingWorkspaces.set(workspaceRef, reason);
  }

  function release(workspaceRef: WorkspaceRef): void {
    closingWorkspaces.delete(workspaceRef);
  }

  function closingReasonFor(workspaceRef: WorkspaceRef): WorkspaceClosing | null {
    return closingWorkspaces.get(workspaceRef) ?? null;
  }

  return {
    name: "workspace-lifecycle",
    hooks: {
      // -----------------------------------------------------------------
      // resolve-workspace → state: contribute `active` and `closing`.
      //
      // Omitted (rather than reported as null) when the workspace is not
      // closing: the operation defaults the field to null, and leaving the key
      // off keeps this module from overwriting a value another handler set.
      // -----------------------------------------------------------------
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        state: {
          handler: async (ctx: HookContext): Promise<HookOutput<StateHookResult>> => {
            const { workspaceRef } = ctx as StateHookInput;
            const reason = closingReasonFor(workspaceRef);
            return {
              result: {
                // Sourced from `activeWorkspaceRef` (the actual active
                // surface), not `cachedActiveRef` — the switch operation uses
                // this flag to decide whether to short-circuit, and the cache
                // deliberately lags during the hibernation overlay window.
                active: activeWorkspaceRef === workspaceRef,
                ...(reason !== null && { closing: reason }),
              },
            };
          },
        },
      },

      // -----------------------------------------------------------------
      // get-active-workspace → get: return the cached active ref.
      // -----------------------------------------------------------------
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<HookOutput<GetActiveWorkspaceHookResult>> => {
            return { result: { workspaceRef: cachedActiveRef } };
          },
        },
      },

      // -----------------------------------------------------------------
      // switch-workspace → activate: record the new active surface (no-op if
      // it is already active). The renderer swaps the visible iframe when the
      // workspace:switched event lands and routes focus itself, so nothing
      // visual happens here.
      // -----------------------------------------------------------------
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<HookOutput<SwitchWorkspaceHookResult>> => {
            const { workspaceRef, active } = ctx as ActivateHookInput;

            // Deselect: clear the bookkeeping so a later switch back to this
            // workspace isn't short-circuited as already-active.
            if (workspaceRef === null) {
              activeWorkspaceRef = null;
              return { result: {} };
            }

            if (active) {
              return { result: {} };
            }

            activeWorkspaceRef = workspaceRef;
            return { result: { resolvedRef: workspaceRef } };
          },
        },
      },

      // -----------------------------------------------------------------
      // delete-workspace → shutdown: claim the workspace.
      //
      // `removeWorktree: false` is the runtime-only teardown project:close
      // dispatches — the directory survives, so it claims as "close" rather
      // than "delete".
      // -----------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspaceRef } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            claim(workspaceRef, payload.removeWorktree ? "delete" : "close");
            clearActiveIfMatches(workspaceRef);
            return { result: {} };
          },
        },
      },

      // -----------------------------------------------------------------
      // hibernate-workspace → shutdown: claim the workspace.
      //
      // Clearing the active surface here covers the fallbackToCurrent case
      // (hibernating the only workspace keeps it "active" for the overlay): a
      // later wake must not be short-circuited as already-active.
      // -----------------------------------------------------------------
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<HibernateShutdownHookResult>> => {
            const { workspaceRef } = ctx as HibernatePipelineHookInput;
            claim(workspaceRef, "hibernate");
            clearActiveIfMatches(workspaceRef);
            return { result: {} };
          },
        },
      },
    },
    events: {
      // Track the active workspace. `cachedActiveRef` is a UI-level cache; both
      // are cleared together on a null switch (nothing active).
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;
          if (payload === null) {
            cachedActiveRef = null;
            activeWorkspaceRef = null;
            return;
          }
          cachedActiveRef = {
            ref: payload.workspaceRef,
            projectId: payload.projectId,
            workspaceName: payload.workspaceName,
          };
          activeWorkspaceRef = payload.workspaceRef;
        },
      },
      // The worktree is gone (or the runtime teardown finished).
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceDeletedEvent).payload.workspaceRef);
        },
      },
      // The workspace survived — blocked, or the user cancelled the dialog. It
      // must work again; leaving the claim set would gate its status reads and
      // its sidekick until the app restarts.
      [EVENT_WORKSPACE_DELETE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceDeleteFailedEvent).payload.workspaceRef);
        },
      },
      [EVENT_WORKSPACE_HIBERNATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceHibernatedEvent).payload.workspaceRef);
        },
      },
      [EVENT_WORKSPACE_HIBERNATE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceHibernateFailedEvent).payload.workspaceRef);
        },
      },
    },
  };
}
