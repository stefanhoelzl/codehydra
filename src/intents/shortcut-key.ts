/**
 * ShortcutKeyOperation - Trivial operation that emits shortcut:key-pressed.
 *
 * No hooks needed — just emits a domain event for subscribers
 * (IPC bridge, DevTools module, etc.) to react to.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/event schemas are
 * declared once and hung on the operation's `schemas` field; the `Intent` and event-payload
 * types are **derived** from that bundle via `IntentOf`/`z.infer`. The result is void.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";

export const INTENT_SHORTCUT_KEY = "shortcut:key" as const;

export const EVENT_SHORTCUT_KEY_PRESSED = "shortcut:key-pressed" as const;

const SHORTCUT_KEY_OPERATION_ID = "shortcut-key";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const shortcutKeyPayloadSchema = z
  .object({
    key: z.string(),
  })
  .readonly();

export const shortcutKeyPressedPayloadSchema = z
  .object({
    key: z.string(),
  })
  .readonly();

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_SHORTCUT_KEY,
  payload: shortcutKeyPayloadSchema,
  events: {
    [EVENT_SHORTCUT_KEY_PRESSED]: shortcutKeyPressedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ShortcutKeyPayload = z.infer<typeof shortcutKeyPayloadSchema>;
export type ShortcutKeyIntent = IntentOf<typeof schemas>;
export type ShortcutKeyPressedPayload = z.infer<typeof shortcutKeyPressedPayloadSchema>;

export interface ShortcutKeyPressedEvent extends DomainEvent {
  readonly type: "shortcut:key-pressed";
  readonly payload: ShortcutKeyPressedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class ShortcutKeyOperation implements Operation<typeof schemas> {
  readonly id = SHORTCUT_KEY_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<ShortcutKeyIntent, typeof schemas>): Promise<void> {
    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: ctx.intent.payload.key },
    };
    ctx.emit(event);
  }
}
