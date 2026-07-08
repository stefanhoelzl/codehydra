/**
 * AppResumeOperation - Orchestrates recovery after system wake from sleep/hibernate.
 *
 * Single hook point:
 * - "resume" - Probe IDE server health and restart it if the probe fails.
 *              Handlers return a `ResumeHookResult` (data only, no closures):
 *              `{ restarted: true }` when a stale IDE server was replaced, or
 *              `{ failed: { error } }` when recovery failed. The operation turns
 *              those results into domain events — `ide-server:restarted`
 *              (view-module reloads the workspace iframes whose connections to the
 *              replaced server are stale) and `app:resume-failed`.
 *
 * After hooks complete, emits `app:resumed` for telemetry subscribers
 * (telemetry-module) that don't depend on server state.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload, hook-result,
 * and event schemas are declared once and hung on the operation's `schemas` field; the
 * `Intent` and payload types are **derived** via `IntentOf`/`z.infer`. The event
 * interfaces (`AppResumeFailedEvent`, `IdeServerRestartedEvent`) are consumed by other
 * modules, so they stay exported — their `payload` types are derived from the schemas.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";

export const INTENT_APP_RESUME = "app:resume" as const;

// =============================================================================
// Operation + Hook Point IDs
// =============================================================================

export const APP_RESUME_OPERATION_ID = "app-resume";
export const APP_RESUME_HOOK_RESUME = "resume";

// =============================================================================
// Event Types
// =============================================================================

export const EVENT_APP_RESUMED = "app:resumed" as const;

export const EVENT_APP_RESUME_FAILED = "app:resume-failed" as const;

export const EVENT_IDE_SERVER_RESTARTED = "ide-server:restarted" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const appResumePayloadSchema = z.object({}).readonly();

/**
 * Per-handler result for the "resume" hook point (data only).
 * A handler reports the outcome of its recovery attempt; the operation maps it to
 * domain events. Omit both fields (return void) when there was nothing to recover.
 */
export const resumeHookResultSchema = z
  .object({
    /** A stale server was killed and a fresh one is now listening (→ ide-server:restarted). */
    restarted: z.boolean().optional(),
    /** Recovery failed; human-readable error for display (→ app:resume-failed). */
    failed: z.object({ error: z.string() }).readonly().optional(),
  })
  .readonly();

/** Payload emitted by `app:resumed` (telemetry). */
export const appResumedPayloadSchema = z.object({}).readonly();

/** Payload emitted by `app:resume-failed` — a human-readable error for display. */
export const appResumeFailedPayloadSchema = z.object({ error: z.string() }).readonly();

/** Payload emitted by `ide-server:restarted`. */
export const ideServerRestartedPayloadSchema = z.object({}).readonly();

const schemas = {
  type: INTENT_APP_RESUME,
  payload: appResumePayloadSchema,
  hooks: {
    [APP_RESUME_HOOK_RESUME]: { result: resumeHookResultSchema },
  },
  events: {
    [EVENT_APP_RESUMED]: appResumedPayloadSchema,
    [EVENT_APP_RESUME_FAILED]: appResumeFailedPayloadSchema,
    [EVENT_IDE_SERVER_RESTARTED]: ideServerRestartedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AppResumePayload = z.infer<typeof appResumePayloadSchema>;
export type AppResumeIntent = IntentOf<typeof schemas>;
export type ResumeHookResult = z.infer<typeof resumeHookResultSchema>;

/**
 * Emitted by any handler on the `resume` hook point when recovery fails.
 * Generic by design — the operation doesn't know which module failed; the
 * emitter provides a human-readable error for display.
 */
export interface AppResumeFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_APP_RESUME_FAILED;
  readonly payload: z.infer<typeof appResumeFailedPayloadSchema>;
}

/**
 * Emitted by ide-server-module after it kills and restarts the IDE server on
 * resume (the readiness probe failed and a fresh process is now listening).
 * view-module reacts by reloading all workspace iframes, whose connections to
 * the replaced server are stale — otherwise the IDE server shows its own
 * "Reload" dialog in each workspace.
 */
export interface IdeServerRestartedEvent extends DomainEvent {
  readonly type: typeof EVENT_IDE_SERVER_RESTARTED;
  readonly payload: z.infer<typeof ideServerRestartedPayloadSchema>;
}

// =============================================================================
// Operation
// =============================================================================

export class AppResumeOperation implements Operation<typeof schemas> {
  readonly id = APP_RESUME_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<AppResumeIntent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results } = await ctx.hooks.collect<ResumeHookResult>(APP_RESUME_HOOK_RESUME, hookCtx);

    // Turn handler outcomes into domain events (operation owns emits).
    for (const result of results) {
      if (result.restarted) {
        await ctx.emit({ type: EVENT_IDE_SERVER_RESTARTED, payload: {} });
      }
      if (result.failed) {
        await ctx.emit({
          type: EVENT_APP_RESUME_FAILED,
          payload: { error: result.failed.error },
        });
      }
    }

    await ctx.emit({ type: EVENT_APP_RESUMED, payload: {} });
  }
}
