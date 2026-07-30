/**
 * WorkspaceLifecycleModule — the single owner of transient per-workspace
 * lifecycle facts that are contributed to `workspace:resolve`.
 *
 * "Transient" means the fact has a start and an end within one dispatch;
 * "contributed to resolve" means other modules read it and nobody else stores
 * it. Persistent domain facts (hibernated, metadata, branch) and module-internal
 * plumbing stay with their owners.
 *
 * Today that is one fact: `closing` — which teardown pipeline currently owns a
 * workspace (see `workspaceClosingSchema` in intents/contract).
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
 * The pattern was already present, privately, in plugin-server-module (a
 * `deletingWorkspaces` set gating sidekick reconnects). This module lifts it out
 * so every holder of a handle under the workspace can see the same fact.
 *
 * Hooks:
 * - resolve-workspace → resolve: contribute `closing`
 * - delete-workspace → shutdown: claim the workspace ("delete", or "close" for
 *     the runtime-only teardown that project:close dispatches)
 * - hibernate-workspace → shutdown: claim the workspace ("hibernate")
 *
 * Events (release the claim — all four are terminal and always emitted, which
 * includes the confirm-cancel and hibernate-failure paths):
 * - workspace:deleted, workspace:delete-failed
 * - workspace:hibernated, workspace:hibernate-failed
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
import type { WorkspaceClosing } from "../intents/contract";
import { Path } from "../utils/path/path";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
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
// Query interface
// =============================================================================

/**
 * Read side of the `closing` state, injected into the modules that must check
 * it at the point of use.
 *
 * The `closing` field on a `workspace:resolve` result is a snapshot: a caller
 * that resolved before the teardown started still holds `null`, however long it
 * then takes to act. That is exactly the shape of the bug this fixes — a status
 * refresh resolved 25 seconds before it got around to spawning git. Anything
 * that opens a handle or spawns a process under the workspace must therefore
 * re-read through this query immediately before doing so, not trust an
 * enrichment it was handed earlier.
 */
export interface WorkspaceClosingQuery {
  /** The teardown that currently owns `workspacePath`, or null when none does. */
  get(workspacePath: string): WorkspaceClosing | null;
}

// =============================================================================
// Module Factory
// =============================================================================

export interface WorkspaceLifecycleModule {
  readonly module: IntentModule;
  readonly closing: WorkspaceClosingQuery;
}

/**
 * Create the workspace lifecycle module plus the query its consumers use.
 *
 * Returns both halves so the composition root can hand the read side to the
 * modules that gate on it without those modules depending on this one.
 */
export function createWorkspaceLifecycleModule(): WorkspaceLifecycleModule {
  /** workspacePath (normalized) → the teardown that owns it. */
  const closingWorkspaces = new Map<string, WorkspaceClosing>();

  const key = (workspacePath: string): string => new Path(workspacePath).toString();

  function claim(workspacePath: string, reason: WorkspaceClosing): void {
    closingWorkspaces.set(key(workspacePath), reason);
  }

  function release(workspacePath: string): void {
    closingWorkspaces.delete(key(workspacePath));
  }

  const closing: WorkspaceClosingQuery = {
    get(workspacePath: string): WorkspaceClosing | null {
      return closingWorkspaces.get(key(workspacePath)) ?? null;
    },
  };

  const module: IntentModule = {
    name: "workspace-lifecycle",
    hooks: {
      // -----------------------------------------------------------------
      // resolve-workspace → resolve: contribute `closing`.
      //
      // Omitted (rather than reported as null) when the workspace is not
      // closing: the operation defaults the field to null, and leaving the key
      // off keeps this module from overwriting a value another handler set.
      // -----------------------------------------------------------------
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<ResolveHookResult>> => {
            const { workspacePath } = ctx as ResolveHookInput;
            const reason = closing.get(workspacePath);
            return { result: reason === null ? {} : { closing: reason } };
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
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            claim(workspacePath, payload.removeWorktree ? "delete" : "close");
            return { result: {} };
          },
        },
      },

      // -----------------------------------------------------------------
      // hibernate-workspace → shutdown: claim the workspace.
      // -----------------------------------------------------------------
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<HibernateShutdownHookResult>> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            claim(workspacePath, "hibernate");
            return { result: {} };
          },
        },
      },
    },
    events: {
      // The worktree is gone (or the runtime teardown finished).
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceDeletedEvent).payload.workspacePath);
        },
      },
      // The workspace survived — blocked, or the user cancelled the dialog. It
      // must work again; leaving the claim set would gate its status reads and
      // its sidekick until the app restarts.
      [EVENT_WORKSPACE_DELETE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceDeleteFailedEvent).payload.workspacePath);
        },
      },
      [EVENT_WORKSPACE_HIBERNATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceHibernatedEvent).payload.workspacePath);
        },
      },
      [EVENT_WORKSPACE_HIBERNATE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          release((event as WorkspaceHibernateFailedEvent).payload.workspacePath);
        },
      },
    },
  };

  return { module, closing };
}
