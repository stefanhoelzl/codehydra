/**
 * Idempotency module factory — produces a single IntentModule that blocks
 * duplicate dispatches for one or more intent types.
 *
 * Supports three modes per rule:
 * - **Singleton**: boolean flag, blocks once set (e.g. app:shutdown)
 * - **Singleton with reset**: boolean flag cleared by a domain event (e.g. setup)
 * - **Per-key**: Set<string> keyed by payload field, with optional reset and force bypass
 *   (e.g. workspace:delete keyed by workspacePath)
 */

import type { Intent, DomainEvent } from "./types";
import type { IntentModule, EventDeclarations } from "./module";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Describes one idempotency rule applied to a specific intent type.
 */
export interface IdempotencyRule {
  /** Intent type this rule applies to. */
  readonly intentType: string;
  /** Extract a tracking key from the intent payload. Omit for singleton (boolean flag). */
  readonly getKey?: (payload: unknown) => string;
  /** Domain event type that resets tracking state. Uses getKey on event payload for per-key reset. */
  readonly resetOn?: string;
  /** Return true to bypass the idempotency block (intent still gets tracked). */
  readonly isForced?: (intent: Intent) => boolean;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an IntentModule that enforces idempotency for the given rules.
 *
 * Returns a module with:
 * - One interceptor (id: "idempotency", order: 0) covering all rules
 * - Event handlers for each unique `resetOn` value
 */
export function createIdempotencyModule(rules: readonly IdempotencyRule[]): IntentModule {
  // Rule lookup by intent type
  const rulesByIntent = new Map<string, IdempotencyRule>();
  for (const rule of rules) {
    rulesByIntent.set(rule.intentType, rule);
  }

  // State: intent type → boolean (singleton) or Set<string> (per-key)
  const singletonFlags = new Map<string, boolean>();
  const perKeyFlags = new Map<string, Set<string>>();

  // Initialize state for each rule
  for (const rule of rules) {
    if (rule.getKey) {
      perKeyFlags.set(rule.intentType, new Set<string>());
    } else {
      singletonFlags.set(rule.intentType, false);
    }
  }

  // Build event handlers for resetOn rules
  // Multiple rules may reset on the same event type, so group them.
  const resetRulesByEvent = new Map<string, IdempotencyRule[]>();
  for (const rule of rules) {
    if (rule.resetOn) {
      const list = resetRulesByEvent.get(rule.resetOn);
      if (list) {
        list.push(rule);
      } else {
        resetRulesByEvent.set(rule.resetOn, [rule]);
      }
    }
  }

  const events: EventDeclarations = {};
  for (const [eventType, resetRules] of resetRulesByEvent) {
    (events as Record<string, (event: DomainEvent) => void>)[eventType] = (event: DomainEvent) => {
      for (const rule of resetRules) {
        if (rule.getKey) {
          const key = rule.getKey(event.payload);
          perKeyFlags.get(rule.intentType)?.delete(key);
        } else {
          singletonFlags.set(rule.intentType, false);
        }
      }
    };
  }

  return {
    interceptors: [
      {
        id: "idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          const rule = rulesByIntent.get(intent.type);
          if (!rule) {
            return intent; // No rule for this intent type, pass through
          }

          if (rule.getKey) {
            // Per-key mode
            const key = rule.getKey(intent.payload);
            const keys = perKeyFlags.get(rule.intentType)!;

            if (rule.isForced?.(intent)) {
              keys.add(key);
              return intent; // Force bypasses block
            }

            if (keys.has(key)) {
              return null; // Block duplicate
            }

            keys.add(key);
            return intent;
          }

          // Singleton mode
          if (singletonFlags.get(rule.intentType)) {
            return null; // Block duplicate
          }

          singletonFlags.set(rule.intentType, true);
          return intent;
        },
      },
    ],
    ...(Object.keys(events).length > 0 && { events }),
  };
}
