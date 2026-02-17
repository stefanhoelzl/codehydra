/**
 * UpdateAvailableOperation - Trivial operation that emits an update:available domain event.
 *
 * No hooks -- this operation simply relays update-available notifications from AutoUpdater
 * through the intent dispatcher so downstream event subscribers (WindowTitleModule)
 * can react to update availability.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface UpdateAvailablePayload {
  readonly version: string;
}

export interface UpdateAvailableIntent extends Intent<void> {
  readonly type: "update:available";
  readonly payload: UpdateAvailablePayload;
}

export const INTENT_UPDATE_AVAILABLE = "update:available" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface UpdateAvailableEventPayload {
  readonly version: string;
}

export interface UpdateAvailableEvent extends DomainEvent {
  readonly type: "update:available";
  readonly payload: UpdateAvailableEventPayload;
}

export const EVENT_UPDATE_AVAILABLE = "update:available" as const;

// =============================================================================
// Operation
// =============================================================================

export const UPDATE_AVAILABLE_OPERATION_ID = "update-available";

export class UpdateAvailableOperation implements Operation<UpdateAvailableIntent, void> {
  readonly id = UPDATE_AVAILABLE_OPERATION_ID;

  async execute(ctx: OperationContext<UpdateAvailableIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const event: UpdateAvailableEvent = {
      type: EVENT_UPDATE_AVAILABLE,
      payload: {
        version: payload.version,
      },
    };
    ctx.emit(event);
  }
}
