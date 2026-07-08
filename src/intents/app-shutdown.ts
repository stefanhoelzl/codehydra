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
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload schema is
 * declared once and hung on the operation's `schemas` field; the `Intent` and payload
 * types are **derived** from that bundle via `IntentOf`/`z.infer`. Both hook points
 * ("stop", "quit") return void, so no per-hook-point schema is declared.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";

export const INTENT_APP_SHUTDOWN = "app:shutdown" as const;

// =============================================================================
// Hook Context
// =============================================================================

export const APP_SHUTDOWN_OPERATION_ID = "app-shutdown";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const appShutdownPayloadSchema = z
  .object({
    /** If true, install a downloaded update after shutdown cleanup. */
    installUpdate: z.boolean().optional(),
  })
  .readonly();

const schemas = {
  type: INTENT_APP_SHUTDOWN,
  payload: appShutdownPayloadSchema,
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AppShutdownPayload = z.infer<typeof appShutdownPayloadSchema>;
export type AppShutdownIntent = IntentOf<typeof schemas>;

// =============================================================================
// Operation
// =============================================================================

export class AppShutdownOperation implements Operation<typeof schemas> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;
  readonly schemas = schemas;

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
