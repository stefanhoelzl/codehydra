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
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook/
 * event schemas are declared once and hung on the operation's `schemas` field; the `Intent`
 * and result types are **derived** via `IntentOf`/`z.infer`. The agent vocabulary
 * (`agentTypeSchema`/`agentInfoSchema`) lives in the contract; `shared/ipc` re-exports those
 * types, so there is one definition rather than a schema mirroring an interface.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "./open-project";
import { agentInfoSchema, agentTypeSchema, projectPathSchema, hookCtxSchema } from "./contract";
import type { AgentInfo, AgentType, ProjectPath } from "./contract";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import { throwHookErrors } from "./lib/hook-helpers";

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

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const appReadyPayloadSchema = z.object({}).readonly();

/**
 * Result of app:ready. No longer sent to the renderer (the ui-connected
 * handshake is fire-and-forget); retained as the operation's typed result.
 */
export const appReadyResultSchema = z
  .object({
    /** Global default agent (config.agent). Null when not yet chosen (first-run pending). */
    defaultAgent: agentTypeSchema.nullable(),
    /** Agents whose binaries are currently present on disk. */
    availableAgents: z.array(agentInfoSchema).readonly(),
  })
  .readonly();

/**
 * Per-handler result for "load-projects" hook point.
 * Modules return paths to saved projects that should be opened on startup.
 */
export const loadProjectsResultSchema = z
  .object({
    projectPaths: z.array(projectPathSchema).readonly().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "available-agents" hook point.
 * Each agent module returns its `AgentInfo` only if its binary is present.
 */
export const availableAgentsResultSchema = z
  .object({
    agent: agentInfoSchema.optional(),
  })
  .readonly();

/** Payload emitted by `app:started`. */
export const appStartedPayloadSchema = z.object({}).readonly();

/** Both hook points receive the bare intent — declared so the context type is derived. */
const appReadyHookInputSchema = hookCtxSchema(appReadyPayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_APP_READY,
  payload: appReadyPayloadSchema,
  result: appReadyResultSchema,
  hooks: {
    "load-projects": { input: appReadyHookInputSchema, result: loadProjectsResultSchema },
    "available-agents": { input: appReadyHookInputSchema, result: availableAgentsResultSchema },
  },
  events: {
    [EVENT_APP_STARTED]: appStartedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AppReadyPayload = z.infer<typeof appReadyPayloadSchema>;
export type AppReadyResult = z.infer<typeof appReadyResultSchema>;
export type AppReadyIntent = IntentOf<typeof schemas>;
export type LoadProjectsResult = z.infer<typeof loadProjectsResultSchema>;
export type AvailableAgentsResult = z.infer<typeof availableAgentsResultSchema>;

// =============================================================================
// Operation
// =============================================================================

export class AppReadyOperation implements Operation<typeof schemas> {
  readonly id = APP_READY_OPERATION_ID;
  readonly schemas = schemas;

  constructor(private readonly agentConfig: PersistedAccessor<AgentType>) {}

  async execute(ctx: OperationContext<AppReadyIntent, typeof schemas>): Promise<AppReadyResult> {
    const hookCtx: HookContext = { intent: ctx.intent };

    // Collect bootstrap data: available agents + saved project paths in parallel.
    const [agentsResult, projectsResult] = await Promise.all([
      ctx.hooks.collect("available-agents", hookCtx),
      ctx.hooks.collect("load-projects", hookCtx),
    ]);
    throwHookErrors(projectsResult.errors, "app:ready load-projects hooks failed");
    // available-agents errors are best-effort: an agent that fails preflight just
    // doesn't appear in the list.

    const availableAgents: AgentInfo[] = [];
    for (const result of agentsResult.results) {
      if (result.agent) availableAgents.push(result.agent);
    }

    const defaultAgentRaw = this.agentConfig.get();
    const defaultAgent: AgentType | null = agentTypeSchema.safeParse(defaultAgentRaw).data ?? null;

    const projectPaths: ProjectPath[] = [];
    for (const result of projectsResult.results) {
      if (result.projectPaths) projectPaths.push(...result.projectPaths);
    }

    // Dispatch project:open for each saved project (best-effort, in parallel).
    // Each project:open dispatches workspace:create + workspace:switch internally.
    // allSettled keeps best-effort semantics: invalid projects (no longer exist,
    // not git repos, etc.) are silently dropped without aborting the rest.
    await Promise.allSettled(
      projectPaths.map((projectPath) =>
        ctx.dispatch<OpenProjectIntent>({
          type: INTENT_OPEN_PROJECT,
          payload: { path: projectPath },
        })
      )
    );

    // Signal that initial project:open dispatches are complete.
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });

    return { defaultAgent, availableAgents };
  }
}
