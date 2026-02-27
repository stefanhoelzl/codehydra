/**
 * ConfigSetValuesOperation - Persists config values and emits change events.
 *
 * Runs one hook point:
 * 1. "set" — config module merges values into the file layer, persists if dirty,
 *    re-merges with env layer, returns effective config
 *
 * After the hook, emits a `config:updated` domain event with only the changed values.
 *
 * No provider dependencies — the config module's hook handler does the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent + Event Types
// =============================================================================

export interface ConfigSetValuesPayload {
  /** Values to set. null value = delete key (revert to default). */
  readonly values: Readonly<Record<string, unknown>>;
  /** When false, values are stored as runtime overrides (not written to disk). Default: true. */
  readonly persist?: boolean;
}

export interface ConfigSetValuesIntent extends Intent<void> {
  readonly type: "config:set-values";
  readonly payload: ConfigSetValuesPayload;
}

export interface ConfigUpdatedPayload {
  /** Only the values that actually changed. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ConfigUpdatedEvent extends DomainEvent {
  readonly type: "config:updated";
  readonly payload: ConfigUpdatedPayload;
}

export const INTENT_CONFIG_SET_VALUES = "config:set-values" as const;
export const EVENT_CONFIG_UPDATED = "config:updated" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const CONFIG_SET_VALUES_OPERATION_ID = "config-set-values";

/**
 * Input context for the "set" hook — carries the values to be set.
 */
export interface ConfigSetHookInput extends HookContext {
  readonly values: Readonly<Record<string, unknown>>;
  readonly persist: boolean;
}

/**
 * Result from the "set" hook — returns the changed values for the event.
 */
export interface ConfigSetHookResult {
  readonly changedValues: Readonly<Record<string, unknown>>;
}

// =============================================================================
// Operation
// =============================================================================

export class ConfigSetValuesOperation implements Operation<ConfigSetValuesIntent, void> {
  readonly id = CONFIG_SET_VALUES_OPERATION_ID;

  async execute(ctx: OperationContext<ConfigSetValuesIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // "set" hook — config module merges into file layer, persists if dirty
    const setCtx: ConfigSetHookInput = {
      intent: ctx.intent,
      values: payload.values,
      persist: payload.persist !== false,
    };
    const { results, errors } = await ctx.hooks.collect<ConfigSetHookResult>("set", setCtx);
    if (errors.length > 0) throw errors[0]!;

    // Merge changed values from all handlers (only config module responds)
    let changedValues: Readonly<Record<string, unknown>> = {};
    for (const result of results) {
      changedValues = { ...changedValues, ...result.changedValues };
    }

    // Only emit if there are actual changes
    if (Object.keys(changedValues).length > 0) {
      const event: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: changedValues },
      };
      ctx.emit(event);
    }
  }
}
