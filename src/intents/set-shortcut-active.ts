/**
 * SetShortcutActiveOperation - Trivial operation that broadcasts shortcut-mode
 * activation/deactivation.
 *
 * The shortcut-module owns the Alt+X state machine and dispatches this intent
 * whenever shortcut mode enters or exits. The operation emits a
 * ui:shortcut-active-changed domain event the presenter subscribes to so it
 * can fold `shortcutActive` into its UI-mode computation (shortcut beats
 * dialog/hover/workspace).
 *
 * No hooks — just emits the event. (Replaces the deleted ui:set-mode intent.)
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/event schemas are
 * declared once and hung on the operation's `schemas` field; the `Intent` and event-payload
 * types are **derived** from that bundle via `IntentOf`/`z.infer`. The result is void.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";

export const INTENT_SET_SHORTCUT_ACTIVE = "ui:set-shortcut-active" as const;

export const EVENT_SHORTCUT_ACTIVE_CHANGED = "ui:shortcut-active-changed" as const;

export const SET_SHORTCUT_ACTIVE_OPERATION_ID = "set-shortcut-active";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const setShortcutActivePayloadSchema = z
  .object({
    active: z.boolean(),
  })
  .readonly();

export const shortcutActiveChangedPayloadSchema = z
  .object({
    active: z.boolean(),
  })
  .readonly();

const schemas = {
  type: INTENT_SET_SHORTCUT_ACTIVE,
  payload: setShortcutActivePayloadSchema,
  events: {
    [EVENT_SHORTCUT_ACTIVE_CHANGED]: shortcutActiveChangedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SetShortcutActivePayload = z.infer<typeof setShortcutActivePayloadSchema>;
export type SetShortcutActiveIntent = IntentOf<typeof schemas>;
export type ShortcutActiveChangedPayload = z.infer<typeof shortcutActiveChangedPayloadSchema>;

export interface ShortcutActiveChangedEvent extends DomainEvent {
  readonly type: "ui:shortcut-active-changed";
  readonly payload: ShortcutActiveChangedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class SetShortcutActiveOperation implements Operation<typeof schemas> {
  readonly id = SET_SHORTCUT_ACTIVE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<SetShortcutActiveIntent>): Promise<void> {
    const event: ShortcutActiveChangedEvent = {
      type: EVENT_SHORTCUT_ACTIVE_CHANGED,
      payload: { active: ctx.intent.payload.active },
    };
    ctx.emit(event);
  }
}
