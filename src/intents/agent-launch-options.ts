/**
 * AgentLaunchOptionsOperation - Query the per-backend launch options shown in
 * the creation form (Claude permission modes; OpenCode currently none).
 *
 * Trivial query operation: no workspace, no domain events. The agent modules
 * fill in the options via the "launch-options" hook point — only the module
 * whose provider type matches the requested backend contributes. Detection is
 * best-effort: a provider that fails to report contributes nothing, so the form
 * falls back to offering only the default.
 */

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { LifecycleAgentType } from "../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetLaunchOptionsPayload {
  /** Backend the form currently targets. */
  readonly backend: LifecycleAgentType;
}

/**
 * Launch options for a backend.
 * - permissionModes: selectable Claude permission modes (empty for OpenCode,
 *   or when detection fails — the form then offers only the default).
 */
export interface LaunchOptionsResult {
  readonly permissionModes: readonly string[];
}

export interface GetLaunchOptionsIntent extends Intent<LaunchOptionsResult> {
  readonly type: "agent:get-launch-options";
  readonly payload: GetLaunchOptionsPayload;
}

export const INTENT_GET_LAUNCH_OPTIONS = "agent:get-launch-options" as const;

export const GET_LAUNCH_OPTIONS_OPERATION_ID = "get-launch-options";

// =============================================================================
// Hook Result & Input Types
// =============================================================================

/** Input context for the "launch-options" hook point. */
export interface LaunchOptionsHookInput extends HookContext {
  readonly backend: LifecycleAgentType;
}

/**
 * Per-handler result for the "launch-options" hook point. Each agent module
 * contributes only when the requested backend matches its provider type.
 */
export interface LaunchOptionsHookResult {
  readonly permissionModes?: readonly string[];
}

// =============================================================================
// Operation
// =============================================================================

export class AgentLaunchOptionsOperation implements Operation<
  GetLaunchOptionsIntent,
  LaunchOptionsResult
> {
  readonly id = GET_LAUNCH_OPTIONS_OPERATION_ID;

  async execute(ctx: OperationContext<GetLaunchOptionsIntent>): Promise<LaunchOptionsResult> {
    const hookCtx: LaunchOptionsHookInput = {
      intent: ctx.intent,
      backend: ctx.intent.payload.backend,
    };
    const { results } = await ctx.hooks.collect<LaunchOptionsHookResult>("launch-options", hookCtx);

    const permissionModes: string[] = [];
    for (const result of results) {
      if (result.permissionModes) permissionModes.push(...result.permissionModes);
    }
    return { permissionModes };
  }
}
