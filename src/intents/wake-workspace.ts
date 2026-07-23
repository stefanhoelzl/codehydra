/**
 * WakeWorkspaceOperation - Wakes a hibernated workspace and brings it online.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — workspacePath → projectPath + workspaceName + branch
 * 2. Dispatch project:resolve — projectPath → projectId
 * 3. Dispatch workspace:set-metadata — clear `hibernated` metadata (emits
 *    workspace:metadata-changed, which clears the renderer overlay)
 * 4. "cleanup" hook — delete the on-disk screenshot file (best-effort)
 * 5. Dispatch workspace:get-metadata — read back the now-clean metadata
 * 6. Dispatch workspace:open (existingWorkspace branch) — re-run the canonical
 *    open pipeline against the already-existing worktree to restart the agent
 *    server, rebuild the workspace URL, and emit workspace:created (which mounts
 *    the view). stealFocus/source are forwarded so callers control focus and
 *    error-notification behavior, exactly like workspace_create.
 * 7. Emit workspace:woken (releases the per-workspace wake idempotency lock)
 *
 * Returns the reopened Workspace. The metadata-changed event (step 3) is
 * emitted before workspace:created (step 6), so the overlay clears before the
 * new view appears.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  hookCtxSchema,
  projectIdSchema,
  projectPathSchema,
  workspaceNameSchema,
  workspacePathSchema,
  workspaceSchema,
} from "./contract";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "./set-metadata";
import { INTENT_GET_METADATA, type GetMetadataIntent } from "./get-metadata";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "./open-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { resolveWorkspaceIdentity, workspaceFailurePayload } from "./lib/workspace-identity";

export const INTENT_WAKE_WORKSPACE = "workspace:wake" as const;
export const WAKE_WORKSPACE_OPERATION_ID = "wake-workspace";
export const EVENT_WORKSPACE_WOKEN = "workspace:woken" as const;
export const EVENT_WORKSPACE_WAKE_FAILED = "workspace:wake-failed" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/**
 * Which module dispatched a workspace:open intent. Local mirror of
 * `WorkspaceOpenSource` from ./open-workspace (that module has no exported
 * schema yet); kept in sync so wake can forward `source` to workspace:open.
 */
const workspaceOpenSourceSchema = z.enum([
  "ui-ipc",
  "mcp",
  "plugin-server",
  "auto-workspace",
  "open-project",
  "creation",
]);

export const wakeWorkspacePayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
    /** Forwarded to the internal workspace:open. If true, switch to the woken
     *  workspace; if false, bring it online in the background. Default
     *  (undefined): switch — matching the pre-fold renderer behavior. */
    stealFocus: z.boolean().optional(),
    /** Forwarded to the internal workspace:open. Identifies the originating
     *  surface so error-notification can skip non-interactive sources (e.g. mcp). */
    source: workspaceOpenSourceSchema.optional(),
  })
  .readonly();

export const workspaceWokenPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    workspacePath: workspacePathSchema,
    projectPath: projectPathSchema,
  })
  .readonly();

export const workspaceWakeFailedPayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
    error: z.string(),
  })
  .readonly();

/** Operation-added enrichment for the "cleanup" hook point. */
const wakePipelineEnrichmentSchema = z.object({
  projectPath: projectPathSchema,
  workspacePath: workspacePathSchema,
  projectId: projectIdSchema,
  workspaceName: workspaceNameSchema,
});

/** Runtime whole-context validation schema for the "cleanup" hook point. */
export const wakePipelineHookInputSchema = hookCtxSchema(
  wakeWorkspacePayloadSchema,
  wakePipelineEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_WAKE_WORKSPACE,
  payload: wakeWorkspacePayloadSchema,
  result: workspaceSchema,
  hooks: {
    cleanup: { input: wakePipelineHookInputSchema, result: z.object({}).readonly() },
  },
  events: {
    [EVENT_WORKSPACE_WOKEN]: workspaceWokenPayloadSchema,
    [EVENT_WORKSPACE_WAKE_FAILED]: workspaceWakeFailedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type WakeWorkspacePayload = z.infer<typeof wakeWorkspacePayloadSchema>;
export type WakeWorkspaceIntent = IntentOf<typeof schemas>;

export type WorkspaceWokenPayload = z.infer<typeof workspaceWokenPayloadSchema>;

export interface WorkspaceWokenEvent extends DomainEvent {
  readonly type: "workspace:woken";
  readonly payload: WorkspaceWokenPayload;
}

export type WorkspaceWakeFailedPayload = z.infer<typeof workspaceWakeFailedPayloadSchema>;

export interface WorkspaceWakeFailedEvent extends DomainEvent {
  readonly type: "workspace:wake-failed";
  readonly payload: WorkspaceWakeFailedPayload;
}

/** Input context for the "cleanup" hook point. */
export type WakePipelineHookInput = HookContext & z.infer<typeof wakePipelineEnrichmentSchema>;

export type CleanupHookResult = Record<string, never>;

// =============================================================================
// Operation
// =============================================================================

export class WakeWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = WAKE_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<WakeWorkspaceIntent, typeof schemas>
  ): Promise<z.infer<typeof workspaceSchema>> {
    const { payload } = ctx.intent;

    try {
      const { projectPath, workspaceName, projectId, branch } = await resolveWorkspaceIdentity(
        ctx.dispatch,
        payload.workspacePath
      );

      // Clear the hibernated metadata flag before re-init so any consumers
      // observing the metadata-changed event see the workspace as awake.
      await ctx.dispatch<SetMetadataIntent>({
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
          key: HIBERNATED_METADATA_KEY,
          value: null,
        },
      });

      const hookCtx: WakePipelineHookInput = {
        intent: ctx.intent,
        projectPath,
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
      };

      // Best-effort screenshot file cleanup.
      await ctx.hooks.collect("cleanup", hookCtx);

      // Read back the now-clean metadata (hibernated flag removed above) so the
      // reopen — and the workspace:created event it emits — carry accurate
      // metadata rather than reintroducing the stale flag.
      const metadata = await ctx.dispatch<GetMetadataIntent>({
        type: INTENT_GET_METADATA,
        payload: { workspacePath: payload.workspacePath },
      });

      // Re-run the canonical open pipeline against the existing worktree to
      // bring the workspace back online (agent server, workspace URL, view).
      const workspace = await ctx.dispatch<OpenWorkspaceIntent>({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectPath,
          workspaceName,
          existingWorkspace: {
            path: payload.workspacePath,
            name: workspaceName,
            branch,
            metadata,
          },
          ...(payload.stealFocus !== undefined && { stealFocus: payload.stealFocus }),
          ...(payload.source !== undefined && { source: payload.source }),
        },
      });

      const event: WorkspaceWokenEvent = {
        type: EVENT_WORKSPACE_WOKEN,
        payload: {
          projectId,
          workspaceName,
          workspacePath: payload.workspacePath,
          projectPath,
        },
      };
      ctx.emit(event);

      return workspace;
    } catch (error) {
      ctx.emit({
        type: EVENT_WORKSPACE_WAKE_FAILED,
        payload: workspaceFailurePayload(payload.workspacePath, error),
      });
      throw error;
    }
  }
}
