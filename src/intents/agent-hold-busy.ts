/**
 * AgentHoldBusyOperation - Asks the workspace's agent provider to hold it busy.
 *
 * `ch ws status set busy` sends it before the raw status nudge: an agent ending
 * its turn to wait on its `[bg]` sub-agents would otherwise go idle with that
 * turn's end, since its own nudge is overwritten by the provider's next status.
 * The provider keeps the workspace busy across the turn's end while `[bg]` work
 * still runs, until the next prompt. No domain event is emitted here — the
 * provider's own status change propagates via agent:update-status. The "hold"
 * hook is resolved per-workspace agent by the workspace-agent resolver, then
 * handled by the matching agent module.
 *
 * Contract schemas: zod is the single source of truth. The payload/hook input
 * schemas are declared once and hung on the operation's `schemas` field; the
 * `Intent` type is derived from that bundle via `IntentOf`. The result is void.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, workspaceRefSchema, workspaceTargetShape } from "./contract";
import { resolveWorkspaceIdentity } from "./lib/workspace-identity";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_AGENT_HOLD_BUSY = "agent:hold-busy" as const;

export const AGENT_HOLD_BUSY_OPERATION_ID = "agent-hold-busy";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const agentHoldBusyPayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
  })
  .readonly();

/** Operation-added enrichment for the "hold" hook point (beyond the base HookContext). */
const holdEnrichmentSchema = z.object({
  ...workspaceTargetShape,
});

/** Runtime whole-context validation schema for "hold". */
export const holdHookInputSchema = hookCtxSchema(
  agentHoldBusyPayloadSchema,
  holdEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points via `ResolvedHooks<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_AGENT_HOLD_BUSY,
  payload: agentHoldBusyPayloadSchema,
  hooks: {
    hold: { input: holdHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AgentHoldBusyPayload = z.infer<typeof agentHoldBusyPayloadSchema>;
export type AgentHoldBusyIntent = IntentOf<typeof schemas>;

/** Input context for the "hold" hook point: base envelope + inferred enrichment. */
export type AgentHoldBusyHookInput = HookContext & z.infer<typeof holdEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class AgentHoldBusyOperation implements Operation<typeof schemas> {
  readonly id = AGENT_HOLD_BUSY_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<AgentHoldBusyIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;

    const holdCtx: AgentHoldBusyHookInput = {
      intent: ctx.intent,
      workspaceRef: payload.workspaceRef,
      workspacePath: (
        await resolveWorkspaceIdentity(ctx.dispatch, payload.workspaceRef, { withProject: false })
      ).workspacePath,
    };
    const { errors } = await ctx.hooks.collect("hold", holdCtx);
    throwHookErrors(errors, "agent-hold-busy hold hooks failed");
  }
}
