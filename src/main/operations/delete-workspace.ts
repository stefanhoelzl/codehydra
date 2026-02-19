/**
 * DeleteWorkspaceOperation - Orchestrates workspace deletion.
 *
 * Runs hook points in sequence using collect():
 * 1. "resolve-project" - Resolves projectId to projectPath
 * 2. "resolve-workspace" - Resolves workspaceName to workspacePath (with enriched projectPath)
 * 3. "shutdown" - ViewModule (switch + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI)
 * 4. "release" - WindowsLockModule (detect CWD + kill) [Windows-only]
 * 5. "delete" - WorktreeModule (remove git worktree), CodeServerModule (delete .code-workspace file)
 *
 * If delete fails (and not force), enters a retry loop:
 * 6. "detect" - Full blocking process detection (RM + CWD + handles)
 * 7. Emit progress with blockers, wait for user choice (Kill & Retry or Dismiss)
 * 8. "flush" - Kill collected PIDs
 * 9. "delete" - Re-attempt
 * Loop back to 6 if delete fails again.
 *
 * Each handler returns a typed result; the operation merges results and tracks errors.
 * On success (or force=true), emits a workspace:deleted domain event for state cleanup.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type {
  ProjectId,
  WorkspaceName,
  DeletionProgress,
  DeletionOperation,
  DeletionOperationId,
  DeletionOperationStatus,
  BlockingProcess,
} from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";

// =============================================================================
// Intent Types
// =============================================================================

export interface DeleteWorkspacePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath?: string;
  readonly projectPath?: string;
  readonly keepBranch: boolean;
  readonly force: boolean;
  /** Whether to remove the git worktree. true = full pipeline, false = shutdown only (runtime teardown). */
  readonly removeWorktree: boolean;
  readonly skipSwitch?: boolean;
}

export interface DeleteWorkspaceIntent extends Intent<{ started: true }> {
  readonly type: "workspace:delete";
  readonly payload: DeleteWorkspacePayload;
}

export const INTENT_DELETE_WORKSPACE = "workspace:delete" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceDeletedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
}

export interface WorkspaceDeletedEvent extends DomainEvent {
  readonly type: "workspace:deleted";
  readonly payload: WorkspaceDeletedPayload;
}

export const EVENT_WORKSPACE_DELETED = "workspace:deleted" as const;

// =============================================================================
// Hook Result Types (returned by handlers via collect())
// =============================================================================

export const DELETE_WORKSPACE_OPERATION_ID = "delete-workspace";

/**
 * Per-handler result for the "shutdown" hook point.
 * ViewModule provides wasActive; AgentModule may provide error.
 */
export interface ShutdownHookResult {
  readonly wasActive?: boolean;
  readonly serverName?: string;
  readonly error?: string;
}

/**
 * Per-handler result for the "release" hook point.
 * CWD-only scan: finds and kills processes with CWD under workspace.
 */
export interface ReleaseHookResult {
  readonly error?: string;
}

/**
 * Per-handler result for the "delete" hook point.
 */
export interface DeleteHookResult {
  readonly error?: string;
}

/**
 * Per-handler result for the "detect" hook point.
 * Full blocking process detection after delete failure.
 */
export interface DetectHookResult {
  readonly blockingProcesses?: readonly BlockingProcess[];
  readonly error?: string;
}

/**
 * Per-handler result for the "flush" hook point.
 * Kills blocking processes by PID.
 */
export interface FlushHookResult {
  readonly error?: string;
}

/**
 * Per-handler result for the "resolve-project" hook point.
 */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
}

/**
 * Per-handler result for the "resolve-workspace" hook point.
 */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

/** Input for resolve-workspace hook (enriched with projectPath from resolve-project). */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
}

/** Input for shutdown/release/delete/detect hooks (enriched with both resolved paths). */
export interface DeletePipelineHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspacePath: string;
}

/** Input for flush hook (enriched with PIDs to kill). */
export interface FlushHookInput extends DeletePipelineHookInput {
  readonly blockingPids: readonly number[];
}

// =============================================================================
// Merged Result Types (internal to operation)
// =============================================================================

interface MergedResolveProject {
  readonly projectPath?: string;
  readonly errors: readonly string[];
}

