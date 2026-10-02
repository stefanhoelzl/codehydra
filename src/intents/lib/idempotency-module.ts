/**
 * Idempotency module factory — produces a single IntentModule that blocks
 * duplicate dispatches for one or more intent types.
 *
 * Supports three modes per rule:
 * - **Singleton**: boolean flag, blocks once set (e.g. app:shutdown)
 * - **Singleton with reset**: boolean flag cleared by a domain event (e.g. setup)
 * - **Per-key**: Set<string> keyed by payload field, with optional reset and force bypass
 *   (e.g. workspace:delete keyed by workspacePath)
 *
 * A per-key rule with `wait` holds a duplicate until the key is released by its
 * reset event, then lets it through, instead of blocking it (e.g. project:open).
 */

import type { Intent, DomainEvent } from "./types";
import type { IntentModule, EventDeclarations, EventHandler } from "./module";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Describes one idempotency rule applied to a specific intent type.
 */
export interface IdempotencyRule {
  /** Intent type this rule applies to. */
  readonly intentType: string;
  /** Extract a tracking key from the intent payload. Omit for singleton (boolean flag). Return undefined to skip the rule for this payload. */
  readonly getKey?: (payload: unknown) => string | undefined;
  /** Domain event type(s) that reset tracking state. Uses getKey on event payload for per-key reset. */
  readonly resetOn?: string | readonly string[];
  /** Return true to bypass the idempotency block (intent still gets tracked). */
  readonly isForced?: (intent: Intent) => boolean;
  /**
   * Per-key only: hold a duplicate until the in-flight one's `resetOn` event
   * releases the key, then let it through (one at a time, in arrival order),
   * rather than blocking it. For intents whose callers need a result — a blocked
   * dispatch resolves to `undefined`. Every path of the operation must emit a
   * reset event, or the duplicates wait forever.
   */
  readonly wait?: boolean;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an IntentModule that enforces idempotency for the given rules.
 *
 * Returns a module with:
 * - One interceptor (id: "idempotency") covering all rules
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
  // Duplicates of a `wait` rule parked until their key is released, in arrival order.
  const waiters = new Map<string, Map<string, (() => void)[]>>();

  /** Release a key, or hand it over still held to the first waiter. */
  function release(intentType: string, key: string): void {
    const queue = waiters.get(intentType)?.get(key);
    const next = queue?.shift();
    if (next === undefined) {
      perKeyFlags.get(intentType)?.delete(key);
      return;
    }
    if (queue!.length === 0) waiters.get(intentType)!.delete(key);
    next();
  }

  // Initialize state for each rule
  for (const rule of rules) {
    if (rule.getKey) {
      perKeyFlags.set(rule.intentType, new Set<string>());
      if (rule.wait) waiters.set(rule.intentType, new Map());
    } else {
      singletonFlags.set(rule.intentType, false);
    }
  }

  // Build event handlers for resetOn rules
  // Multiple rules may reset on the same event type, so group them.
  const resetRulesByEvent = new Map<string, IdempotencyRule[]>();
  for (const rule of rules) {
    if (rule.resetOn) {
      const eventTypes = typeof rule.resetOn === "string" ? [rule.resetOn] : rule.resetOn;
      for (const eventType of eventTypes) {
        const list = resetRulesByEvent.get(eventType);
        if (list) {
          list.push(rule);
        } else {
          resetRulesByEvent.set(eventType, [rule]);
        }
      }
    }
  }

  const events: EventDeclarations = {};
  for (const [eventType, resetRules] of resetRulesByEvent) {
    (events as Record<string, EventHandler>)[eventType] = {
      handler: async (event: DomainEvent): Promise<void> => {
        for (const rule of resetRules) {
          if (rule.getKey) {
            const key = rule.getKey(event.payload);
            if (key !== undefined && perKeyFlags.get(rule.intentType)?.has(key)) {
              release(rule.intentType, key);
            }
          } else {
            singletonFlags.set(rule.intentType, false);
          }
        }
      },
    };
  }

  return {
    name: "idempotency",
    interceptors: [
      {
        id: "idempotency",
        async before(intent: Intent): Promise<Intent | null> {
          const rule = rulesByIntent.get(intent.type);
          if (!rule) {
            return intent; // No rule for this intent type, pass through
          }

          if (rule.getKey) {
            // Per-key mode
            const key = rule.getKey(intent.payload);
            if (key === undefined) {
              return intent; // getKey opted out for this payload
            }
            const keys = perKeyFlags.get(rule.intentType)!;

            if (rule.isForced?.(intent)) {
              keys.add(key);
              return intent; // Force bypasses block
            }

            if (keys.has(key)) {
              if (!rule.wait) return null; // Block duplicate
              // Wait for the key. release() hands it over still held, so no
              // other dispatch can take it in between.
              const queue = waiters.get(rule.intentType)!;
              await new Promise<void>((resolve) => {
                const parked = queue.get(key);
                if (parked) parked.push(resolve);
                else queue.set(key, [resolve]);
              });
              return intent;
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
