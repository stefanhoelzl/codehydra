/**
 * UpdateAgentStatusOperation - Resolves workspace context and emits agent:status-updated.
 *
 * Dispatches shared resolution intents:
 * 1. workspace:resolve — projectPath + workspaceName from workspacePath
 * 2. project:resolve — projectId from projectPath
 *
 * If resolution is incomplete (unknown workspace), silently returns without emitting.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/event schemas are
 * declared once and hung on the operation's `schemas` field; the `Intent` and event-payload
 * types are **derived** from that bundle via `IntentOf`/`z.infer`. The result is void.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { projectIdSchema, workspaceNameSchema, workspacePathSchema } from "./contract";
import type { ProjectPath } from "./contract";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

export const INTENT_UPDATE_AGENT_STATUS = "agent:update-status" as const;

export const EVENT_AGENT_STATUS_UPDATED = "agent:status-updated" as const;

const UPDATE_AGENT_STATUS_OPERATION_ID = "update-agent-status";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/**
 * Local schema for `InternalAgentCounts` (from shared/ipc). Not part of the intent
 * `contract` vocabulary, so it is defined here; its inferred type is structurally identical.
 */
const internalAgentCountsSchema = z
  .object({
    idle: z.number(),
    busy: z.number(),
  })
  .readonly();

/**
 * Local schema for `AggregatedAgentStatus` (from shared/ipc) — a discriminated union by
 * `status`. Not part of the intent `contract` vocabulary, so it is defined here; its inferred
 * type is structurally identical to `AggregatedAgentStatus`.
 */
const aggregatedAgentStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), counts: internalAgentCountsSchema }).readonly(),
  z.object({ status: z.literal("idle"), counts: internalAgentCountsSchema }).readonly(),
  z.object({ status: z.literal("busy"), counts: internalAgentCountsSchema }).readonly(),
  z.object({ status: z.literal("mixed"), counts: internalAgentCountsSchema }).readonly(),
]);

export const updateAgentStatusPayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
    status: aggregatedAgentStatusSchema,
  })
  .readonly();

const agentStatusUpdatedWorkspaceRefSchema = z
  .object({
    path: workspacePathSchema,
    projectId: projectIdSchema,
    name: workspaceNameSchema,
    active: z.boolean(),
  })
  .readonly();

export const agentStatusUpdatedPayloadSchema = z
  .object({
    workspace: agentStatusUpdatedWorkspaceRefSchema,
    status: aggregatedAgentStatusSchema,
  })
  .readonly();

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_UPDATE_AGENT_STATUS,
  payload: updateAgentStatusPayloadSchema,
  events: {
    [EVENT_AGENT_STATUS_UPDATED]: agentStatusUpdatedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type UpdateAgentStatusPayload = z.infer<typeof updateAgentStatusPayloadSchema>;
export type UpdateAgentStatusIntent = IntentOf<typeof schemas>;
export type AgentStatusUpdatedWorkspaceRef = z.infer<typeof agentStatusUpdatedWorkspaceRefSchema>;
export type AgentStatusUpdatedPayload = z.infer<typeof agentStatusUpdatedPayloadSchema>;

export interface AgentStatusUpdatedEvent extends DomainEvent {
  readonly type: "agent:status-updated";
  readonly payload: AgentStatusUpdatedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class UpdateAgentStatusOperation implements Operation<typeof schemas> {
  readonly id = UPDATE_AGENT_STATUS_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<UpdateAgentStatusIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;

    // Resolve workspace + project, silently bail if unknown
    let projectPath: ProjectPath;
    let workspaceName: WorkspaceName;
    let projectId: ProjectId;
    let active: boolean;
    try {
      ({ projectPath, workspaceName, active } = await ctx.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      }));
      ({ projectId } = await ctx.dispatch<ResolveProjectIntent>({
        type: INTENT_RESOLVE_PROJECT,
        payload: { projectPath },
      }));
    } catch {
      return; // silently bail — unknown workspace/project
    }

    // Emit domain event with fully resolved context
    const event: AgentStatusUpdatedEvent = {
      type: EVENT_AGENT_STATUS_UPDATED,
      payload: {
        workspace: {
          path: payload.workspacePath,
          projectId,
          name: workspaceName,
          active,
        },
        status: payload.status,
      },
    };
    ctx.emit(event);
  }
}
