/**
 * SetMetadataOperation - Orchestrates workspace metadata writes.
 *
 * Runs three hook points in sequence:
 * 1. "resolve-project" - Resolves projectId to projectPath
 * 2. "resolve-workspace" - Resolves workspaceName to workspacePath
 * 3. "set" - Each handler performs the actual provider write
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent + Event Types
// =============================================================================

export interface SetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly key: string;
  readonly value: string | null;
}

export interface SetMetadataIntent extends Intent<void> {
  readonly type: "workspace:set-metadata";
  readonly payload: SetMetadataPayload;
}

export interface MetadataChangedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly key: string;
  readonly value: string | null;
}

export interface MetadataChangedEvent extends DomainEvent {
  readonly type: "workspace:metadata-changed";
  readonly payload: MetadataChangedPayload;
}

export const INTENT_SET_METADATA = "workspace:set-metadata" as const;
export const EVENT_METADATA_CHANGED = "workspace:metadata-changed" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const SET_METADATA_OPERATION_ID = "set-metadata";

/**
 * Per-handler result contract for the "resolve-project" hook point.
 * Each handler returns projectPath if it owns the project, or `{}` to skip.
 */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
}

/**
 * Per-handler result contract for the "resolve-workspace" hook point.
 * Each handler returns workspacePath if it can resolve, or `{}` to skip.
 */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

/**
 * Input context for "resolve-workspace" handlers — built from resolve-project results.
 */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

/**
 * Input context for "set" handlers — built from resolve-workspace results.
 */
export interface SetHookInput extends HookContext {
  readonly workspacePath: string;
}

// =============================================================================
// Operation
// =============================================================================

export class SetMetadataOperation implements Operation<SetMetadataIntent, void> {
  readonly id = SET_METADATA_OPERATION_ID;

  async execute(ctx: OperationContext<SetMetadataIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // 1. resolve-project — resolve projectId to projectPath
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", {
        intent: ctx.intent,
      });
    if (resolveProjectErrors.length > 0) {
      throw new AggregateError(resolveProjectErrors, "set-metadata resolve-project failed");
    }

    let projectPath: string | undefined;
    for (const result of resolveProjectResults) {
      if (result.projectPath !== undefined) projectPath = result.projectPath;
    }
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // 2. resolve-workspace — resolve workspaceName to workspacePath
    const resolveWorkspaceCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath,
      workspaceName: payload.workspaceName,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWorkspaceCtx);
    if (resolveWorkspaceErrors.length > 0) {
      throw new AggregateError(resolveWorkspaceErrors, "set-metadata resolve-workspace failed");
    }

    let workspacePath: string | undefined;
    for (const result of resolveWorkspaceResults) {
      if (result.workspacePath !== undefined) workspacePath = result.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. set — handler performs the actual provider write
    const setCtx: SetHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { errors } = await ctx.hooks.collect<void>("set", setCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: MetadataChangedEvent = {
      type: EVENT_METADATA_CHANGED,
      payload: {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        key: payload.key,
        value: payload.value,
      },
    };
    ctx.emit(event);
  }
}
