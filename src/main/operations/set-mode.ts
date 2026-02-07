/**
 * SetModeOperation - Orchestrates UI mode changes.
 *
 * Runs the "set" hook point where the handler captures the previous mode,
 * then applies the new mode via ViewManager. On success, emits a
 * ui:mode-changed domain event.
 *
 * No provider dependencies - the hook handler does the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { UIMode } from "../../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

export interface SetModePayload {
  readonly mode: UIMode;
}

export interface SetModeIntent extends Intent<void> {
  readonly type: "ui:set-mode";
  readonly payload: SetModePayload;
}

export const INTENT_SET_MODE = "ui:set-mode" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ModeChangedPayload {
  readonly mode: UIMode;
  readonly previousMode: UIMode;
}

export interface ModeChangedEvent extends DomainEvent {
  readonly type: "ui:mode-changed";
  readonly payload: ModeChangedPayload;
}

export const EVENT_MODE_CHANGED = "ui:mode-changed" as const;

// =============================================================================
// Operation
// =============================================================================

export const SET_MODE_OPERATION_ID = "set-mode";

/**
 * Extended hook context for set-mode.
 * The "set" hook handler captures previousMode before applying the new mode.
 * `undefined` means the hook didn't run (error).
 */
export interface SetModeHookContext extends HookContext {
  previousMode?: UIMode;
}

export class SetModeOperation implements Operation<SetModeIntent, void> {
  readonly id = SET_MODE_OPERATION_ID;

  async execute(ctx: OperationContext<SetModeIntent>): Promise<void> {
    const hookCtx: SetModeHookContext = {
      intent: ctx.intent,
    };

    // Run "set" hook -- handler captures previousMode and applies new mode
    await ctx.hooks.run("set", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    if (hookCtx.previousMode === undefined) {
      throw new Error("Set mode hook did not provide previousMode result");
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: ModeChangedEvent = {
      type: EVENT_MODE_CHANGED,
      payload: {
        mode: ctx.intent.payload.mode,
        previousMode: hookCtx.previousMode,
      },
    };
    ctx.emit(event);
  }
}
