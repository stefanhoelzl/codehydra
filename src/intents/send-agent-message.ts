/**
 * SendAgentMessageOperation - Delivers a message into a workspace's running agent.
 *
 * A message is for the AGENT: it lands in the agent's conversation, the way one
 * Claude session messages another. It is not a notification — those are for the
 * user and the agent never sees them.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — validates workspacePath; yields its metadata
 *    and whether a teardown owns it
 * 2. With `wake`: bring the agent up first —
 *    - hibernated → dispatch workspace:wake (in the background, no switch)
 *    - awake, agent terminal closed (agent status "none") → run the sidekick's
 *      `codehydra.openAgent`
 *    and let the send wait for the agent to become reachable. Without `wake`, a
 *    hibernated workspace fails fast and the send never waits.
 * 3. "send" hook — the workspace's agent module hands the message over
 *
 * Resolves `{ sent: true }` once the agent has taken the message ("sent", not
 * "read"), and `{ sent: false, reason }` when there is no agent to take it —
 * hibernated, terminal closed, being deleted, or not up in time. That is the
 * target's state, not a fault, so it is a result rather than a failure (and
 * stays out of the error log); a failed hand-over still throws. No domain
 * events.
 */

import { z } from "zod/v4";
import type { HookContext, Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, workspacePathSchema } from "./contract";
import { throwHookErrors } from "./lib/hook-helpers";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "./wake-workspace";
import { INTENT_GET_WORKSPACE_STATUS, type GetWorkspaceStatusIntent } from "./get-workspace-status";
import { INTENT_VSCODE_COMMAND, type VscodeCommandIntent } from "./vscode-command";

export const INTENT_SEND_AGENT_MESSAGE = "agent:send-message" as const;
export const SEND_AGENT_MESSAGE_OPERATION_ID = "send-agent-message";

/**
 * How long a woken (or reopened) agent may take to become reachable: the view
 * has to load, the sidekick has to start the agent terminal, and the agent has
 * to start up and report in.
 */
export const AGENT_READY_TIMEOUT_MS = 90_000;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const sendAgentMessagePayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
    /** The message text. */
    text: z.string().min(1),
    /** Sender as the agent should see it — set by CodeHydra, never by the caller. */
    from: z.string().min(1),
    /** Wake a hibernated workspace / reopen a closed agent terminal first. */
    wake: z.boolean(),
  })
  .readonly();

export const sendAgentMessageResultSchema = z
  .object({
    sent: z.boolean(),
    /** Why not, when `sent` is false. */
    reason: z.string().optional(),
  })
  .readonly();

/** Per-handler result contract for the "send" hook point. */
export const sendHookResultSchema = z
  .object({
    /** Whether the handler's agent took the message. */
    sent: z.boolean().optional(),
    /** Why not, when `sent` is false. */
    reason: z.string().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "send" hook point (beyond the base HookContext). */
const sendEnrichmentSchema = z.object({
  workspacePath: workspacePathSchema,
  /** How long the agent may take to become reachable (0 = must be reachable now). */
  waitMs: z.number().int().nonnegative(),
});

/** Runtime whole-context validation schema for "send". */
export const sendHookInputSchema = hookCtxSchema(
  sendAgentMessagePayloadSchema,
  sendEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points via `ResolvedHooks<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_SEND_AGENT_MESSAGE,
  payload: sendAgentMessagePayloadSchema,
  result: sendAgentMessageResultSchema,
  hooks: {
    send: { input: sendHookInputSchema, result: sendHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SendAgentMessagePayload = z.infer<typeof sendAgentMessagePayloadSchema>;
export type SendAgentMessageIntent = IntentOf<typeof schemas>;
export type SendAgentMessageResult = z.infer<typeof sendAgentMessageResultSchema>;
export type SendHookResult = z.infer<typeof sendHookResultSchema>;

/** Whole input context for "send" handlers: base envelope + inferred enrichment. */
export type SendHookInput = HookContext & z.infer<typeof sendEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class SendAgentMessageOperation implements Operation<typeof schemas> {
  readonly id = SEND_AGENT_MESSAGE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<SendAgentMessageIntent, typeof schemas>
  ): Promise<SendAgentMessageResult> {
    const { payload } = ctx.intent;
    const { workspacePath } = payload;

    const resolved = await ctx.dispatch<ResolveWorkspaceIntent>({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath },
    });
    if (resolved.closing !== null) {
      return {
        sent: false,
        reason: "The workspace is being closed; its agent cannot take messages.",
      };
    }

    const hibernated = resolved.metadata[HIBERNATED_METADATA_KEY] === "true";
    let waitMs = 0;
    if (hibernated) {
      if (!payload.wake) {
        return {
          sent: false,
          reason: "The workspace is hibernated, so it has no running agent. Wake it first.",
        };
      }
      await ctx.dispatch<WakeWorkspaceIntent>({
        type: INTENT_WAKE_WORKSPACE,
        payload: { workspacePath, stealFocus: false, source: "mcp" },
      });
      waitMs = AGENT_READY_TIMEOUT_MS;
    } else if (payload.wake) {
      const status = await ctx.dispatch<GetWorkspaceStatusIntent>({
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: { workspacePath },
      });
      if (status.agent.type === "none") {
        // The agent terminal is closed (or the agent is still starting, in
        // which case this only focuses the terminal it is starting in).
        await ctx.dispatch<VscodeCommandIntent>({
          type: INTENT_VSCODE_COMMAND,
          payload: { workspacePath, command: "codehydra.openAgent", args: undefined },
        });
        waitMs = AGENT_READY_TIMEOUT_MS;
      }
    }

    const hookCtx: SendHookInput = { intent: ctx.intent, workspacePath, waitMs };
    const { results, errors } = await ctx.hooks.collect("send", hookCtx);
    throwHookErrors(errors, "send-agent-message send hooks failed");

    if (results.some((result) => result.sent === true)) return { sent: true };
    const reason = results.find((result) => result.reason !== undefined)?.reason;
    return { sent: false, reason: reason ?? "The workspace has no agent to take the message." };
  }
}
