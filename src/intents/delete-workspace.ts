/**
 * DeleteWorkspaceOperation - Orchestrates workspace deletion.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — resolves workspacePath to projectPath + workspaceName
 * 2. Dispatch project:resolve — resolves projectPath to projectId
 * 3. "shutdown" hook — ViewModule (switch + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI)
 * 4. "release" hook — WindowsLockModule (detect CWD + kill) [Windows-only]
 * 5. If blockingPids provided (retry): "flush" hook — kill provided PIDs
 * 6. "delete" hook — WorktreeModule (remove git worktree), IdeServerModule (delete .code-workspace file)
 *
 * If delete fails (and not force):
 * 7. "detect" — Full blocking process detection (RM + CWD + handles)
 * 8. Emit progress with blockers, emit workspace:delete-failed, return
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
  ProjectId,
  WorkspaceName,
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
  projectIdSchema,
  projectPathSchema,
  workspaceNameSchema,
  workspacePathSchema,
} from "./contract";
import type { ProjectPath, WorkspacePath } from "./contract";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { resolveWorkspaceIdentity } from "./lib/workspace-identity";
import { INTENT_GET_ACTIVE_WORKSPACE, type GetActiveWorkspaceIntent } from "./get-active-workspace";
import { INTENT_GET_PROJECT_BASES, type GetProjectBasesIntent } from "./get-project-bases";
import { throwHookErrors, collectErrorMessages, lastDefined } from "./lib/hook-helpers";

export const INTENT_DELETE_WORKSPACE = "workspace:delete" as const;
export const DELETE_WORKSPACE_OPERATION_ID = "delete-workspace";

export const EVENT_WORKSPACE_DELETED = "workspace:deleted" as const;
export const EVENT_WORKSPACE_DELETE_FAILED = "workspace:delete-failed" as const;
export const EVENT_WORKSPACE_DELETION_PROGRESS = "workspace:deletion-progress" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const deleteWorkspacePayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
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
     * keepBranch or cancels. Programmatic callers (MCP, plugin, auto-workspace)
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
 * Checks workspace for uncommitted changes and unmerged commits before deletion.
 */
