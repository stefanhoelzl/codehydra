/**
 * DeleteWorkspaceOperation - Orchestrates workspace deletion.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — resolves workspacePath to projectPath + workspaceName
 * 2. Dispatch project:resolve — resolves projectPath to projectId
 * 3. Gates, both before any teardown or progress emission: "confirm" (interactive
 *    dispatches — DeletionDialogModule parks on a dialog) and "preflight"
 *    (WorktreeModule vetoes on workspace state). Either one refusing aborts with
 *    the workspace untouched.
 * 4. "shutdown" hook — ViewModule (switch + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI)
 * 4b. "pre-delete" hook — the repository's own gate (HooksModule), on a quiesced
 *     workspace but before the reap, so "release" cleans up after it. Skipped in
 *     force mode. A refusal stops the pipeline with the worktree still on disk.
 * 5. "release" hook — WindowsLockModule (detect CWD + kill) [Windows-only]
 * 6. If blockingPids provided (retry): "flush" hook — kill provided PIDs
 * 7. "delete" hook — WorktreeModule (remove git worktree), IdeServerModule (delete .code-workspace file)
 *
 * If delete fails (and not force):
 * 8. "detect" — Full blocking process detection (RM + CWD + handles)
 * 9. Emit progress with blockers, emit workspace:delete-failed, return
 *
 * On retry, the UI dispatches a new intent with blockingPids from the previous failure.
 * The flush hook kills those PIDs before re-attempting delete.
 *
 * Each handler returns a typed result; the operation merges results and tracks errors.
 * On success (or force=true), emits a workspace:deleted domain event for state cleanup.
 * On failure, emits workspace:delete-failed to reset idempotency for retry.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import type {
  DeletionProgress,
  DeletionOperation,
  DeletionOperationId,
  DeletionOperationStatus,
  BlockingProcess,
} from "../shared/api/types";
import {
  blockingProcessSchema,
  deletionProgressSchema,
  hookCtxSchema,
  projectPathSchema,
  projectRefSchema,
  workspaceIdentityPayloadSchema,
  workspaceNameSchema,
  workspaceRefIdentitySchema,
  workspaceRefSchema,
  workspaceTargetShape,
} from "./contract";
import type { WorkspaceIdentityPayload, WorkspaceRef } from "./contract";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import {
  resolveWorkspaceIdentity,
  workspaceIdentityPayload,
  workspaceRefIdentity,
} from "./lib/workspace-identity";
import { activeWorkspaceRef } from "./lib/active-workspace";
import { throwHookErrors, collectErrorMessages, onlyDefined } from "./lib/hook-helpers";

export const INTENT_DELETE_WORKSPACE = "workspace:delete" as const;
export const DELETE_WORKSPACE_OPERATION_ID = "delete-workspace";

export const EVENT_WORKSPACE_DELETED = "workspace:deleted" as const;
export const EVENT_WORKSPACE_DELETE_FAILED = "workspace:delete-failed" as const;
export const EVENT_WORKSPACE_DELETION_PROGRESS = "workspace:deletion-progress" as const;

/**
 * Capability a "preflight" handler provides to say it also has a "pre-delete"
 * hook to run. Preflight is the last thing before the first progress event, so
 * it is the only place a row can be claimed in time to be listed with the rest.
 */
export const CAPABILITY_REPO_HOOK = "repo-hook" as const;

/**
 * Capability the "shutdown" handler that closes the agent terminal provides once
 * it is done trying — closed, timed out or failed. Teardown that would cut the
 * connection the close travels over (stopping the agent, releasing the IDE
 * frame) requires it.
 */
export const CAPABILITY_AGENT_STOPPED = "agent-stopped" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const deleteWorkspacePayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    keepBranch: z.boolean(),
    force: z.boolean(),
    /** Whether to remove the git worktree. true = full pipeline, false = shutdown only (runtime teardown). */
    removeWorktree: z.boolean(),
    skipSwitch: z.boolean().optional(),
    /** If true, skip preflight checks for uncommitted changes and unmerged commits. */
    ignoreWarnings: z.boolean().optional(),
    /** PIDs from a previous failed attempt. When present, flush hook kills these before delete. */
    blockingPids: z.array(z.number()).readonly().optional(),
    /**
     * The dispatch is user-interactive: the "confirm" hook point runs before the
     * pipeline, parking the dispatch on a confirmation dialog that contributes
     * keepBranch or cancels. Programmatic callers (MCP, API server, automations)
     * omit it and never see a dialog. Only honored on the full-pipeline path
     * (removeWorktree, not force).
     */
    interactive: z.boolean().optional(),
  })
  .readonly();