interface MergedResolveWorkspace {
  readonly workspacePath?: string;
  readonly errors: readonly string[];
}

interface MergedShutdown {
  readonly wasActive: boolean;
  readonly serverName: string | undefined;
  readonly errors: readonly string[];
}

interface MergedRelease {
  readonly errors: readonly string[];
}

interface MergedDelete {
  readonly errors: readonly string[];
}

interface MergedDetect {
  readonly blockingProcesses?: readonly BlockingProcess[];
  readonly errors: readonly string[];
}

interface MergedFlush {
  readonly errors: readonly string[];
}

// =============================================================================
// Merge Functions
// =============================================================================

function mergeResolveProject(
  results: readonly ResolveProjectHookResult[],
  collectErrors: readonly Error[]
): MergedResolveProject {
  let projectPath: string | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.projectPath !== undefined) projectPath = r.projectPath;
  }

  return { ...(projectPath !== undefined && { projectPath }), errors };
}

function mergeResolveWorkspace(
  results: readonly ResolveWorkspaceHookResult[],
  collectErrors: readonly Error[]
): MergedResolveWorkspace {
  let workspacePath: string | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.workspacePath !== undefined) workspacePath = r.workspacePath;
  }

  return { ...(workspacePath !== undefined && { workspacePath }), errors };
}

function mergeShutdown(
  results: readonly ShutdownHookResult[],
  collectErrors: readonly Error[]
): MergedShutdown {
  let wasActive = false;
  let serverName: string | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.wasActive) wasActive = true;
    if (r.serverName && !serverName) serverName = r.serverName;
    if (r.error) errors.push(r.error);
  }

  return { wasActive, serverName, errors };
}

function mergeRelease(
  results: readonly ReleaseHookResult[],
  collectErrors: readonly Error[]
): MergedRelease {
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.error) errors.push(r.error);
  }

  return { errors };
}

function mergeDelete(
  results: readonly DeleteHookResult[],
  collectErrors: readonly Error[]
): MergedDelete {
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.error) errors.push(r.error);
  }

  return { errors };
}

function mergeDetect(
  results: readonly DetectHookResult[],
  collectErrors: readonly Error[]
): MergedDetect {
  let blockingProcesses: readonly BlockingProcess[] | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.blockingProcesses !== undefined) blockingProcesses = r.blockingProcesses;
    if (r.error) errors.push(r.error);
  }

  return {
    ...(blockingProcesses !== undefined && { blockingProcesses }),
    errors,
  };
}

function mergeFlush(
  results: readonly FlushHookResult[],
  collectErrors: readonly Error[]
): MergedFlush {
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.error) errors.push(r.error);
  }

  return { errors };
}

// =============================================================================
// Progress Callback Type
// =============================================================================

/**
 * Callback for emitting deletion progress events.
 */
export type DeletionProgressCallback = (progress: DeletionProgress) => void;

// =============================================================================
// Pipeline State (for progress emission)
// =============================================================================

interface PipelineState {
  readonly resolveProject?: MergedResolveProject;
  readonly resolveWorkspace?: MergedResolveWorkspace;
  readonly shutdown?: MergedShutdown;
  readonly release?: MergedRelease;
  readonly del?: MergedDelete;
  readonly detect?: MergedDetect;
  readonly flush?: MergedFlush;
}

// =============================================================================
// Operation
// =============================================================================

/** Return value of runPipeline, carrying resolved paths for emitEvent. */
interface PipelineResult {
  readonly hasErrors: boolean;
  readonly resolvedProjectPath: string;
  readonly resolvedWorkspacePath: string;
}

export class DeleteWorkspaceOperation implements Operation<
  DeleteWorkspaceIntent,
  { started: true }
> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  /** Pending retry resolvers keyed by workspace path. */
  private readonly retryResolvers = new Map<string, (choice: "retry" | "dismiss") => void>();

  constructor(private readonly emitProgress: DeletionProgressCallback) {}

  /**
   * Wait for user choice (Kill & Retry or Dismiss) for a workspace.
   * Resolves when signalRetry or signalDismiss is called.
   */
  waitForRetryChoice(wsPath: string): Promise<"retry" | "dismiss"> {
    return new Promise<"retry" | "dismiss">((resolve) => {
      this.retryResolvers.set(wsPath, resolve);
    });
  }

  /** Signal that the user chose Kill & Retry. */
  signalRetry(wsPath: string): void {
    const resolver = this.retryResolvers.get(wsPath);
    if (resolver) {
      this.retryResolvers.delete(wsPath);
      resolver("retry");
    }
  }

  /** Signal that the user chose Dismiss. */
  signalDismiss(wsPath: string): void {
    const resolver = this.retryResolvers.get(wsPath);
    if (resolver) {
      this.retryResolvers.delete(wsPath);
      resolver("dismiss");
    }
  }

  /** Check if a workspace has a pending retry choice. */
  hasPendingRetry(wsPath: string): boolean {
    return this.retryResolvers.has(wsPath);
  }

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;

    const emitEvent = (projectPath: string, workspacePath: string): void => {
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath,
          projectPath,
        },
      };
      ctx.emit(event);
    };

    if (payload.force) {
      let resolvedProjectPath = payload.projectPath ?? "";
      let resolvedWorkspacePath = payload.workspacePath ?? "";
      try {
        const result = await this.runPipeline(ctx);
        resolvedProjectPath = result.resolvedProjectPath;
        resolvedWorkspacePath = result.resolvedWorkspacePath;
      } finally {
        // Force mode: always emit workspace:deleted for state cleanup
        emitEvent(resolvedProjectPath, resolvedWorkspacePath);
      }
    } else {
      const result = await this.runPipeline(ctx);

      // Normal mode: only emit if no errors
      if (!result.hasErrors) {
        emitEvent(result.resolvedProjectPath, result.resolvedWorkspacePath);
      }
    }

    return { started: true };
  }

  private async runPipeline(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<PipelineResult> {
    const { payload } = ctx.intent;
    const hookCtx: HookContext = { intent: ctx.intent };

    // --- Resolve Project ---
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", hookCtx);
    const resolveProject = mergeResolveProject(resolveProjectResults, resolveProjectErrors);

    // --- Resolve Workspace ---
    const resolvedProjectPath = resolveProject.projectPath ?? payload.projectPath;
    if (!resolvedProjectPath) {
      throw new Error("resolve-project hook did not provide projectPath");
    }
    const resolveWsCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath: resolvedProjectPath,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWsCtx);
    const resolveWorkspace = mergeResolveWorkspace(resolveWorkspaceResults, resolveWorkspaceErrors);

    const resolvedWorkspacePath = resolveWorkspace.workspacePath ?? payload.workspacePath;
    if (!resolvedWorkspacePath) {
      throw new Error("resolve-workspace hook did not provide workspacePath");
    }

    // Build enriched context for downstream hooks
    const pipelineCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: resolvedProjectPath,
      workspacePath: resolvedWorkspacePath,
    };

    // --- Shutdown ---
    this.emitPipelineProgress(payload, resolvedWorkspacePath, {}, false, false, "kill-terminals");
    const { results: shutdownResults, errors: shutdownCollectErrors } =
      await ctx.hooks.collect<ShutdownHookResult>("shutdown", pipelineCtx);
    const shutdown = mergeShutdown(shutdownResults, shutdownCollectErrors);
    this.emitPipelineProgress(
      payload,
      resolvedWorkspacePath,
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
          payload: { auto: true, currentPath: resolvedWorkspacePath, focus: true },
        };
        await ctx.dispatch(switchIntent);
      } catch {
        // Best-effort: switch failure doesn't fail the deletion
      }
    }

    const shutdownFailed = shutdown.errors.length > 0;
    if (shutdownFailed && !payload.force) {
      this.emitPipelineProgress(payload, resolvedWorkspacePath, { shutdown }, true, true);
      return { hasErrors: true, resolvedProjectPath, resolvedWorkspacePath };
    }

    // When removeWorktree is false, skip "release" and "delete" hooks (runtime teardown only)
    if (!payload.removeWorktree) {
      this.emitPipelineProgress(payload, resolvedWorkspacePath, { shutdown }, true, false);
      return { hasErrors: false, resolvedProjectPath, resolvedWorkspacePath };
    }

    // --- Release (CWD scan + kill) ---
    const { results: releaseResults, errors: releaseCollectErrors } =
      await ctx.hooks.collect<ReleaseHookResult>("release", pipelineCtx);
    const release = mergeRelease(releaseResults, releaseCollectErrors);
    this.emitPipelineProgress(
      payload,
      resolvedWorkspacePath,
      { shutdown, release },
      false,
      false,
      "cleanup-workspace"
    );

    // --- Delete ---
    const { results: deleteResults, errors: deleteCollectErrors } =
      await ctx.hooks.collect<DeleteHookResult>("delete", pipelineCtx);
    const del = mergeDelete(deleteResults, deleteCollectErrors);

    const deleteFailed = del.errors.length > 0;
    if (!deleteFailed) {
      // Success
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del },
        true,
        false
      );
      return { hasErrors: false, resolvedProjectPath, resolvedWorkspacePath };
    }

    // Delete failed — if force mode, emit and return
    if (payload.force) {
      const hasErrors = shutdownFailed || deleteFailed;
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del },
        true,
        hasErrors
      );
      return { hasErrors, resolvedProjectPath, resolvedWorkspacePath };
    }

    // --- Retry loop: detect → emit → wait → flush → delete ---
    let currentDel = del;
    for (;;) {
      // Detect
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del: currentDel },
        false,
        false,
        "detecting-blockers"
      );
      const { results: detectResults, errors: detectCollectErrors } =
        await ctx.hooks.collect<DetectHookResult>("detect", pipelineCtx);
      const detect = mergeDetect(detectResults, detectCollectErrors);

      // Emit progress with blockers and wait for user choice
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del: currentDel, detect },
        true,
        true
      );

      const choice = await this.waitForRetryChoice(resolvedWorkspacePath);
      if (choice === "dismiss") {
        return { hasErrors: true, resolvedProjectPath, resolvedWorkspacePath };
      }

      // Flush (kill collected PIDs)
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del: currentDel, detect },
        false,
        false,
        "killing-blockers"
      );
      const blockingPids = detect.blockingProcesses?.map((p) => p.pid) ?? [];
      const flushCtx: FlushHookInput = {
        ...pipelineCtx,
        blockingPids,
      };
      const { results: flushResults, errors: flushCollectErrors } =
        await ctx.hooks.collect<FlushHookResult>("flush", flushCtx);
      const flush = mergeFlush(flushResults, flushCollectErrors);

      // Emit progress showing kill completed
      this.emitPipelineProgress(payload, resolvedWorkspacePath, {
        shutdown,
        release,
        del: currentDel,
        detect,
        flush,
      });

      // Re-attempt delete
      this.emitPipelineProgress(
        payload,
        resolvedWorkspacePath,
        { shutdown, release, del: currentDel, detect, flush },
        false,
        false,
        "cleanup-workspace"
      );
      const { results: retryDeleteResults, errors: retryDeleteCollectErrors } =
        await ctx.hooks.collect<DeleteHookResult>("delete", pipelineCtx);
      const retryDel = mergeDelete(retryDeleteResults, retryDeleteCollectErrors);

      if (retryDel.errors.length === 0) {
        // Success
        this.emitPipelineProgress(
          payload,
          resolvedWorkspacePath,
          { shutdown, release, del: retryDel },
          true,
          false
        );
        return { hasErrors: false, resolvedProjectPath, resolvedWorkspacePath };
      }

      // Still failing — loop back to detect
      currentDel = retryDel;
    }
  }

  /**
   * Build DeletionOperation[] from pipeline state and emit progress.
   */
  private emitPipelineProgress(
    payload: DeleteWorkspacePayload,
    resolvedWorkspacePath: string,
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

    this.emitProgress({
      workspacePath: resolvedWorkspacePath as WorkspacePath,
      workspaceName: payload.workspaceName,
      projectId: payload.projectId,
      keepBranch: payload.keepBranch,
      operations,
      completed,
      hasErrors,
      ...(blockingProcesses !== undefined && { blockingProcesses }),
    });
  }

  private hookPointStatus(
    merged: { readonly errors: readonly string[] } | undefined
  ): "pending" | "done" | "error" {
    if (!merged) return "pending";
    return merged.errors.length > 0 ? "error" : "done";
  }
}
