/**
 * Operation types for the intent-operation architecture.
 *
 * Operations are orchestrators registered for specific intent types.
 * They receive a context with hooks, dispatch, and emit capabilities.
 */

import type { Intent, IntentResult, DomainEvent } from "./types";

// =============================================================================
// Dispatch Function Type
// =============================================================================

/**
 * Dispatch function signature for nested intent dispatch.
 * Available in OperationContext for operations that need to trigger sub-intents.
 */
export type DispatchFn = <I extends Intent>(
  intent: I,
  causation?: readonly string[]
) => Promise<IntentResult<I>>;

// =============================================================================
// Hook System
// =============================================================================

/** Sentinel for requires: capability must exist, any value accepted. */
export const ANY_VALUE: unique symbol = Symbol("any-value");

/**
 * Base context passed to hook handlers.
 * Operations build extended contexts (with `readonly` fields) to pass data
 * between hook points. Each handler receives a frozen shallow copy.
 */
export interface HookContext {
  readonly intent: Intent;
  /** Accumulated capabilities from previously-executed handlers. Defaults to {}. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

/**
 * A handler's return value.
 *
 * Both fields are optional so a handler can contribute a result, capabilities,
 * both, or neither. Replaces the former `HookHandler.provides` closure: capabilities
 * are returned as plain data, so a handler that executes remotely can ship them
 * across a wire and the host dispatcher merges from the returned data instead of
 * invoking a host-side closure.
 *
 * Generic parameter `T` is the unwrapped result type — the dispatcher lifts `result`
 * into `collect()`'s `results[]`, so `collect<T>()` consumers are unchanged.
 */
export interface HookOutput<T = unknown> {
  /** Value contributed to `collect()`'s `results[]`. Omit (or `undefined`/`null`) for none. */
  readonly result?: T | null;
  /** Capabilities merged into the running capability bag after the handler completes.
   *  Plain data (no closure). Keys with `undefined` values are skipped during the merge,
   *  so a capability is only "present" when it carries a defined value. */
  readonly provides?: Readonly<Record<string, unknown>>;
}

/**
 * A handler registered for a hook point.
 *
 * Generic parameter `T` is the unwrapped result type for `collect()` — defaults to `unknown`
 * so that `HookDeclarations` (which uses `HookHandler`) accepts handlers with any result type.
 * A handler returns a `HookOutput<T>` (result and/or provided capabilities); returning `void`
 * is shorthand for an empty output (no result, no capabilities).
 */
export interface HookHandler<T = unknown> {
  /** Module name — set by the Dispatcher during registerModule(). */
  readonly name?: string;
  readonly handler: (ctx: HookContext) => Promise<HookOutput<T> | void>;
  /** Capabilities this handler requires before it can execute.
   *  Key = capability name. Value = required value, or ANY_VALUE for "must exist, any value". */
  readonly requires?: Readonly<Record<string, unknown>>;
}

/**
 * Result of `collect()` — typed results from all handlers plus any collected errors.
 * All handlers always run regardless of earlier errors.
 */
export interface HookResult<T = unknown> {
  readonly results: readonly T[];
  readonly errors: readonly Error[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/**
 * Resolved hooks for a specific operation.
 *
 * `collect()` provides isolated-context execution: each handler receives a frozen
 * clone of the input context. All handlers always run. Returns typed results + errors.
 */
export interface ResolvedHooks {
  collect<T = unknown>(hookPointId: string, ctx: HookContext): Promise<HookResult<T>>;
}

// =============================================================================
// Operation
// =============================================================================

/**
 * Context injected into operations by the dispatcher.
 */
export interface OperationContext<I extends Intent = Intent> {
  readonly intent: I;
  readonly dispatch: DispatchFn;
  readonly emit: (event: DomainEvent) => Promise<void>;
  readonly hooks: ResolvedHooks;
  readonly causation: readonly string[];
}

/**
 * An operation that handles a specific intent type.
 * Operations orchestrate hooks and emit domain events.
 * They never call providers directly — hook handlers do the actual work.
 */
export interface Operation<I extends Intent = Intent, R = void> {
  readonly id: string;
  execute(ctx: OperationContext<I>): Promise<R>;
}
