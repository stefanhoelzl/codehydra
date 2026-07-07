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
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppResumeIntent extends Intent<void> {
  readonly type: "app:resume";
  readonly payload: Record<string, never>;
}

export const INTENT_APP_RESUME = "app:resume" as const;

// =============================================================================
// Operation + Hook Point IDs
// =============================================================================

export const APP_RESUME_OPERATION_ID = "app-resume";
export const APP_RESUME_HOOK_RESUME = "resume";

/**
 * Per-handler result for the "resume" hook point (data only).
 * A handler reports the outcome of its recovery attempt; the operation maps it to
 * domain events. Omit both fields (return void) when there was nothing to recover.
 */
export interface ResumeHookResult {
  /** A stale server was killed and a fresh one is now listening (→ ide-server:restarted). */
  readonly restarted?: boolean;
  /** Recovery failed; human-readable error for display (→ app:resume-failed). */
  readonly failed?: { readonly error: string };
}

// =============================================================================
// Event Types
// =============================================================================

export const EVENT_APP_RESUMED = "app:resumed" as const;

/**
 * Emitted by any handler on the `resume` hook point when recovery fails.
 * Generic by design — the operation doesn't know which module failed; the
 * emitter provides a human-readable error for display.
 */
export interface AppResumeFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_APP_RESUME_FAILED;
  readonly payload: { readonly error: string };
}

export const EVENT_APP_RESUME_FAILED = "app:resume-failed" as const;

/**
 * Emitted by ide-server-module after it kills and restarts the IDE server on
 * resume (the readiness probe failed and a fresh process is now listening).
 * view-module reacts by reloading all workspace iframes, whose connections to
 * the replaced server are stale — otherwise the IDE server shows its own
 * "Reload" dialog in each workspace.
 */
export interface IdeServerRestartedEvent extends DomainEvent {
  readonly type: typeof EVENT_IDE_SERVER_RESTARTED;
  readonly payload: Record<string, never>;
}

export const EVENT_IDE_SERVER_RESTARTED = "ide-server:restarted" as const;

// =============================================================================
// Operation
// =============================================================================

export class AppResumeOperation implements Operation<AppResumeIntent, void> {
  readonly id = APP_RESUME_OPERATION_ID;

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