export const deleteWorkspaceResultSchema = z.object({ started: z.boolean() }).readonly();

// =============================================================================
// Per-hook-point schemas
// =============================================================================

/**
 * Per-handler result for the "confirm" hook point (interactive dispatches
 * only). The handler opens a confirmation dialog and parks until the user
 * answers: canceled aborts the dispatch (workspace:delete-failed is emitted
 * so the per-key idempotency guard resets — the event means "ended without
 * deletion", not only errors); otherwise keepBranch overrides the payload and
 * the pipeline proceeds with ignoreWarnings semantics (the user just saw the
 * warnings).
 */
export const confirmResultSchema = z
  .object({
    canceled: z.boolean().optional(),
    keepBranch: z.boolean().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "preflight" hook point.
 *
 * A handler inspects the workspace and decides whether this delete may proceed:
 * `blocked` with a `reason` vetoes the dispatch before any teardown runs. The
 * decision is the handler's — the operation only sequences the gate and turns a
 * veto into the caller's outcome — so a handler with nothing to object to (or
 * nothing to check: force, runtime-only teardown, an explicit ignoreWarnings)
 * returns an empty result. A handler that cannot determine the state throws,
 * failing the gate closed rather than guessing.
 */
export const preflightResultSchema = z
  .object({
    blocked: z.boolean().optional(),
    /** Why the delete was refused. Joined into the caller's error. */
    reason: z.string().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "pre-delete" hook point.
 *
 * The last gate before the worktree is removed, and the only one a repository's
 * own hook can reach. It runs on a quiesced workspace — terminals killed, agent
 * server stopped, VS Code view closed — but *before* "release", so the CWD scan
 * and kill still cleans up anything a handler left holding the directory.
 *
 * Same two-signal split as "preflight": `blocked` with a `reason` is a policy
 * decision, while a handler that throws could not tell and fails the gate closed.
 * Unlike preflight, a refusal here is reported on the deletion progress panel's
 * own row (`repo-hook`) rather than as a bare rejection — the pipeline has
 * already emitted progress by the time it runs.
 *
 * Skipped entirely in force mode: force is the escape hatch from a gate that
 * refuses or hangs, and the panel's Dismiss button takes it.
 */
export const preDeleteResultSchema = z
  .object({
    blocked: z.boolean().optional(),
    /** Why the delete was refused. Shown as the progress row's error. */
    reason: z.string().optional(),
  })
  .readonly();

/**
 * Progress frame a "pre-delete" handler yields the moment it has real work to do
 * (the hook point's `frames` schema, validated by the dispatcher).
 *
 * Its only job is to say "a gate is actually running here". Most repositories
 * define no hook at all, and a progress row for a step that will never do
 * anything is noise on every deletion in every project — so the row is created
 * by this frame rather than unconditionally by the operation.
 */
export const preDeleteStartedFrameSchema = z.object({ started: z.literal(true) }).readonly();
export type PreDeleteStartedFrame = z.infer<typeof preDeleteStartedFrameSchema>;

/**
 * Per-handler result for the "shutdown" hook point.
 * AgentModule may provide serverName and error.
 *
 * Whether the deleted workspace is the active one is deliberately NOT reported
 * here. It is read by the operation immediately before this hook point — see
 * runPipelineBody.
 */
export const shutdownResultSchema = z
  .object({
    serverName: z.string().optional(),
    error: z.string().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "release" hook point.
 * CWD-only scan: finds and kills processes with CWD under workspace.
 */
export const releaseResultSchema = z.object({ error: z.string().optional() }).readonly();

/** Per-handler result for the "delete" hook point. */
export const deleteResultSchema = z.object({ error: z.string().optional() }).readonly();

/**
 * Per-handler result for the "detect" hook point.
 * Full blocking process detection after delete failure.
 */
export const detectResultSchema = z
  .object({
    blockingProcesses: z.array(blockingProcessSchema).readonly().optional(),
    error: z.string().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "flush" hook point.
 * Kills blocking processes by PID.
 */
export const flushResultSchema = z.object({ error: z.string().optional() }).readonly();

/** Operation-added enrichment shared by shutdown/release/delete/detect/confirm/preflight hooks. */
const deletePipelineEnrichmentSchema = z.object({
  ...workspaceTargetShape,
  projectRef: projectRefSchema,
  projectPath: projectPathSchema,
  workspaceName: workspaceNameSchema,
  active: z.boolean(),
});
const deletePipelineInputSchema = hookCtxSchema(
  deleteWorkspacePayloadSchema,
  deletePipelineEnrichmentSchema.shape
);

/** Operation-added enrichment for the "flush" hook point (adds PIDs to kill). */
const flushEnrichmentSchema = deletePipelineEnrichmentSchema.extend({
  blockingPids: z.array(z.number()).readonly(),
});
const flushInputSchema = hookCtxSchema(deleteWorkspacePayloadSchema, flushEnrichmentSchema.shape);

// =============================================================================
// Event payload schemas (events defined in this file)
// =============================================================================

const workspaceDeletedSchema = z
  .object({
    ...workspaceIdentityPayloadSchema.shape,
    /**
     * True when the dispatch removed (or force-abandoned) the git worktree;
     * false for runtime-only teardown (removeWorktree: false — e.g. the
     * per-workspace teardown during project:close). Consumers that track real
     * deletions (auto-workspace dismissal) must ignore teardown events.
     */
    worktreeRemoved: z.boolean(),
  })
  .readonly();

/**
 * The dispatch ended without deleting the workspace (failed, refused or
 * canceled). Carries only the identity the ref names by itself: it is also
 * emitted when the ref never resolved, and no project id exists then.
 */
const workspaceDeleteFailedSchema = z.object(workspaceRefIdentitySchema.shape).readonly();

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: deleteWorkspacePayloadSchema,
  result: deleteWorkspaceResultSchema,
  hooks: {
    confirm: { input: deletePipelineInputSchema, result: confirmResultSchema },
    preflight: { input: deletePipelineInputSchema, result: preflightResultSchema },
    shutdown: { input: deletePipelineInputSchema, result: shutdownResultSchema },
    "pre-delete": {
      input: deletePipelineInputSchema,
      result: preDeleteResultSchema,
      frames: preDeleteStartedFrameSchema,
    },
    release: { input: deletePipelineInputSchema, result: releaseResultSchema },
    delete: { input: deletePipelineInputSchema, result: deleteResultSchema },
    detect: { input: deletePipelineInputSchema, result: detectResultSchema },
    flush: { input: flushInputSchema, result: flushResultSchema },
  },
  events: {
    [EVENT_WORKSPACE_DELETED]: workspaceDeletedSchema,
    [EVENT_WORKSPACE_DELETE_FAILED]: workspaceDeleteFailedSchema,
    [EVENT_WORKSPACE_DELETION_PROGRESS]: deletionProgressSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type DeleteWorkspacePayload = z.infer<typeof deleteWorkspacePayloadSchema>;
export type DeleteWorkspaceIntent = IntentOf<typeof schemas>;

export type WorkspaceDeletedPayload = z.infer<typeof workspaceDeletedSchema>;
export type WorkspaceDeleteFailedPayload = z.infer<typeof workspaceDeleteFailedSchema>;

export interface WorkspaceDeletedEvent extends DomainEvent {
  readonly type: "workspace:deleted";
  readonly payload: WorkspaceDeletedPayload;
}

export interface WorkspaceDeleteFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_WORKSPACE_DELETE_FAILED;
  readonly payload: WorkspaceDeleteFailedPayload;
}

export interface WorkspaceDeletionProgressEvent extends DomainEvent {
  readonly type: typeof EVENT_WORKSPACE_DELETION_PROGRESS;
  readonly payload: DeletionProgress;
}

export type ConfirmHookResult = z.infer<typeof confirmResultSchema>;
export type PreflightHookResult = z.infer<typeof preflightResultSchema>;
export type ShutdownHookResult = z.infer<typeof shutdownResultSchema>;
export type PreDeleteHookResult = z.infer<typeof preDeleteResultSchema>;
export type ReleaseHookResult = z.infer<typeof releaseResultSchema>;
export type DeleteHookResult = z.infer<typeof deleteResultSchema>;
export type DetectHookResult = z.infer<typeof detectResultSchema>;
export type FlushHookResult = z.infer<typeof flushResultSchema>;

/** Input for shutdown/release/delete/detect hooks (enriched with both resolved paths). */
export type DeletePipelineHookInput = HookContext & z.infer<typeof deletePipelineEnrichmentSchema>;

/** Input for flush hook (enriched with PIDs to kill). */
export type FlushHookInput = HookContext & z.infer<typeof flushEnrichmentSchema>;

// =============================================================================
// Merged Result Types (internal to operation)
// =============================================================================

interface MergedShutdown {
  readonly serverName: string | undefined;
  readonly errors: readonly string[];
}

/** Shared shape for hook points that only report errors (release, delete, flush). */
interface MergedErrors {
  readonly errors: readonly string[];
}

interface MergedDetect {
  readonly blockingProcesses?: readonly BlockingProcess[];
  readonly errors: readonly string[];
}

// =============================================================================
// Merge Functions
// =============================================================================

/**
 * `collectErrorMessages` expects exact-optional `error?: string`, but zod infers `error?: string
 * | undefined` for `.optional()` fields. The two are runtime-identical ("maybe an error string"),
 * so bridge the exactOptionalPropertyTypes gap with a widening view at the single call boundary.
 */
type ErrorResult = { readonly error?: string | undefined };
const errorMessages = (
  results: readonly ErrorResult[],
  collectErrors: readonly Error[]
): string[] =>
  collectErrorMessages(results as readonly { readonly error?: string }[], collectErrors);

function mergeShutdown(
  results: readonly ShutdownHookResult[],
  collectErrors: readonly Error[]
): MergedShutdown {
  const serverName = onlyDefined(results, "serverName", "workspace:delete shutdown");
  return { serverName, errors: errorMessages(results, collectErrors) };
}

function mergeErrors(
  results: readonly ErrorResult[],
  collectErrors: readonly Error[]
): MergedErrors {
  return { errors: errorMessages(results, collectErrors) };
}

function mergeDetect(
  results: readonly DetectHookResult[],
  collectErrors: readonly Error[]
): MergedDetect {
  // A list, so several handlers' findings add up rather than conflict.
  let blockingProcesses: readonly BlockingProcess[] | undefined;
  for (const r of results) {
    if (r.blockingProcesses !== undefined) {
      blockingProcesses = [...(blockingProcesses ?? []), ...r.blockingProcesses];
    }
  }
  return {
    ...(blockingProcesses !== undefined && { blockingProcesses }),
    errors: errorMessages(results, collectErrors),
  };
}

// =============================================================================
// Emit function type (for threading ctx.emit through private methods)
// =============================================================================

/** The operation's own emit, narrowed to the events it declares. */
type EmitFn = OperationContext<DeleteWorkspaceIntent, typeof schemas>["emit"];

// =============================================================================
// Pipeline State (for progress emission)
// =============================================================================

/** What the pipeline has learned so far; filled in stage by stage as it runs. */
interface PipelineState {
  shutdown?: MergedShutdown;
  /** The repository has a "pre-delete" hook, so its row is listed from the start. */
  repoHookPresent?: boolean;
  preDelete?: MergedErrors;
  release?: MergedErrors;
  del?: MergedErrors;
  detect?: MergedDetect;
  flush?: MergedErrors;
}

// =============================================================================
// Operation
// =============================================================================

/** Resolved identity from dispatch, carried by every event and progress report. */
type ResolvedIdentity = WorkspaceIdentityPayload;

/** Return value of runPipeline, carrying resolved identity for emitEvent. */
interface PipelineResult {
  readonly hasErrors: boolean;
  readonly identity: ResolvedIdentity;
  /** The interactive confirm hook canceled the dispatch (nothing ran). */
  readonly canceled?: boolean;
}

export class DeleteWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>
  ): Promise<{ started: boolean }> {
    const { payload } = ctx.intent;

    const emitEvent = (identity: ResolvedIdentity): void => {
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: { ...identity, worktreeRemoved: payload.removeWorktree },
      };
      ctx.emit(event);
    };

    if (payload.force) {
      let identity: ResolvedIdentity | undefined;
      try {
        const result = await this.runPipeline(ctx, ctx.emit);
        identity = result.identity;
      } finally {
        // Force mode: always emit workspace:deleted for state cleanup (if identity resolved)
        if (identity) {
          emitEvent(identity);
        }
      }
    } else {
      let failed = false;
      try {
        const result = await this.runPipeline(ctx, ctx.emit);

        if (result.canceled) {
          // User declined the interactive confirm: nothing ran. Emit
          // delete-failed so the per-key idempotency guard resets (the event
          // means "dispatch ended without deletion"), and skip the
          // auto-switch — no workspace went away.
          const failedEvent: WorkspaceDeleteFailedEvent = {
            type: EVENT_WORKSPACE_DELETE_FAILED,
            payload: workspaceRefIdentity(payload.workspaceRef),
          };
          ctx.emit(failedEvent);
          return { started: false };
        }

        if (result.hasErrors) {
          failed = true;
          // Emit delete-failed to reset idempotency, allowing retry dispatch
          const failedEvent: WorkspaceDeleteFailedEvent = {
            type: EVENT_WORKSPACE_DELETE_FAILED,
            payload: workspaceRefIdentity(payload.workspaceRef),
          };
          ctx.emit(failedEvent);
        } else {
          emitEvent(result.identity);
        }
      } catch (error) {
        // Preflight or unexpected error — emit delete-failed for idempotency reset, then propagate
        const failedEvent: WorkspaceDeleteFailedEvent = {
          type: EVENT_WORKSPACE_DELETE_FAILED,
          payload: workspaceRefIdentity(payload.workspaceRef),
        };
        ctx.emit(failedEvent);
        throw error;
      }
      // A failed deletion leaves the workspace in place, with its progress
      // panel asking Retry or Dismiss. A user who navigated to it is looking at
      // that question; switching away would hide it.
      if (failed) return { started: true };
    }

    // If the user navigated to the workspace after the initial switch-away,
    // switch again before the deletion completes.
    await this.autoSwitchIfActive(ctx, payload.workspaceRef);
    return { started: true };
  }

  private async runPipeline(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    emit: EmitFn
  ): Promise<PipelineResult> {
    const { payload } = ctx.intent;

    // --- Resolve (workspaceRef → path, project, workspaceName, projectId) ---
    const resolved = await resolveWorkspaceIdentity(ctx.dispatch, payload.workspaceRef);
    const { workspacePath, projectRef, projectPath, workspaceName, active } = resolved;

    const identity: ResolvedIdentity = workspaceIdentityPayload(resolved);
    const target = { workspaceRef: payload.workspaceRef, workspacePath, projectRef, projectPath };

    // --- Confirm (interactive dispatches only) ---
    // Parks on the confirmation dialog BEFORE any pipeline work or progress
    // emission (and outside the safety net below — a confirm failure aborts
    // like a preflight failure, it never fakes a terminal progress event).
    // A confirmed dispatch proceeds with the user's keepBranch answer and
    // ignoreWarnings semantics: the dialog just showed the warnings.
    let effectivePayload = payload;
    if (payload.interactive && payload.removeWorktree && !payload.force) {
      const confirmCtx: DeletePipelineHookInput = {
        intent: ctx.intent,
        ...target,
        workspaceName,
        active,
      };
      const { results: confirmResults, errors: confirmErrors } = await ctx.hooks.collect(
        "confirm",
        confirmCtx
      );
      throwHookErrors(confirmErrors, "workspace:delete confirm hooks failed");
      if (confirmResults.some((r) => r.canceled)) {
        return { hasErrors: false, identity, canceled: true };
      }
      effectivePayload = {
        ...payload,
        keepBranch:
          onlyDefined(confirmResults, "keepBranch", "workspace:delete confirm") ??
          payload.keepBranch,
        ignoreWarnings: true,
      };
    }

    // Build enriched context for downstream hooks. The intent carries the
    // effective payload so hooks (e.g. the delete hook's keepBranch) see the
    // confirmed values.
    const pipelineCtx: DeletePipelineHookInput = {
      intent: { ...ctx.intent, payload: effectivePayload },
      ...target,
      workspaceName,
      active,
    };

    // --- Preflight (modules veto on workspace state) ---
    // Sits beside confirm and outside the safety net below: a gate that refuses
    // must leave the workspace untouched, with no progress event ever emitted.
    // Whether the check applies, and what its findings mean, belong to the
    // handlers — this only sequences the gate and shapes the caller's error.
    const {
      results: preflightResults,
      errors: preflightCollectErrors,
      capabilities: preflightCapabilities,
    } = await ctx.hooks.collect("preflight", pipelineCtx);
    throwHookErrors(preflightCollectErrors, "workspace:delete preflight hooks failed");
    const reasons = preflightResults.filter((r) => r.blocked).map((r) => r.reason ?? "blocked");
    if (reasons.length > 0) {
      throw new Error(`Preflight check failed: ${reasons.join("; ")}`);
    }

    // Whether this repository has a hook for the "pre-delete" stage, learned
    // here because preflight is the last thing that runs before the first
    // progress event. Without it the hook's row could only be created once the
    // hook started, which makes it appear halfway through a list the user is
    // already reading. Absent for a repository with no hook, which is the whole
    // point — a step that will never do anything should not be listed at all.
    const repoHookPresent = preflightCapabilities?.[CAPABILITY_REPO_HOOK] === true;

    // Safety net: catch unexpected errors after identity resolution to ensure
    // the UI always receives a terminal progress event (completed: true).
    // Without this, an unexpected throw after the first progress emission
    // leaves the UI permanently stuck on "Removing workspace".
    try {
      return await this.runPipelineBody(
        ctx,
        emit,
        identity,
        pipelineCtx,
        effectivePayload,
        repoHookPresent
      );
    } catch {
      this.emitPipelineProgress(
        emit,
        identity,
        effectivePayload,
        {},
        {
          completed: true,
          hasErrors: true,
        }
      );
      return { hasErrors: true, identity };
    }
  }

  private async runPipelineBody(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    emit: EmitFn,
    identity: ResolvedIdentity,
    pipelineCtx: DeletePipelineHookInput,
    payload: DeleteWorkspacePayload,
    repoHookPresent: boolean
  ): Promise<PipelineResult> {
    // The row is listed from the first progress event, so it never appears
    // mid-list — but only on the path that will actually run the stage: a
    // runtime-only teardown stops before it, and force skips it outright.
    const state: PipelineState =
      repoHookPresent && payload.removeWorktree && !payload.force ? { repoHookPresent: true } : {};
    /** Report the pipeline as still running, `step` in progress. */
    const report = (step: DeletionOperationId): void =>
      this.emitPipelineProgress(emit, identity, payload, state, {
        completed: false,
        hasErrors: false,
        currentStep: step,
      });
    /** Report the pipeline as finished and return its result. */
    const finish = (hasErrors: boolean): PipelineResult => {
      this.emitPipelineProgress(emit, identity, payload, state, { completed: true, hasErrors });
      return { hasErrors, identity };
    };

    // --- Shutdown ---
    report("kill-terminals");
    const { results: shutdownResults, errors: shutdownCollectErrors } = await ctx.hooks.collect(
      "shutdown",
      pipelineCtx
    );
    const shutdown = mergeShutdown(shutdownResults, shutdownCollectErrors);
    state.shutdown = shutdown;
    report("cleanup-workspace");

    // Dispatch workspace:switch(auto) if the deleted workspace is the one on
    // screen. Auto-select mode finds the best candidate via find-candidates.
    //
    // Asked here, where it is acted on, and not a step earlier. Everything
    // before this point is slow and user-facing — the interactive confirm hook
    // is a dialog the user sits in front of (12s in PostHog issue 019fb79f),
    // and the shutdown hooks kill terminals and stop servers for seconds after
    // it — and a user who switches during any of that has said where they want
    // to be. An answer sampled earlier is only a claim about the past: reading
    // it before the shutdown hooks still overruled a user who switched two
    // seconds later.
    //
    // `get-active-workspace` reports what is on screen, which is the question
    // being asked. It survives the teardown: only a workspace:switched event
    // moves it, so with nobody switching it still names the workspace being
    // deleted. (The `active` flag on workspace:resolve is a different field,
    // and that one is cleared during shutdown.)
    if (!payload.skipSwitch) {
      await this.autoSwitchIfActive(ctx, payload.workspaceRef);
    }

    if (shutdown.errors.length > 0 && !payload.force) {
      return finish(true);
    }

    // When removeWorktree is false, skip "release" and "delete" hooks (runtime teardown only)
    if (!payload.removeWorktree) {
      return finish(false);
    }

    // --- Pre-delete (the repository's own gate) ---
    // Runs before "release" on purpose: the CWD scan and kill that follows is
    // what cleans up after a handler that left a process holding the worktree.
    // Skipped in force mode — force is how the user escapes a gate that refuses
    // or hangs, and the progress panel's Dismiss button takes exactly that path.
    if (!payload.force) {
      let started = false;
      const { results: preDeleteResults, errors: preDeleteCollectErrors } = await ctx.hooks.collect(
        "pre-delete",
        pipelineCtx,
        {
          onYield: () => {
            if (started) return;
            started = true;
            report("repo-hook");
          },
        }
      );

      // A returned `blocked` is a policy refusal; a handler that throws could not
      // tell. Both stop the deletion — the gate fails closed either way — and both
      // land on the same row, so the panel reads the same whichever it was.
      const refusals = preDeleteResults.filter((r) => r.blocked).map((r) => r.reason ?? "blocked");
      const messages = [...refusals, ...preDeleteCollectErrors.map((e) => e.message)];

      if (messages.length > 0) {
        state.preDelete = { errors: messages };
        return finish(true);
      }

      // Only keep a clean row when a handler reported for duty. Without a yield
      // no hook existed, and the step must leave no trace on the panel.
      if (started) {
        state.preDelete = { errors: [] };
      }
    }

    // --- Release (CWD scan + kill) ---
    const { results: releaseResults, errors: releaseCollectErrors } = await ctx.hooks.collect(
      "release",
      pipelineCtx
    );
    state.release = mergeErrors(releaseResults, releaseCollectErrors);
    report("cleanup-workspace");

    // --- Flush (kill provided PIDs from previous attempt) ---
    // Its row is reported whatever the removal does next: on a failed removal
    // (forced, or followed by blocker detection) whether the kill worked is part
    // of the explanation, not something to drop.
    if (payload.blockingPids && payload.blockingPids.length > 0) {
      report("killing-blockers");
      const flushCtx: FlushHookInput = {
        ...pipelineCtx,
        blockingPids: payload.blockingPids,
      };
      const { results: flushResults, errors: flushCollectErrors } = await ctx.hooks.collect(
        "flush",
        flushCtx
      );
      state.flush = mergeErrors(flushResults, flushCollectErrors);
    }

    // --- Delete ---
    const { results: deleteResults, errors: deleteCollectErrors } = await ctx.hooks.collect(
      "delete",
      pipelineCtx
    );
    state.del = mergeErrors(deleteResults, deleteCollectErrors);

    if (state.del.errors.length === 0) {
      return finish(false);
    }

    // Delete failed — if force mode, report it and stop
    if (payload.force) {
      return finish(true);
    }

    // --- Detect blockers (full scan after failure) ---
    report("detecting-blockers");
    const { results: detectResults, errors: detectCollectErrors } = await ctx.hooks.collect(
      "detect",
      pipelineCtx
    );
    state.detect = mergeDetect(detectResults, detectCollectErrors);
    return finish(true);
  }

  /**
   * The workspace currently on screen, or null when none is. Best-effort: a
   * failure answers null, which reads as "nothing claimed the surface" — the
   * same answer as an ordinary teardown, so a lookup failure never moves a
   * user who had gone somewhere else.
   */
  private async activeRefOrNull(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>
  ): Promise<WorkspaceRef | null> {
    return activeWorkspaceRef(ctx.dispatch).catch(() => null);
  }

  /**
   * Switch away from `workspaceRef` (auto-select) if it is the one on screen.
   * Best-effort: a failed switch never fails the deletion.
   */
  private async autoSwitchIfActive(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    workspaceRef: WorkspaceRef
  ): Promise<void> {
    if ((await this.activeRefOrNull(ctx)) !== workspaceRef) return;
    try {
      await ctx.dispatch<SwitchWorkspaceIntent>({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentRef: workspaceRef, focus: true },
      });
    } catch {
      // Best-effort
    }
  }

  /**
   * Build DeletionOperation[] from pipeline state and emit progress.
   */
  private emitPipelineProgress(
    emit: EmitFn,
    identity: ResolvedIdentity,
    payload: DeleteWorkspacePayload,
    state: Readonly<PipelineState>,
    progress: {
      readonly completed: boolean;
      readonly hasErrors: boolean;
      readonly currentStep?: DeletionOperationId;
    }
  ): void {
    const { completed, hasErrors, currentStep } = progress;
    const operations: DeletionOperation[] = [];

    const applyCurrentStep = (
      id: DeletionOperationId,
      status: DeletionOperationStatus
    ): DeletionOperationStatus => (currentStep === id ? "in-progress" : status);

    // Shutdown operations (always present)
    const shutdownStatus = this.hookPointStatus(state.shutdown);
    const shutdownError =
      state.shutdown && state.shutdown.errors.length > 0
        ? state.shutdown.errors.join("; ")
        : undefined;

    operations.push({
      id: "kill-terminals",
      label: "Terminating processes",
      status: applyCurrentStep("kill-terminals", shutdownStatus),
    });
    operations.push({
      id: "stop-server",
      label: `Stopping ${state.shutdown?.serverName ?? "agent"} server`,
      status: applyCurrentStep("stop-server", shutdownStatus),
      ...(shutdownError && { error: shutdownError }),
    });
    operations.push({
      id: "cleanup-vscode",
      label: "Closing VS Code view",
      status: applyCurrentStep("cleanup-vscode", shutdownStatus),
      ...(shutdownError && { error: shutdownError }),
    });

    // Repository hook row. Present only for a repository that actually has a
    // hook — most define none, and a row for a step that never does anything
    // would show on every deletion everywhere. Its presence is settled during
    // preflight, before the first progress event, so the row is listed with the
    // rest from the start rather than appearing halfway down the list.
    if (state.repoHookPresent || state.preDelete || currentStep === "repo-hook") {
      const preDeleteError =
        state.preDelete && state.preDelete.errors.length > 0
          ? state.preDelete.errors.join("; ")
          : undefined;
      operations.push({
        id: "repo-hook",
        label: "Running plugin hooks",
        status: applyCurrentStep("repo-hook", this.hookPointStatus(state.preDelete)),
        ...(preDeleteError && { error: preDeleteError }),
      });
    }

    // Delete operation (always present, runs before detect/flush in pipeline)
    const deleteStatus = this.hookPointStatus(state.del);
    // A release failure ("could not kill PID 1234") is reported alongside the
    // removal error rather than on its own row: it is only ever an explanation
    // for why the removal failed. On a successful removal it is noise — the
    // process we could not kill evidently wasn't holding anything — so it is
    // folded in only when there is a delete error to explain.
    const deleteErrors = [
      ...(state.del?.errors ?? []),
      ...(state.del && state.del.errors.length > 0 ? (state.release?.errors ?? []) : []),
    ];
    const deleteError = deleteErrors.length > 0 ? deleteErrors.join("; ") : undefined;

    operations.push({
      id: "cleanup-workspace",
      label: "Removing workspace",
      status: applyCurrentStep("cleanup-workspace", deleteStatus),
      ...(deleteError && { error: deleteError }),
    });

    // Detection operation (from detect hook, shown after delete failure)
    if (state.detect?.blockingProcesses !== undefined) {
      const blockersFound = state.detect.blockingProcesses.length > 0;
      // A detect handler that could not determine the answer reports it here.
      // Without this, an empty list from a scan that timed out is rendered as a
      // clean "done" — telling the user nothing is blocking the very removal
      // that just refused to proceed. "We don't know" is the honest state, and
      // it is the one that makes a retry worth attempting.
      const detectError =
        state.detect.errors.length > 0 ? state.detect.errors.join("; ") : undefined;
      const status = blockersFound || detectError ? "error" : "done";
      operations.push({
        id: "detecting-blockers",
        label: "Detecting blocking processes...",
        status: applyCurrentStep("detecting-blockers", status),
        ...((blockersFound || detectError) && {
          error: blockersFound
            ? `Blocked by ${state.detect.blockingProcesses.length} process(es)`
            : detectError,
        }),
      });
    } else if (currentStep === "detecting-blockers") {
      operations.push({
        id: "detecting-blockers",
        label: "Detecting blocking processes...",
        status: "in-progress",
      });
    }

    // Flush operation (from flush hook, shown when killing blockers)
    if (state.flush) {
      const flushError = state.flush.errors.length > 0 ? state.flush.errors[0] : undefined;
      operations.push({
        id: "killing-blockers",
        label: "Killing blocking processes...",
        status: applyCurrentStep("killing-blockers", flushError ? "error" : "done"),
        ...(flushError && { error: flushError }),
      });
    } else if (currentStep === "killing-blockers") {
      operations.push({
        id: "killing-blockers",
        label: "Killing blocking processes...",
        status: "in-progress",
      });
    }

    // Build blocking processes from detect results
    const blockingProcesses =
      state.detect?.blockingProcesses && state.detect.blockingProcesses.length > 0
        ? state.detect.blockingProcesses
        : undefined;

    const progressEvent: WorkspaceDeletionProgressEvent = {
      type: EVENT_WORKSPACE_DELETION_PROGRESS,
      payload: {
        ...identity,
        keepBranch: payload.keepBranch,
        operations,
        completed,
        hasErrors,
        ...(blockingProcesses !== undefined && { blockingProcesses }),
      },
    };
    emit(progressEvent);
  }

  private hookPointStatus(
    merged: { readonly errors: readonly string[] } | undefined
  ): "pending" | "done" | "error" {
    if (!merged) return "pending";
    return merged.errors.length > 0 ? "error" : "done";
  }
}
