/**
 * AgentLifecycleOperation - Applies an agent terminal lifecycle transition.
 *
 * The sidekick reports when the agent terminal opens or closes (over the plugin
 * socket). This operation routes that signal into the owning agent provider,
 * which drives the status state machine:
 *  - "open"  → WrapperStart (Claude) / markActive (OpenCode)
 *  - "close" → WrapperEnd (Claude) / TUI detach (OpenCode)
 *
 * Replaces the wrapper-synthesized WrapperStart/WrapperEnd HTTP POSTs. No domain
 * event is emitted here — the provider's own status change propagates via
 * agent:update-status. The "lifecycle" hook is resolved per-workspace agent by
 * the workspace-agent resolver, then handled by the matching agent module.
 */

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { AgentLifecycleEvent } from "../shared/plugin-protocol";

// =============================================================================
// Intent Types
// =============================================================================

export interface AgentLifecyclePayload {
  readonly workspacePath: string;
  readonly event: AgentLifecycleEvent;
}

export interface AgentLifecycleIntent extends Intent<void> {
  readonly type: "agent:lifecycle";
  readonly payload: AgentLifecyclePayload;
}

export const INTENT_AGENT_LIFECYCLE = "agent:lifecycle" as const;

// =============================================================================
// Hook Input Types
// =============================================================================

export const AGENT_LIFECYCLE_OPERATION_ID = "agent-lifecycle";

/** Input context for the "lifecycle" hook point. */
export interface AgentLifecycleHookInput extends HookContext {
  readonly workspacePath: string;
  readonly event: AgentLifecycleEvent;
}

// =============================================================================
// Operation
// =============================================================================

export class AgentLifecycleOperation implements Operation<AgentLifecycleIntent, void> {
  readonly id = AGENT_LIFECYCLE_OPERATION_ID;

  async execute(ctx: OperationContext<AgentLifecycleIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const lifecycleCtx: AgentLifecycleHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
      event: payload.event,
    };
    const { errors } = await ctx.hooks.collect<void>("lifecycle", lifecycleCtx);
    if (errors.length === 1) {
      throw errors[0]!;
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "agent-lifecycle lifecycle hooks failed");
    }
  }
}
