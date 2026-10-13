/**
 * VscodeCancelMessageOperation - End a question a `vscode:show-message` waits on.
 *
 * `{ waiter }` names the wait (minted by the registry entry per call): that call
 * returns null, and the question closes where VS Code lets it — a quick pick or
 * an input box. A modal and a file dialog cannot be closed from code; they stay
 * until the user dismisses them, and that late answer goes nowhere. How the
 * registry ties a question to its caller's connection. A waiter that is not
 * waiting (yet, or any more) is a no-op.
 *
 * The API server module does the work in the "cancel" hook.
 */

import { z } from "zod/v4";
import type { HookContext, Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { throwHookErrors } from "./lib/hook-helpers";
import { hookCtxSchema } from "./contract";

export const INTENT_VSCODE_CANCEL_MESSAGE = "vscode:cancel-message" as const;
export const VSCODE_CANCEL_MESSAGE_OPERATION_ID = "vscode-cancel-message";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const vscodeCancelMessagePayloadSchema = z.object({ waiter: z.string().min(1) }).readonly();

/** Runtime whole-context validation schema for "cancel" (no enrichment). */
export const vscodeCancelMessageHookInputSchema = hookCtxSchema(
  vscodeCancelMessagePayloadSchema,
  {}
);

export const schemas = {
  type: INTENT_VSCODE_CANCEL_MESSAGE,
  payload: vscodeCancelMessagePayloadSchema,
  hooks: {
    cancel: { input: vscodeCancelMessageHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type VscodeCancelMessageIntent = IntentOf<typeof schemas>;

/** Whole input context for "cancel" handlers. */
export type VscodeCancelMessageHookInput = HookContext & {
  readonly intent: VscodeCancelMessageIntent;
};

// =============================================================================
// Operation
// =============================================================================

export class VscodeCancelMessageOperation implements Operation<typeof schemas> {
  readonly id = VSCODE_CANCEL_MESSAGE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<VscodeCancelMessageIntent, typeof schemas>): Promise<void> {
    const { errors } = await ctx.hooks.collect("cancel", { intent: ctx.intent });
    throwHookErrors(errors, "vscode:cancel-message hooks failed");
  }
}