export const preflightResultSchema = z
  .object({
    isDirty: z.boolean().optional(),
    unmergedCommits: z.number().optional(),
    error: z.string().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "shutdown" hook point.
 * ViewModule provides wasActive; AgentModule may provide error.
 */
export const shutdownResultSchema = z
  .object({
    wasActive: z.boolean().optional(),
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
  projectPath: projectPathSchema,
  workspacePath: workspacePathSchema,
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
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    workspacePath: workspacePathSchema,
    projectPath: projectPathSchema,
    /**
     * True when the dispatch removed (or force-abandoned) the git worktree;
     * false for runtime-only teardown (removeWorktree: false — e.g. the
     * per-workspace teardown during project:close). Consumers that track real
     * deletions (auto-workspace dismissal) must ignore teardown events.
     */
    worktreeRemoved: z.boolean(),
  })
  .readonly();

const workspaceDeleteFailedSchema = z.object({ workspacePath: workspacePathSchema }).readonly();

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
  readonly wasActive: boolean;
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
  let wasActive = false;
  let serverName: string | undefined;
  for (const r of results) {
    if (r.wasActive) wasActive = true;
    if (r.serverName && !serverName) serverName = r.serverName;
  }
  return { wasActive, serverName, errors: errorMessages(results, collectErrors) };
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
  let blockingProcesses: readonly BlockingProcess[] | undefined;
  for (const r of results) {
    if (r.blockingProcesses !== undefined) blockingProcesses = r.blockingProcesses;
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

interface PipelineState {
  readonly shutdown?: MergedShutdown;
  readonly release?: MergedErrors;
  readonly del?: MergedErrors;
  readonly detect?: MergedDetect;
  readonly flush?: MergedErrors;
}

// =============================================================================
// Operation
// =============================================================================

/** Resolved identity from dispatch, needed for events and progress. */
interface ResolvedIdentity {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly projectPath: ProjectPath;
}

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
        payload: {
          projectId: identity.projectId,
          workspaceName: identity.workspaceName,
          workspacePath: payload.workspacePath,
          projectPath: identity.projectPath,
          worktreeRemoved: payload.removeWorktree,
        },
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
      try {
        const result = await this.runPipeline(ctx, ctx.emit);

        if (result.canceled) {
          // User declined the interactive confirm: nothing ran. Emit
          // delete-failed so the per-key idempotency guard resets (the event
          // means "dispatch ended without deletion"), and skip the
          // auto-switch — no workspace went away.
          const failedEvent: WorkspaceDeleteFailedEvent = {
            type: EVENT_WORKSPACE_DELETE_FAILED,
            payload: { workspacePath: payload.workspacePath },
          };
          ctx.emit(failedEvent);
          return { started: false };
        }

        if (result.hasErrors) {
          // Emit delete-failed to reset idempotency, allowing retry dispatch
          const failedEvent: WorkspaceDeleteFailedEvent = {
            type: EVENT_WORKSPACE_DELETE_FAILED,
            payload: { workspacePath: payload.workspacePath },
          };
          ctx.emit(failedEvent);
        } else {
          emitEvent(result.identity);
        }
      } catch (error) {
        // Preflight or unexpected error — emit delete-failed for idempotency reset, then propagate
        const failedEvent: WorkspaceDeleteFailedEvent = {
          type: EVENT_WORKSPACE_DELETE_FAILED,
          payload: { workspacePath: payload.workspacePath },
        };
        ctx.emit(failedEvent);
        throw error;
      }
    }

    await this.autoSwitchIfBecameActive(ctx, payload.workspacePath);
    return { started: true };
  }

  private async runPipeline(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    emit: EmitFn
  ): Promise<PipelineResult> {
    const { payload } = ctx.intent;

    // --- Resolve (workspacePath → projectPath + workspaceName + projectId) ---
    const { projectPath, workspaceName, active, projectId } = await resolveWorkspaceIdentity(
      ctx.dispatch,
      payload.workspacePath
    );

    const identity: ResolvedIdentity = { projectId, workspaceName, projectPath };

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
        projectPath,
        workspacePath: payload.workspacePath,
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
        keepBranch: lastDefined(confirmResults, (r) => r.keepBranch) ?? payload.keepBranch,
        ignoreWarnings: true,
      };
    }

    // Build enriched context for downstream hooks. The intent carries the
    // effective payload so hooks (e.g. the delete hook's keepBranch) see the
    // confirmed values.
    const pipelineCtx: DeletePipelineHookInput = {
      intent: { ...ctx.intent, payload: effectivePayload },
      projectPath,
      workspacePath: payload.workspacePath,
      workspaceName,
      active,
    };

    // Safety net: catch unexpected errors after identity resolution to ensure
    // the UI always receives a terminal progress event (completed: true).
    // Without this, an unexpected throw after the first progress emission
    // leaves the UI permanently stuck on "Removing workspace".
    try {
      return await this.runPipelineBody(ctx, emit, identity, pipelineCtx, effectivePayload);
    } catch (error) {
      // Preflight errors must propagate (no progress events emitted yet)
      if (error instanceof Error && error.message.startsWith("Preflight check failed:"))
        throw error;
      this.emitPipelineProgress(emit, identity, effectivePayload, {}, true, true);
      return { hasErrors: true, identity };
    }
  }

  private async runPipelineBody(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    emit: EmitFn,
    identity: ResolvedIdentity,
    pipelineCtx: DeletePipelineHookInput,
    payload: DeleteWorkspacePayload
  ): Promise<PipelineResult> {
    // --- Preflight (dirty/unmerged check) ---
    if (payload.removeWorktree && !payload.force && !payload.ignoreWarnings) {
      // Fetch first so the unmerged count is measured against current refs. The
      // interactive path gets this via get-workspace-status {refresh: true}; without
      // it here, a programmatic delete right after a server-side merge (e.g. /ship)
      // compares against a stale origin/main and rejects the just-merged commits as
      // unmerged. Best-effort — a fetch failure falls through to the stale-ref read
      // rather than blocking the delete.
      try {
        await ctx.dispatch<GetProjectBasesIntent>({
          type: INTENT_GET_PROJECT_BASES,
          payload: { projectPath: identity.projectPath, refresh: true, wait: true },
        });
      } catch {
        // Fall through to the preflight read with possibly-stale refs.
      }

      const { results: preflightResults, errors: preflightCollectErrors } = await ctx.hooks.collect(
        "preflight",
        pipelineCtx
      );

      let isDirty = false;
      let unmergedCommits = 0;
      throwHookErrors(preflightCollectErrors, "workspace:delete preflight hooks failed");
      for (const r of preflightResults) {
        if (r.isDirty) isDirty = true;
        if (r.unmergedCommits !== undefined && r.unmergedCommits > unmergedCommits)
          unmergedCommits = r.unmergedCommits;
        if (r.error) throw new Error(r.error);
      }

      if (isDirty || unmergedCommits > 0) {
        const messages: string[] = [];
        if (isDirty) messages.push("Workspace has uncommitted changes");
        if (unmergedCommits > 0)
          messages.push(
            `Workspace has ${unmergedCommits} unmerged commit${unmergedCommits === 1 ? "" : "s"}`
          );
        throw new Error(`Preflight check failed: ${messages.join("; ")}`);
      }
    }

    // --- Shutdown ---
    this.emitPipelineProgress(emit, identity, payload, {}, false, false, "kill-terminals");
    const { results: shutdownResults, errors: shutdownCollectErrors } = await ctx.hooks.collect(
      "shutdown",
      pipelineCtx
    );
    const shutdown = mergeShutdown(shutdownResults, shutdownCollectErrors);
    this.emitPipelineProgress(
      emit,
      identity,
      payload,
      { shutdown },
      false,
      false,
      "cleanup-workspace"
    );

    // Dispatch workspace:switch(auto) if deleted workspace was the active one.
    // Auto-select mode finds the best candidate via find-candidates hook.
    if (shutdown.wasActive && !payload.skipSwitch) {
      try {
        const switchIntent: SwitchWorkspaceIntent = {
          type: INTENT_SWITCH_WORKSPACE,
          payload: { auto: true, currentPath: payload.workspacePath, focus: true },
        };
        await ctx.dispatch(switchIntent);
      } catch {
        // Best-effort: switch failure doesn't fail the deletion
      }
    }

    const shutdownFailed = shutdown.errors.length > 0;
    if (shutdownFailed && !payload.force) {
      this.emitPipelineProgress(emit, identity, payload, { shutdown }, true, true);
      return { hasErrors: true, identity };
    }

    // When removeWorktree is false, skip "release" and "delete" hooks (runtime teardown only)
    if (!payload.removeWorktree) {
      this.emitPipelineProgress(emit, identity, payload, { shutdown }, true, false);
      return { hasErrors: false, identity };
    }

    // --- Release (CWD scan + kill) ---
    const { results: releaseResults, errors: releaseCollectErrors } = await ctx.hooks.collect(
      "release",
      pipelineCtx
    );
    const release = mergeErrors(releaseResults, releaseCollectErrors);
    this.emitPipelineProgress(
      emit,
      identity,
      payload,
      { shutdown, release },
      false,
      false,
      "cleanup-workspace"
    );

    // --- Flush (kill provided PIDs from previous attempt) ---
    let flush: MergedErrors | undefined;
    if (payload.blockingPids && payload.blockingPids.length > 0) {
      this.emitPipelineProgress(
        emit,
        identity,
        payload,
        { shutdown, release },
        false,
        false,
        "killing-blockers"
      );
      const flushCtx: FlushHookInput = {
        ...pipelineCtx,
        blockingPids: payload.blockingPids,
      };
      const { results: flushResults, errors: flushCollectErrors } = await ctx.hooks.collect(
        "flush",
        flushCtx
      );
      flush = mergeErrors(flushResults, flushCollectErrors);
    }

    // --- Delete ---
    const { results: deleteResults, errors: deleteCollectErrors } = await ctx.hooks.collect(
      "delete",
      pipelineCtx
    );
    const del = mergeErrors(deleteResults, deleteCollectErrors);

    const deleteFailed = del.errors.length > 0;
    if (!deleteFailed) {
      // Success
      this.emitPipelineProgress(
        emit,
        identity,
        payload,
        { shutdown, release, del, ...(flush && { flush }) },
        true,
        false
      );
      return { hasErrors: false, identity };
    }

    // Delete failed — if force mode, emit and return
    if (payload.force) {
      const hasErrors = shutdownFailed || deleteFailed;
      this.emitPipelineProgress(
        emit,
        identity,
        payload,
        { shutdown, release, del },
        true,
        hasErrors
      );
      return { hasErrors, identity };
    }

    // --- Detect blockers (full scan after failure) ---
    this.emitPipelineProgress(
      emit,
      identity,
      payload,
      { shutdown, release, del },
      false,
      false,
      "detecting-blockers"
    );
    const { results: detectResults, errors: detectCollectErrors } = await ctx.hooks.collect(
      "detect",
      pipelineCtx
    );
    const detect = mergeDetect(detectResults, detectCollectErrors);

    // Emit progress with blockers and return failure
    this.emitPipelineProgress(
      emit,
      identity,
      payload,
      { shutdown, release, del, detect },
      true,
      true
    );
    return { hasErrors: true, identity };
  }

  /**
   * If the user navigated to the workspace after the initial switch-away,
   * we must switch again before emitting workspace:deleted.
   */
  private async autoSwitchIfBecameActive(
    ctx: OperationContext<DeleteWorkspaceIntent, typeof schemas>,
    workspacePath: WorkspacePath
  ): Promise<void> {
    try {
      const activeRef = await ctx.dispatch<GetActiveWorkspaceIntent>({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {},
      });
      if (activeRef?.path === workspacePath) {
        await ctx.dispatch<SwitchWorkspaceIntent>({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { auto: true, currentPath: workspacePath, focus: true },
        });
      }
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
    state: PipelineState,
    completed = false,
    hasErrors = false,
    currentStep?: DeletionOperationId
  ): void {
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

    // Delete operation (always present, runs before detect/flush in pipeline)
    const deleteStatus = this.hookPointStatus(state.del);
    const deleteError =
      state.del && state.del.errors.length > 0 ? state.del.errors.join("; ") : undefined;

    operations.push({
      id: "cleanup-workspace",
      label: "Removing workspace",
      status: applyCurrentStep("cleanup-workspace", deleteStatus),
      ...(deleteError && { error: deleteError }),
    });

    // Detection operation (from detect hook, shown after delete failure)
    if (state.detect?.blockingProcesses !== undefined) {
      const blockersFound = state.detect.blockingProcesses.length > 0;
      operations.push({
        id: "detecting-blockers",
        label: "Detecting blocking processes...",
        status: applyCurrentStep("detecting-blockers", blockersFound ? "error" : "done"),
        ...(blockersFound && {
          error: `Blocked by ${state.detect.blockingProcesses.length} process(es)`,
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
        workspacePath: payload.workspacePath as WorkspacePath,
        workspaceName: identity.workspaceName,
        projectId: identity.projectId,
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
