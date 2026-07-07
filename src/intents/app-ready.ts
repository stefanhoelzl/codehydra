/**
 * AppReadyOperation - Loads initial projects after the renderer signals ready.
 *
 * Dispatched when the renderer emits the `ui-connected` ui:event (handled by
 * the presenter). This ensures the renderer's ui:state subscription is in
 * place before project:open dispatches fire.
 *
 * Runs one hook point:
 * 1. "load-projects" - Collect saved project paths from modules
 *
 * After collecting paths, dispatches project:open for each saved project
 * (best-effort, skips invalid projects). Once all dispatches complete,
 * emits an `app:started` domain event so the renderer knows startup is done.
 */

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "./open-project";
import { Path } from "../utils/path/path";
import type { AgentInfo, LifecycleAgentType } from "../shared/ipc";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { throwHookErrors } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppReadyPayload {
  /** No payload needed. */
  readonly [key: string]: never;
}

/**
 * Result of app:ready. No longer sent to the renderer (the ui-connected
 * handshake is fire-and-forget); retained as the operation's typed result.
 */
export interface AppReadyResult {
  /** Global default agent (config.agent). Null when not yet chosen (first-run pending). */
  readonly defaultAgent: LifecycleAgentType | null;
  /** Agents whose binaries are currently present on disk. */
  readonly availableAgents: readonly AgentInfo[];
}

export interface AppReadyIntent extends Intent<AppReadyResult> {
  readonly type: "app:ready";
  readonly payload: AppReadyPayload;
}

export const INTENT_APP_READY = "app:ready" as const;

// =============================================================================
// Domain Events
// =============================================================================

/** Emitted after all initial project:open dispatches complete. */
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

/**
 * Per-handler result for the "available-agents" hook point.
 * Each agent module returns its `AgentInfo` only if its binary is present.
 */
export interface AvailableAgentsResult {
  readonly agent?: AgentInfo;
}

// =============================================================================
// Operation
// =============================================================================

export class AppReadyOperation implements Operation<AppReadyIntent, AppReadyResult> {
  readonly id = APP_READY_OPERATION_ID;

  constructor(private readonly agentConfig: PersistedAccessor<ConfigAgentType>) {}

  async execute(ctx: OperationContext<AppReadyIntent>): Promise<AppReadyResult> {
    const hookCtx: HookContext = { intent: ctx.intent };

    // Collect bootstrap data: available agents + saved project paths in parallel.
    const [agentsResult, projectsResult] = await Promise.all([
      ctx.hooks.collect<AvailableAgentsResult>("available-agents", hookCtx),
      ctx.hooks.collect<LoadProjectsResult>("load-projects", hookCtx),
    ]);
    throwHookErrors(projectsResult.errors, "app:ready load-projects hooks failed");
    // available-agents errors are best-effort: an agent that fails preflight just
    // doesn't appear in the list.

    const availableAgents: AgentInfo[] = [];
    for (const result of agentsResult.results) {
      if (result.agent) availableAgents.push(result.agent);
    }

    const defaultAgentRaw = this.agentConfig.get();
    const defaultAgent: LifecycleAgentType | null =
      defaultAgentRaw === "claude" || defaultAgentRaw === "opencode" ? defaultAgentRaw : null;

    const projectPaths: string[] = [];
    for (const result of projectsResult.results) {
      if (result.projectPaths) projectPaths.push(...result.projectPaths);
    }

    // Dispatch project:open for each saved project (best-effort, in parallel).
    // Each project:open dispatches workspace:create + workspace:switch internally.
    // allSettled keeps best-effort semantics: invalid projects (no longer exist,
    // not git repos, etc.) are silently dropped without aborting the rest.
    await Promise.allSettled(
      projectPaths.map((projectPath) =>
        ctx.dispatch({
          type: INTENT_OPEN_PROJECT,
          payload: { path: new Path(projectPath) },
        } as OpenProjectIntent)
      )
    );

    // Signal that initial project:open dispatches are complete.
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });

    return { defaultAgent, availableAgents };
  }
}
