/**
 * AppResumeOperation - Orchestrates recovery after system wake from sleep/hibernate.
 *
 * Single hook point:
 * - "resume" - Probe code-server health and restart it if the probe fails.
 *              The hook context includes `emit` so handlers can fire their own
 *              domain events: code-server-module emits `code-server:restarted`
 *              on a successful restart (view-module reacts by reloading the
 *              workspace iframes, whose connections to the replaced server are
 *              stale) and `app:resume-failed` if the restart fails.
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
 * Extended context for the "resume" hook point.
 * Exposes `emit` so handlers can fire domain events (e.g., restart failures).
 */
export interface ResumeHookContext extends HookContext {
  readonly emit: (event: DomainEvent) => Promise<void>;
}

// =============================================================================
// Event Types
// =============================================================================

export interface AppResumedEvent extends DomainEvent {
  readonly type: typeof EVENT_APP_RESUMED;
  readonly payload: Record<string, never>;
}

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
 * Emitted by code-server-module after it kills and restarts code-server on
 * resume (the /healthz probe failed and a fresh process is now listening).
 * view-module reacts by reloading all workspace iframes, whose connections to
 * the replaced server are stale — otherwise code-server shows its own "Reload"
 * dialog in each workspace.
 */
export interface CodeServerRestartedEvent extends DomainEvent {
  readonly type: typeof EVENT_CODE_SERVER_RESTARTED;
  readonly payload: Record<string, never>;
}

export const EVENT_CODE_SERVER_RESTARTED = "code-server:restarted" as const;

// =============================================================================
// Operation
// =============================================================================

export class AppResumeOperation implements Operation<AppResumeIntent, void> {
  readonly id = APP_RESUME_OPERATION_ID;

  async execute(ctx: OperationContext<AppResumeIntent>): Promise<void> {
    const hookCtx: ResumeHookContext = {
      intent: ctx.intent,
      emit: ctx.emit,
    };
    await ctx.hooks.collect(APP_RESUME_HOOK_RESUME, hookCtx);
    await ctx.emit({ type: EVENT_APP_RESUMED, payload: {} });
  }
}
