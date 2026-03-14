/**
 * AppReadyOperation - Loads initial projects after the renderer signals ready.
 *
 * Dispatched when the renderer calls lifecycle.ready() via IPC. This ensures
 * event subscriptions are in place before project:open dispatches fire.
 *
 * Runs one hook point:
 * 1. "load-projects" - Collect saved project paths from modules
 *
 * After collecting paths, dispatches project:open for each saved project
 * (best-effort, skips invalid projects). Once all dispatches complete,
 * emits an `app:started` domain event so the renderer knows startup is done.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "./open-project";
import { Path } from "../../services/platform/path";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppReadyPayload {
  /** No payload needed. */
  readonly [key: string]: never;
}

export interface AppReadyIntent extends Intent<void> {
  readonly type: "app:ready";
  readonly payload: AppReadyPayload;
}

export const INTENT_APP_READY = "app:ready" as const;

// =============================================================================
// Domain Events
// =============================================================================

/** Emitted after all initial project:open dispatches complete. */
export interface AppStartedEvent extends DomainEvent {
  readonly type: typeof EVENT_APP_STARTED;
  readonly payload: Record<string, never>;
}

export const EVENT_APP_STARTED = "app:started" as const;

// =============================================================================
// Hook Result Types
// =============================================================================

export const APP_READY_OPERATION_ID = "app-ready";

/**
 * Per-handler result for "load-projects" hook point.
 * Modules return paths to saved projects that should be opened on startup.
 */
export interface LoadProjectsResult {
  readonly projectPaths?: readonly string[];
}

// =============================================================================
// Operation
// =============================================================================

export class AppReadyOperation implements Operation<AppReadyIntent, void> {
  readonly id = APP_READY_OPERATION_ID;

  async execute(ctx: OperationContext<AppReadyIntent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };

    // Collect saved project paths from modules
    const { results, errors } = await ctx.hooks.collect<LoadProjectsResult>(
      "load-projects",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;

    const projectPaths: string[] = [];
    for (const result of results) {
      if (result.projectPaths) projectPaths.push(...result.projectPaths);
    }

    // Dispatch project:open for each saved project (best-effort).
    // Each project:open dispatches workspace:create + workspace:switch internally.
    for (const projectPath of projectPaths) {
      try {
        await ctx.dispatch({
          type: INTENT_OPEN_PROJECT,
          payload: { path: new Path(projectPath) },
        } as OpenProjectIntent);
      } catch {
        // Skip invalid projects (no longer exist, not git repos, etc.)
      }
    }

    // Signal that initial project:open dispatches are complete.
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
  }
}
