/**
 * AppResumeOperation - Emits app:resumed after system wake from sleep/hibernate.
 *
 * Trivial operation (no hooks) that emits a domain event for subscribers.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppResumeIntent extends Intent<void> {
  readonly type: "app:resume";
  readonly payload: Record<string, never>;
}

export const INTENT_APP_RESUME = "app:resume" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface AppResumedEvent extends DomainEvent {
  readonly type: typeof EVENT_APP_RESUMED;
  readonly payload: Record<string, never>;
}

export const EVENT_APP_RESUMED = "app:resumed" as const;

// =============================================================================
// Operation
// =============================================================================

export class AppResumeOperation implements Operation<AppResumeIntent, void> {
  readonly id = "app-resume";

  async execute(ctx: OperationContext<AppResumeIntent>): Promise<void> {
    ctx.emit({ type: EVENT_APP_RESUMED, payload: {} });
  }
}
