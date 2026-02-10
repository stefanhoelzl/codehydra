/**
 * AppShutdownOperation - Orchestrates application shutdown.
 *
 * Runs two hook points in sequence:
 * 1. "stop" - All modules dispose their resources (independent, best-effort).
 *    Each module's stop handler wraps its own logic in try/catch,
 *    ensuring all modules get a chance to dispose even if earlier ones fail.
 * 2. "quit" - Terminates the process (runs after all cleanup).
 *
 * The operation ignores ctx.error because shutdown is best-effort --
 * individual module errors are logged but do not prevent other modules
 * from disposing.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppShutdownPayload {
  /** No payload needed - shutdown has no parameters. */
  readonly [key: string]: never;
}

export interface AppShutdownIntent extends Intent<void> {
  readonly type: "app:shutdown";
  readonly payload: AppShutdownPayload;
}

export const INTENT_APP_SHUTDOWN = "app:shutdown" as const;

// =============================================================================
// Hook Context
// =============================================================================

export const APP_SHUTDOWN_OPERATION_ID = "app-shutdown";

/**
 * Hook context for app:shutdown.
 *
 * Modules use this for "stop" and "quit" hook points. Each module handles its
 * own errors internally (best-effort shutdown).
 * Currently identical to HookContext -- exists as a named alias for clarity.
 */
export type AppShutdownHookContext = HookContext;

// =============================================================================
// Operation
// =============================================================================

export class AppShutdownOperation implements Operation<AppShutdownIntent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;

  async execute(ctx: OperationContext<AppShutdownIntent>): Promise<void> {
    const hookCtx: AppShutdownHookContext = {
      intent: ctx.intent,
    };

    // Hook: "stop" -- All modules dispose (independent, best-effort)
    // Each module wraps its logic in try/catch internally.
    await ctx.hooks.run("stop", hookCtx);

    // Hook: "quit" -- Terminate the process (runs after all cleanup)
    await ctx.hooks.run("quit", hookCtx);

    // Intentionally ignore hookCtx.error -- shutdown is best-effort.
    // Individual module errors are logged by each module's handler.
  }
}
