/**
 * SwitchWorkspaceOperation - Orchestrates workspace switching.
 *
 * Runs three sequential hook points using collect():
 * 1. "resolve-project": resolve projectId → projectPath + projectName
 * 2. "resolve-workspace": resolve workspaceName → workspacePath
 * 3. "activate": call viewManager.setActiveWorkspace()
 *
 * On success, emits a workspace:switched domain event.
 *
 * The null deactivation case (no workspace to switch to) is NOT routed through
 * this intent. Operations emit workspace:switched(null) directly via ctx.emit().
 *
 * No provider dependencies - the hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface SwitchWorkspacePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly focus?: boolean;
}

export interface SwitchWorkspaceIntent extends Intent<void> {
  readonly type: "workspace:switch";
  readonly payload: SwitchWorkspacePayload;
}

export const INTENT_SWITCH_WORKSPACE = "workspace:switch" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceSwitchedPayload {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly projectPath: string;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}

export interface WorkspaceSwitchedEvent extends DomainEvent {
  readonly type: "workspace:switched";
  readonly payload: WorkspaceSwitchedPayload | null;
}

export const EVENT_WORKSPACE_SWITCHED = "workspace:switched" as const;

// =============================================================================
// Hook Result & Input Types
// =============================================================================

export const SWITCH_WORKSPACE_OPERATION_ID = "switch-workspace";

/** Per-handler result for the "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
  readonly projectName?: string;
}

/** Input context for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

/** Per-handler result for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

/** Input context for the "activate" hook point. */
export interface ActivateHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "activate" hook point.
 * Each handler returns its contribution — the operation merges them.
 * Empty `{}` for no-op case (workspace already active).
 */
export interface SwitchWorkspaceHookResult {
  readonly resolvedPath?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class SwitchWorkspaceOperation implements Operation<SwitchWorkspaceIntent, void> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<SwitchWorkspaceIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // 1. Resolve project: projectId → projectPath + projectName
    const resolveProjectCtx: HookContext = { intent: ctx.intent };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length === 1) {
      throw resolveProjectErrors[0]!;
    }
    if (resolveProjectErrors.length > 1) {
      throw new AggregateError(
        resolveProjectErrors,
        "workspace:switch resolve-project hooks failed"
      );
    }
    let projectPath: string | undefined;
    let projectName: string | undefined;
    for (const r of resolveProjectResults) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
      if (r.projectName !== undefined) projectName = r.projectName;
    }
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // 2. Resolve workspace: workspaceName → workspacePath
    const resolveWorkspaceCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath,
      workspaceName: payload.workspaceName,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWorkspaceCtx);
    if (resolveWorkspaceErrors.length === 1) {
      throw resolveWorkspaceErrors[0]!;
    }
    if (resolveWorkspaceErrors.length > 1) {
      throw new AggregateError(
        resolveWorkspaceErrors,
        "workspace:switch resolve-workspace hooks failed"
      );
    }
    let workspacePath: string | undefined;
    for (const r of resolveWorkspaceResults) {
      if (r.workspacePath !== undefined) workspacePath = r.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. Activate: call setActiveWorkspace
    const activateCtx: ActivateHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { results: activateResults, errors: activateErrors } =
      await ctx.hooks.collect<SwitchWorkspaceHookResult>("activate", activateCtx);
    if (activateErrors.length === 1) {
      throw activateErrors[0]!;
    }
    if (activateErrors.length > 1) {
      throw new AggregateError(activateErrors, "workspace:switch activate hooks failed");
    }

    // Merge results — last-write-wins for resolvedPath
    let resolvedPath: string | undefined;
    for (const result of activateResults) {
      if (result.resolvedPath !== undefined) resolvedPath = result.resolvedPath;
    }

    // No-op: hook resolved workspace but it was already active
    // (resolvedPath left unset intentionally)
    if (!resolvedPath) {
      return;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge, SwitchTitleModule)
    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: {
        projectId: payload.projectId,
        projectName: projectName ?? "",
        projectPath,
        workspaceName: payload.workspaceName,
        path: resolvedPath,
      },
    };
    ctx.emit(event);
  }
}
