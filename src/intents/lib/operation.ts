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
 * Return type of a hook handler.
 *
 * A handler is either:
 *  - a plain async function returning a `HookOutput<T>` (or `void` for an empty output), or
 *  - an `async function*` that **yields** progress frames of type `Y` (pure data) and
 *    **returns** its `HookOutput<T>`. The dispatcher drains the generator, forwarding each
 *    yielded frame to the `onYield` callback the operation passed to `collect()`, and uses
 *    the generator's return value as the handler's output.
 *
 * The streaming form lets a long-running handler (clone, binary download) surface progress
 * without holding a closure: it yields neutral data, and the host-side operation maps each
 * frame to a domain event and emits it. The `onYield` callback lives operation ↔ `collect`,
 * never in the handler's `HookContext`, so the data-only-context invariant holds.
 */
export type HookHandlerReturn<T = unknown, Y = unknown> =
  | Promise<HookOutput<T> | void>
  | AsyncGenerator<Y, HookOutput<T> | void, void>;

/**
 * A handler registered for a hook point.
 *
 * Generic parameter `T` is the unwrapped result type for `collect()` — defaults to `unknown`
 * so that `HookDeclarations` (which uses `HookHandler`) accepts handlers with any result type.
 * Generic parameter `Y` is the progress-frame type for streaming (`async function*`) handlers;
 * it defaults to `unknown` and is irrelevant to non-streaming handlers.
 * A handler returns a `HookOutput<T>` (result and/or provided capabilities); returning `void`
 * is shorthand for an empty output (no result, no capabilities).
 */
export interface HookHandler<T = unknown, Y = unknown> {
  /** Module name — set by the Dispatcher during registerModule(). */
  readonly name?: string;
  readonly handler: (ctx: HookContext) => HookHandlerReturn<T, Y>;
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
 * Options for `collect()`.
 *
 * `onYield` receives each progress frame yielded by a streaming (`async function*`) handler
 * on this hook point. It runs host-side (operation ↔ dispatcher) — the operation typically
 * narrows the frame and maps it to a domain event, then emits it. The frame is typed
 * `unknown` because the dispatcher stores handlers without their yield type; a hook point
 * carries a single progress semantic, so the operation knows how to narrow it (and a remote
 * proxy will validate it against the wire schema before it reaches here).
 */
export interface CollectOptions {
  readonly onYield?: (frame: unknown) => void | Promise<void>;
}

/**
 * Resolved hooks for a specific operation.
 *
 * `collect()` provides isolated-context execution: each handler receives a frozen
 * clone of the input context. All handlers always run. Returns typed results + errors.
 * Streaming handlers' yielded frames are delivered to `options.onYield` as they occur.
 */
export interface ResolvedHooks {
  collect<T = unknown>(
    hookPointId: string,
    ctx: HookContext,
    options?: CollectOptions
  ): Promise<HookResult<T>>;
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
