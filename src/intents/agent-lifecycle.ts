/**
 * AgentLifecycleOperation - Applies an agent terminal lifecycle transition.
 *
 * The sidekick reports when the agent terminal opens or closes (over the API server
 * socket). This operation routes that signal into the owning agent provider,
 * which drives the status state machine:
 *  - "open"  → WrapperStart (Claude) / markActive (OpenCode)
 *  - "close" → WrapperEnd (Claude) / TUI detach (OpenCode)
 *  - "pid"   → the terminal's shell pid, once known; the agent module stops the
 *              agent a previous terminal of the workspace left running. Not a
 *              status transition: providers never see it.
 *
 * Replaces the wrapper-synthesized WrapperStart/WrapperEnd HTTP POSTs. No domain
 * event is emitted here — the provider's own status change propagates via
 * agent:update-status. The "lifecycle" hook is resolved per-workspace agent by
 * the workspace-agent resolver, then handled by the matching agent module.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/hook input
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` type is
 * **derived** from that bundle via `IntentOf` — never restated. The result is void.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, workspaceRefSchema, workspaceTargetShape } from "./contract";
import { resolveWorkspaceIdentity } from "./lib/workspace-identity";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_AGENT_LIFECYCLE = "agent:lifecycle" as const;

export const AGENT_LIFECYCLE_OPERATION_ID = "agent-lifecycle";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/**
 * Local schema for `AgentLifecycleRequest.event` (`AgentLifecycleEvent | "pid"`, from
 * shared/api-protocol). That shared type is not part of the intent `contract` vocabulary,
 * so it is defined here.
 */
const agentLifecycleEventSchema = z.enum(["open", "close", "pid"]);

/** Pid of the agent terminal's shell (`AgentLifecycleRequest.pid`), when known. */
const agentTerminalPidSchema = z.number().int().positive().optional();

export const agentLifecyclePayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    event: agentLifecycleEventSchema,
    pid: agentTerminalPidSchema,
  })
  .readonly();

/** Operation-added enrichment for the "lifecycle" hook point (beyond the base HookContext). */
const lifecycleEnrichmentSchema = z.object({
  ...workspaceTargetShape,
  event: agentLifecycleEventSchema,
  pid: agentTerminalPidSchema,
});

/** Runtime whole-context validation schema for "lifecycle". */
export const lifecycleHookInputSchema = hookCtxSchema(
  agentLifecyclePayloadSchema,
  lifecycleEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_AGENT_LIFECYCLE,
  payload: agentLifecyclePayloadSchema,
  hooks: {
    lifecycle: { input: lifecycleHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AgentLifecyclePayload = z.infer<typeof agentLifecyclePayloadSchema>;
export type AgentLifecycleIntent = IntentOf<typeof schemas>;

/** Input context for the "lifecycle" hook point: base envelope + inferred enrichment. */
export type AgentLifecycleHookInput = HookContext & z.infer<typeof lifecycleEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class AgentLifecycleOperation implements Operation<typeof schemas> {
  readonly id = AGENT_LIFECYCLE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<AgentLifecycleIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;

    const lifecycleCtx: AgentLifecycleHookInput = {
      intent: ctx.intent,
      workspaceRef: payload.workspaceRef,
      workspacePath: (
        await resolveWorkspaceIdentity(ctx.dispatch, payload.workspaceRef, { withProject: false })
      ).workspacePath,
      event: payload.event,
      ...(payload.pid !== undefined && { pid: payload.pid }),
    };
    const { errors } = await ctx.hooks.collect("lifecycle", lifecycleCtx);
    throwHookErrors(errors, "agent-lifecycle lifecycle hooks failed");
  }
}
