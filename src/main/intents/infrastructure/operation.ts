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
 */
export interface HookHandler {
  readonly handler: (ctx: HookContext) => Promise<void>;
  readonly onError?: boolean;
}

/**
 * Resolved hooks for a specific operation.
 * The `run` method executes all handlers for a hook point.
 * It does NOT throw — it sets `ctx.error` on failure and skips
 * subsequent non-onError handlers.
 */
export interface ResolvedHooks {
  run(hookPointId: string, ctx: HookContext): Promise<void>;
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
