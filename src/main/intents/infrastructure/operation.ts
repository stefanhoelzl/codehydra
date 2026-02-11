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

/**
 * Base context passed to hook handlers.
 * Operations extend this interface when they need data to flow
 * between hooks (e.g., query results).
 *
 * @example
 * interface GetMetadataHookContext extends HookContext {
 *   metadata?: Readonly<Record<string, string>>;
 * }
 */
export interface HookContext {
  readonly intent: Intent;
  error?: Error;
}

/**
 * A handler registered for a hook point.
 * If `onError` is true, the handler runs even after a previous handler errors.
 *
 * Generic parameter `T` is the return type for `collect()` — defaults to `unknown`
 * so that `HookDeclarations` (which uses `HookHandler`) accepts handlers with any return type.
 */
export interface HookHandler<T = unknown> {
  readonly handler: (ctx: HookContext) => Promise<T>;
  readonly onError?: boolean;
}

/**
 * Result of `collect()` — typed results from all handlers plus any collected errors.
 * All handlers always run regardless of earlier errors.
 */
export interface HookResult<T = unknown> {
  readonly results: readonly T[];
  readonly errors: readonly Error[];
}

/**
 * Resolved hooks for a specific operation.
 *
 * - `run()`: Legacy shared-context execution. Sets `ctx.error` on failure, skips
 *   subsequent non-onError handlers. Does NOT throw.
 * - `collect()`: Isolated-context execution. Each handler receives a frozen clone
 *   of the input context. All handlers always run. Returns typed results + errors.
 */
export interface ResolvedHooks {
  run(hookPointId: string, ctx: HookContext): Promise<void>;
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
  readonly emit: (event: DomainEvent) => void;
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
