/**
 * CloseNotificationOperation - Release a CodeHydra sidebar notification.
 *
 * Two forms:
 * - `{ id }` releases one hold on the card. Opens that collapsed into one card
 *   each hold it, so the card disappears on the last close. Idempotent: an id
 *   that is not open is a no-op, so a producer never has to track whether the
 *   user already dismissed its card.
 * - `{ waiter }` releases the wait a `notification:show { wait, waiter }` is
 *   blocked on: that call returns `{ choice: null }` and gives up its hold.
 *   How the registry ties a wait to its caller's connection.
 *
 * The presenter does the work in the "close" hook.
 */

import { z } from "zod/v4";
import type { HookContext, Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { throwHookErrors } from "./lib/hook-helpers";
import { hookCtxSchema } from "./contract";

export const INTENT_CLOSE_NOTIFICATION = "notification:close" as const;
export const CLOSE_NOTIFICATION_OPERATION_ID = "close-notification";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const closeNotificationPayloadSchema = z.union([
  z.object({ id: z.string().min(1) }).readonly(),
  z.object({ waiter: z.string().min(1) }).readonly(),
]);

/** Runtime whole-context validation schema for "close" (no enrichment). */
export const closeNotificationHookInputSchema = hookCtxSchema(closeNotificationPayloadSchema, {});

export const schemas = {
  type: INTENT_CLOSE_NOTIFICATION,
  payload: closeNotificationPayloadSchema,
  hooks: {
    close: { input: closeNotificationHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type CloseNotificationPayload = z.infer<typeof closeNotificationPayloadSchema>;
export type CloseNotificationIntent = IntentOf<typeof schemas>;

/** Whole input context for "close" handlers. */
export type CloseNotificationHookInput = HookContext & { readonly intent: CloseNotificationIntent };

// =============================================================================
// Operation
// =============================================================================

export class CloseNotificationOperation implements Operation<typeof schemas> {
  readonly id = CLOSE_NOTIFICATION_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<CloseNotificationIntent, typeof schemas>): Promise<void> {
    const { errors } = await ctx.hooks.collect("close", { intent: ctx.intent });
    throwHookErrors(errors, "notification:close hooks failed");
  }
}
