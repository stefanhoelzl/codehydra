/**
 * SetMetadataOperation - Orchestrates workspace metadata writes.
 *
 * Runs three hook points in sequence:
 * 1. "resolve" - Validates workspacePath is tracked, returns projectPath + workspaceName
 * 2. "resolve-project" - Resolves projectPath to projectId (for domain events)
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
  readonly workspacePath: string;
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

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for "resolve" hook point. */
export interface ResolveHookResult {
  readonly projectPath?: string;
  readonly workspaceName?: WorkspaceName;
}

/** Input context for "resolve-project" handlers. */
export interface ResolveProjectHookInput extends HookContext {
  readonly projectPath: string;
}

/** Per-handler result for "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectId?: ProjectId;
}

/**
 * Input context for "set" handlers — built from resolve results.
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

    // 1. resolve — validate workspacePath is tracked, get projectPath + workspaceName
    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    if (resolveErrors.length > 0) {
      throw new AggregateError(resolveErrors, "set-metadata resolve failed");
    }

    let projectPath: string | undefined;
    let workspaceName: WorkspaceName | undefined;
    for (const result of resolveResults) {
      if (result.projectPath !== undefined) projectPath = result.projectPath;
      if (result.workspaceName !== undefined) workspaceName = result.workspaceName;
    }
    if (!projectPath || !workspaceName) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    // 2. resolve-project — get projectId from projectPath (for domain events)
    const resolveProjectCtx: ResolveProjectHookInput = {
      intent: ctx.intent,
      projectPath,
    };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length > 0) {
      throw new AggregateError(resolveProjectErrors, "set-metadata resolve-project failed");
    }

    let projectId: ProjectId | undefined;
    for (const result of resolveProjectResults) {
      if (result.projectId !== undefined) projectId = result.projectId;
    }
    if (!projectId) {
      throw new Error(`Project not found for path: ${projectPath}`);
    }

    // 3. set — handler performs the actual provider write
    const setCtx: SetHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { errors } = await ctx.hooks.collect<void>("set", setCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: MetadataChangedEvent = {
      type: EVENT_METADATA_CHANGED,
      payload: {
        projectId,
        workspaceName,
        key: payload.key,
        value: payload.value,
      },
    };
    ctx.emit(event);
  }
}
