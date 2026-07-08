/**
 * Operation types for the intent-operation architecture.
 *
 * Operations are orchestrators registered for specific intent types.
 * They receive a context with hooks, dispatch, and emit capabilities.
 */

import type { z } from "zod/v4";
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
export interface Operation<S extends OperationSchemas = OperationSchemas> {
  readonly id: string;
  /**
   * The operation's contract schemas (item 2) — the single source of truth for its Intent
   * and result types. The dispatcher indexes them at registration (keyed by `schemas.type`)
   * and validates every dispatch against them. The Intent/result the operation orchestrates
   * are **derived** from this bundle via {@link IntentOf} / {@link ResultOf}.
   */
  readonly schemas: S;
  execute(ctx: OperationContext<IntentOf<S>>): Promise<ResultOf<S>>;
}

/** Per-hook-point schemas: whole input context, each handler's partial result, provided data. */
export interface HookPointSchemas {
  /**
   * Whole input context (intent + scalar capabilities + enrichment) — validated for its
   * throw/normalization side effect only; the operation-built context (a `HookContext`) is
   * what reaches the handler. Fail → throw (the operation built a bad context).
   */
  readonly input?: z.ZodType;
  /** Each handler's partial result. Fail → collected error (isolated per handler). */
  readonly result?: z.ZodType;
  /** Provided capability data (scalar bag). Fail → collected error. */
  readonly provides?: z.ZodType<Readonly<Record<string, unknown>>>;
}

/**
 * The zod schemas an operation declares for its contract. Colocated with the op's
 * `*_OPERATION_ID` / hook-point / `EVENT_*` definitions; the dispatcher reads them at
 * `registerOperation` (payload/result/hooks via the operations map; `events` folded into
 * an event→schema lookup for `emitEvent`).
 */
export interface OperationSchemas {
  /** Intent type literal — the discriminator, and the dispatcher registration key. */
  readonly type: string;
  /** Intent payload — validated at dispatch entry (fail → reject the dispatch). */
  readonly payload: z.ZodType;
  /** Operation return value — validated before resolve (fail → reject). Omit for a void result. */
  readonly result?: z.ZodType;
  /** Per-hook-point schemas, keyed by hook point id. */
  readonly hooks?: Readonly<Record<string, HookPointSchemas>>;
  /** Event payload schemas, keyed by event type — validated at emit (fail → throw). */
  readonly events?: Readonly<Record<string, z.ZodType>>;
}

/**
 * The result type an operation's `schemas` describe — `z.infer` of the `result` schema,
 * or `void` when none is declared. Derived so an operation never restates its result type.
 */
export type ResultOf<S extends OperationSchemas> = S extends {
  readonly result: infer R extends z.ZodType;
}
  ? z.infer<R>
  : void;

/**
 * The Intent type an operation's `schemas` describe: the declared `type` literal, the
 * `z.infer` of the `payload` schema, and the derived result as the phantom carrier. Lets an
 * operation derive its whole Intent from `typeof schemas` instead of hand-writing an interface:
 *
 *   const schemas = { type: INTENT_X, payload: xPayloadSchema, result: xResultSchema } satisfies OperationSchemas;
 *   export type XIntent = IntentOf<typeof schemas>;
 */
export type IntentOf<S extends OperationSchemas> = Intent<ResultOf<S>> & {
  readonly type: S["type"];
  readonly payload: z.infer<S["payload"]>;
};
