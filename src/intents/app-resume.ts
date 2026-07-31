/**
 * AppResumeOperation - Orchestrates recovery after system wake from sleep/hibernate.
 *
 * Single hook point:
 * - "resume" - Probe IDE server health and restart it if the probe fails.
 *              Handlers return a `ResumeHookResult` (data only, no closures):
 *              `{ restarted: true }` when a stale IDE server was replaced,
 *              `{ staleClients: true }` when the server survived but the suspend
 *              outlasted what its clients can reconnect across, or
 *              `{ failed: { error } }` when recovery failed. The operation turns
 *              those results into domain events — `ide-server:restarted` and
 *              `ide-server:sessions-stale` (view-module reloads the workspace
 *              iframes on either, since both leave their sessions dead) and
 *              `app:resume-failed`.
 *
 * The intent payload carries `sleptMs`, the wall-clock suspend gap measured by
 * electron-lifecycle-module (which owns the power monitor). Handlers apply their
 * own thresholds to it; the operation itself never interprets it.
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
import { hookCtxSchema } from "./contract";

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

export const EVENT_IDE_SERVER_SESSIONS_STALE = "ide-server:sessions-stale" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const appResumePayloadSchema = z
  .object({
    /**
     * Wall-clock milliseconds the machine spent suspended, measured by the
     * lifecycle module that owns the power monitor. Handlers decide for
     * themselves what a given gap means — e.g. ide-server-module compares it
     * against the IDE's client reconnection grace. Optional so a dispatch that
     * has no measurement (tests, a manual re-dispatch) stays valid; absent is
     * read as "no gap worth acting on".
     */
    sleptMs: z.number().nonnegative().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "resume" hook point (data only).
 * A handler reports the outcome of its recovery attempt; the operation maps it to
 * domain events. Omit both fields (return void) when there was nothing to recover.
 */
export const resumeHookResultSchema = z
  .object({
    /** A stale server was killed and a fresh one is now listening (→ ide-server:restarted). */
    restarted: z.boolean().optional(),
    /**
     * The server itself is healthy, but the suspend outlasted what its clients
     * can recover from, so every open session is dead (→ ide-server:sessions-stale).
     * Distinct from `restarted`: nothing was replaced, only the clients lost.
     */
    staleClients: z.boolean().optional(),
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

/** Payload emitted by `ide-server:sessions-stale`. */
export const ideServerSessionsStalePayloadSchema = z.object({}).readonly();

/** The resume hook point receives the bare intent. */
const appResumeHookInputSchema = hookCtxSchema(appResumePayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_APP_RESUME,
  payload: appResumePayloadSchema,
  hooks: {
    [APP_RESUME_HOOK_RESUME]: { input: appResumeHookInputSchema, result: resumeHookResultSchema },
  },
  events: {
    [EVENT_APP_RESUMED]: appResumedPayloadSchema,
    [EVENT_APP_RESUME_FAILED]: appResumeFailedPayloadSchema,
    [EVENT_IDE_SERVER_RESTARTED]: ideServerRestartedPayloadSchema,
    [EVENT_IDE_SERVER_SESSIONS_STALE]: ideServerSessionsStalePayloadSchema,
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

/**
 * Emitted by ide-server-module when the machine resumed from a suspend long
 * enough to outlast the IDE's client-side reconnection grace. The server
 * process survived — the probe passed, nothing was restarted — but every
 * workspace iframe's session is unrecoverable, and each is about to show the
 * IDE's own modal "Cannot reconnect. Please reload the window."
 *
 * view-module reacts identically to `ide-server:restarted`: reload the frames.
 * The two are kept apart because the causes are different (a replaced server
 * vs. expired client sessions) and only this module can judge the second.
 */
export interface IdeServerSessionsStaleEvent extends DomainEvent {
  readonly type: typeof EVENT_IDE_SERVER_SESSIONS_STALE;
  readonly payload: z.infer<typeof ideServerSessionsStalePayloadSchema>;
}

// =============================================================================
// Operation
// =============================================================================

export class AppResumeOperation implements Operation<typeof schemas> {
  readonly id = APP_RESUME_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<AppResumeIntent, typeof schemas>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results } = await ctx.hooks.collect(APP_RESUME_HOOK_RESUME, hookCtx);

    // Turn handler outcomes into domain events (operation owns emits).
    for (const result of results) {
      if (result.restarted) {
        await ctx.emit({ type: EVENT_IDE_SERVER_RESTARTED, payload: {} });
      }
      if (result.staleClients) {
        await ctx.emit({ type: EVENT_IDE_SERVER_SESSIONS_STALE, payload: {} });
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
