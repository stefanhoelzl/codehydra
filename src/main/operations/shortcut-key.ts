/**
 * ShortcutKeyOperation - Trivial operation that emits shortcut:key-pressed.
 *
 * No hooks needed — just emits a domain event for subscribers
 * (IPC bridge, DevTools module, etc.) to react to.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface ShortcutKeyPayload {
  readonly key: string;
}

export interface ShortcutKeyIntent extends Intent<void> {
  readonly type: "shortcut:key";
  readonly payload: ShortcutKeyPayload;
}

export const INTENT_SHORTCUT_KEY = "shortcut:key" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ShortcutKeyPressedPayload {
  readonly key: string;
}

export interface ShortcutKeyPressedEvent extends DomainEvent {
  readonly type: "shortcut:key-pressed";
  readonly payload: ShortcutKeyPressedPayload;
}

export const EVENT_SHORTCUT_KEY_PRESSED = "shortcut:key-pressed" as const;

// =============================================================================
// Operation
// =============================================================================

export const SHORTCUT_KEY_OPERATION_ID = "shortcut-key";

export class ShortcutKeyOperation implements Operation<ShortcutKeyIntent, void> {
  readonly id = SHORTCUT_KEY_OPERATION_ID;

  async execute(ctx: OperationContext<ShortcutKeyIntent>): Promise<void> {
    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: ctx.intent.payload.key },
    };
    ctx.emit(event);
  }
}
