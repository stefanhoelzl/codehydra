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
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext } from "./lib/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface SetShortcutActivePayload {
  readonly active: boolean;
}

export interface SetShortcutActiveIntent extends Intent<void> {
  readonly type: "ui:set-shortcut-active";
  readonly payload: SetShortcutActivePayload;
}

export const INTENT_SET_SHORTCUT_ACTIVE = "ui:set-shortcut-active" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ShortcutActiveChangedPayload {
  readonly active: boolean;
}

export interface ShortcutActiveChangedEvent extends DomainEvent {
  readonly type: "ui:shortcut-active-changed";
  readonly payload: ShortcutActiveChangedPayload;
}

export const EVENT_SHORTCUT_ACTIVE_CHANGED = "ui:shortcut-active-changed" as const;

// =============================================================================
// Operation
// =============================================================================

export const SET_SHORTCUT_ACTIVE_OPERATION_ID = "set-shortcut-active";

export class SetShortcutActiveOperation implements Operation<SetShortcutActiveIntent, void> {
  readonly id = SET_SHORTCUT_ACTIVE_OPERATION_ID;

  async execute(ctx: OperationContext<SetShortcutActiveIntent>): Promise<void> {
    const event: ShortcutActiveChangedEvent = {
      type: EVENT_SHORTCUT_ACTIVE_CHANGED,
      payload: { active: ctx.intent.payload.active },
    };
    ctx.emit(event);
  }
}
