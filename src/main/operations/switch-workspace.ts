/**
 * SwitchWorkspaceOperation - Orchestrates workspace switching.
 *
 * Runs a single "activate" hook point where the handler resolves the workspace
 * and calls viewManager.setActiveWorkspace(). On success, emits a
 * workspace:switched domain event.
 *
 * The null deactivation case (no workspace to switch to) is NOT routed through
 * this intent. Operations emit workspace:switched(null) directly via ctx.emit().
 *
 * No provider dependencies - the hook handler does the actual work.
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
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}

export interface WorkspaceSwitchedEvent extends DomainEvent {
  readonly type: "workspace:switched";
  readonly payload: WorkspaceSwitchedPayload | null;
}

export const EVENT_WORKSPACE_SWITCHED = "workspace:switched" as const;

// =============================================================================
// Hook Result
// =============================================================================

export const SWITCH_WORKSPACE_OPERATION_ID = "switch-workspace";

/**
 * Per-handler result contract for the "activate" hook point.
 * Each handler returns its contribution — the operation merges them.
 * Empty `{}` for no-op case (workspace already active).
 */
export interface SwitchWorkspaceHookResult {
  readonly resolvedPath?: string;
  readonly projectPath?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class SwitchWorkspaceOperation implements Operation<SwitchWorkspaceIntent, void> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<SwitchWorkspaceIntent>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Run "activate" hook -- handler resolves workspace and calls setActiveWorkspace
    const { results, errors } = await ctx.hooks.collect<SwitchWorkspaceHookResult>(
      "activate",
      hookCtx
    );
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Merge results — last-write-wins for resolvedPath and projectPath
    let resolvedPath: string | undefined;
    for (const result of results) {
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
        projectId: ctx.intent.payload.projectId,
        workspaceName: ctx.intent.payload.workspaceName,
        path: resolvedPath,
      },
    };
    ctx.emit(event);
  }
}
