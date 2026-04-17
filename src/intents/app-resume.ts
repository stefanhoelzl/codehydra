/**
 * AppResumeOperation - Orchestrates recovery after system wake from sleep/hibernate.
 *
 * Single hook point:
 * - "resume" - Probe code-server health and reload workspace views.
 *              code-server-module provides `codeServerReady`; view-module's
 *              reload handler requires it so the reload only runs after the
 *              server is confirmed healthy (or has been restarted).
 *              Hook context includes `emit` so handlers can fire their own
 *              domain events (e.g. code-server:restart-failed).
 *
 * After hooks complete, emits `app:resumed` for telemetry subscribers
 * (posthog-module) that don't depend on server state.
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
