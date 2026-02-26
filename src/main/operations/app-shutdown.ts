/**
 * AppShutdownOperation - Orchestrates application shutdown.
 *
 * Runs two hook points in sequence:
 * 1. "stop" - All modules dispose their resources (independent, best-effort).
 *    collect() catches errors from each handler and continues to the next,
 *    ensuring all modules get a chance to dispose even if earlier ones fail.
 *    The dispatcher logs hook errors centrally.
 * 2. "quit" - Terminates the process (runs after all cleanup).
 *
 * The operation ignores both results and errors because shutdown is
 * best-effort -- individual module errors are logged by the dispatcher
 * and do not prevent other modules from disposing.
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

// =============================================================================
// Operation
// =============================================================================

export class AppShutdownOperation implements Operation<AppShutdownIntent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;

  async execute(ctx: OperationContext<AppShutdownIntent>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Hook: "stop" -- All modules dispose (independent, best-effort)
    // collect() catches errors from each handler and continues to the next.
    // The dispatcher logs hook errors centrally.
    await ctx.hooks.collect<void>("stop", hookCtx);

    // Hook: "quit" -- Terminate the process (runs after all cleanup)
    await ctx.hooks.collect<void>("quit", hookCtx);

    // Intentionally ignore both results and errors -- shutdown is best-effort.
    // Individual module errors are logged by the dispatcher.
  }
}
