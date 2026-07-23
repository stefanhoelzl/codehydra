/**
 * OpenWorkspaceOperation - Orchestrates workspace opening.
 *
 * Uses isolated hook contexts with collect() — each hook point returns typed
 * results that are merged field-by-field with conflict detection.
 *
 * Steps:
 * 1. Dispatch project:resolve to get projectId from projectPath
 * 2. "create" → CreateHookResult — worktree creation (fatal)
 *    "setup" → SetupHookResult — keepfiles (best-effort, internal try/catch),
 *     agent server (fatal)
 *    "finalize" → FinalizeHookResult — workspace URL (fatal)
 *
 * On success, builds a Workspace return value and emits a
 * workspace:created domain event.
 *
 * No provider dependencies - hook handlers do the actual work.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent`, result,
 * hook, and event types are **derived** from that bundle — never restated.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import type { ProjectPath, WorkspaceName } from "./contract";
import {
  agentSpecSchema,
  hookCtxSchema,
  projectIdSchema,
  projectPathSchema,
  workspaceNameSchema,
  workspacePathSchema,
  workspaceSchema,
} from "./contract";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { INTENT_GET_ACTIVE_WORKSPACE, type GetActiveWorkspaceIntent } from "./get-active-workspace";
import { throwHookErrors, mergeHookResults, lastDefined } from "./lib/hook-helpers";

export const INTENT_OPEN_WORKSPACE = "workspace:open" as const;
export const OPEN_WORKSPACE_OPERATION_ID = "open-workspace";

export const EVENT_WORKSPACE_CREATED = "workspace:created" as const;
export const EVENT_WORKSPACE_LOADING = "workspace:loading" as const;
export const EVENT_WORKSPACE_CREATE_FAILED = "workspace:create-failed" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/** Selected agent backend. Local schema (not in contract); mirrors plugin-protocol's AgentType. */
const agentTypeSchema = z.enum(["opencode", "claude"]);
type AgentType = z.infer<typeof agentTypeSchema>;

/** Identifies which module dispatched a workspace:open intent. */
export const workspaceOpenSourceSchema = z.enum([
  "ui-ipc",
  "mcp",
  "plugin-server",
  "auto-workspace",
  "open-project",
  "creation",
]);
export type WorkspaceOpenSource = z.infer<typeof workspaceOpenSourceSchema>;

/** Data for activating an existing (discovered) workspace via workspace:open */
export const existingWorkspaceDataSchema = z
  .object({
    path: workspacePathSchema,
    name: z.string(),
    branch: z.string().nullable(),
    metadata: z.record(z.string(), z.string()).readonly(),
  })
  .readonly();
export type ExistingWorkspaceData = z.infer<typeof existingWorkspaceDataSchema>;

export const openWorkspacePayloadSchema = z
  .object({
    workspaceName: z.string(),
    base: z.string().optional(),
    /** Remote branch to check out (e.g., 'origin/feature-login'). When set, the local branch
     *  is created at this ref with upstream configured, instead of forking from base. */
    tracking: z.string().optional(),
    /** If true, switch to the new workspace. If false, don't steal focus but still switch when
     *  no workspace is active. Default behavior (undefined): switch. */
    stealFocus: z.boolean().optional(),
    /** When set, skip worktree creation and populate context from existing workspace data. */
    existingWorkspace: existingWorkspaceDataSchema.optional(),
    /** Authoritative project path. */
    projectPath: projectPathSchema,
    /** Which module dispatched this intent. Used by error-notification to skip non-interactive sources. */
    source: workspaceOpenSourceSchema.optional(),
    /**
     * Agent spec: prompt + backend-specific launch config. When the `type` is
     * "claude"/"opencode" it also selects (and persists) the per-workspace
     * backend; "default" or omitted falls back to git metadata / global config.
     */
    agent: agentSpecSchema.optional(),
  })
  .readonly();

export const openWorkspaceResultSchema = workspaceSchema;

// =============================================================================
// Per-hook-point schemas
// =============================================================================

/** Operation-added enrichment for the "create" hook point (resolved project path). */
const createEnrichmentSchema = z.object({ projectPath: projectPathSchema });
const createInputSchema = hookCtxSchema(openWorkspacePayloadSchema, createEnrichmentSchema.shape);

/** Result from the "create" hook point. Fields optional — multiple handlers may each contribute a subset. */
export const createResultSchema = z
  .object({
    workspacePath: workspacePathSchema.optional(),
    branch: z.string().optional(),
    metadata: z.record(z.string(), z.string()).readonly().optional(),
    /** The resolved base branch (explicit or auto-detected). Used in the event payload. */
    resolvedBase: z.string().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "setup" hook point (merged create results). */
const setupEnrichmentSchema = z.object({
  workspacePath: workspacePathSchema,
  projectPath: projectPathSchema,
});
const setupInputSchema = hookCtxSchema(openWorkspacePayloadSchema, setupEnrichmentSchema.shape);

/** Result from the "setup" hook point. */
export const setupResultSchema = z
  .object({
    envVars: z.record(z.string(), z.string()).optional(),
    /** Selected agent backend, contributed by the active agent module.
     *  Operation-consumed (no sibling requires), so a result — not a capability. */
    agentType: agentTypeSchema.nullable().optional(),
    /** Metadata keys this handler wrote, folded into the create hook's snapshot
     *  so the workspace:created event carries them. See mergeMetadata. */
    metadata: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "finalize" hook point (create+setup results). */
const finalizeEnrichmentSchema = z.object({
  workspacePath: workspacePathSchema,
  envVars: z.record(z.string(), z.string()),
  agentType: agentTypeSchema.nullable(),
});
const finalizeInputSchema = hookCtxSchema(
  openWorkspacePayloadSchema,
  finalizeEnrichmentSchema.shape
);

/** Result from the "finalize" hook point. Fields optional — handlers contribute a subset
 *  (the IDE server is the only one producing a URL). */
export const finalizeResultSchema = z
  .object({
    workspaceUrl: z.string().optional(),
    /** Metadata keys this handler wrote — folded in like the setup contributions. */
    metadata: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly();

// =============================================================================
// Event payload schemas (events defined in this file)
// =============================================================================

const workspaceCreatedSchema = z
  .object({
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    workspacePath: workspacePathSchema,
    projectPath: projectPathSchema,
    branch: z.string(),
    base: z.string().optional(),
    tracking: z.string().optional(),
    metadata: z.record(z.string(), z.string()).readonly(),
    workspaceUrl: z.string(),
    agent: agentSpecSchema.optional(),
    stealFocus: z.boolean().optional(),
    /** True when re-activating a discovered workspace (not a fresh creation). */
    reopened: z.boolean().optional(),
    /** Which module dispatched the original intent. */
    source: workspaceOpenSourceSchema.optional(),
  })
  .readonly();

const workspaceLoadingSchema = z
  .object({
    workspaceName: z.string(),
    projectPath: projectPathSchema,
    /** The requested base branch (absent when auto-detected later). */
    base: z.string().optional(),
  })
  .readonly();

const workspaceCreateFailedSchema = z
  .object({
    workspaceName: z.string(),
    projectPath: projectPathSchema,
    error: z.string(),
    /** Which module dispatched the original intent. */
    source: workspaceOpenSourceSchema.optional(),
  })
  .readonly();

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: openWorkspacePayloadSchema,
  result: openWorkspaceResultSchema,
  hooks: {
    create: { input: createInputSchema, result: createResultSchema },
    setup: { input: setupInputSchema, result: setupResultSchema },
    finalize: { input: finalizeInputSchema, result: finalizeResultSchema },
  },
  events: {
    [EVENT_WORKSPACE_CREATED]: workspaceCreatedSchema,
    [EVENT_WORKSPACE_LOADING]: workspaceLoadingSchema,
    [EVENT_WORKSPACE_CREATE_FAILED]: workspaceCreateFailedSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type OpenWorkspacePayload = z.infer<typeof openWorkspacePayloadSchema>;
export type OpenWorkspaceResult = z.infer<typeof openWorkspaceResultSchema>;
export type OpenWorkspaceIntent = IntentOf<typeof schemas>;

export type CreateHookResult = z.infer<typeof createResultSchema>;
export type SetupHookResult = z.infer<typeof setupResultSchema>;
export type FinalizeHookResult = z.infer<typeof finalizeResultSchema>;

/** Input context for the "create" hook point (enriched with resolved project path). */
export type CreateHookInput = HookContext & z.infer<typeof createEnrichmentSchema>;
/** Input context for the "setup" hook point (enriched with merged create results). */
export type SetupHookInput = HookContext & z.infer<typeof setupEnrichmentSchema>;
/** Input context for the "finalize" hook point (enriched with create+setup results). */
export type FinalizeHookInput = HookContext & z.infer<typeof finalizeEnrichmentSchema>;

export type WorkspaceCreatedPayload = z.infer<typeof workspaceCreatedSchema>;
export type WorkspaceLoadingPayload = z.infer<typeof workspaceLoadingSchema>;
export type WorkspaceCreateFailedPayload = z.infer<typeof workspaceCreateFailedSchema>;

export interface WorkspaceCreatedEvent extends DomainEvent {
  readonly type: "workspace:created";
  readonly payload: WorkspaceCreatedPayload;
}

export interface WorkspaceLoadingEvent extends DomainEvent {
  readonly type: "workspace:loading";
  readonly payload: WorkspaceLoadingPayload;
}

export interface WorkspaceCreateFailedEvent extends DomainEvent {
  readonly type: "workspace:create-failed";
  readonly payload: WorkspaceCreateFailedPayload;
}

// =============================================================================
// Operation
// =============================================================================

/**
 * Folds a hook handler's metadata contribution into the accumulator, last write
 * winning per key. Unlike mergeHookResults' conflict-throw — right for fields like
 * workspacePath, where two providers means a bug — contributing disjoint metadata
 * keys is the intended use, so a duplicate key must not fail workspace creation.
 */
function mergeMetadata(
  target: Record<string, string>,
  contribution: Readonly<Record<string, string>> | undefined
): void {
  if (contribution) Object.assign(target, contribution);
}

export class OpenWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<OpenWorkspaceIntent, typeof schemas>
  ): Promise<OpenWorkspaceResult> {
    const { projectPath } = ctx.intent.payload;

    // Show loading dialog for foreground workspace creations.
    // project:open passes stealFocus=false to suppress this during silent
    // re-discovery on startup; the wake/reopen path leaves stealFocus
    // unset so users see a spinner while the agent restarts.
    const showLoading = ctx.intent.payload.stealFocus !== false;

    if (showLoading) {
      ctx.emit({
        type: EVENT_WORKSPACE_LOADING,
        payload: {
          workspaceName: ctx.intent.payload.workspaceName,
          projectPath,
          ...(ctx.intent.payload.base !== undefined && { base: ctx.intent.payload.base }),
        },
      } satisfies WorkspaceLoadingEvent);
    }

    try {
      return await this.executeWorkspaceOpen(ctx, projectPath);
    } catch (error) {
      ctx.emit({
        type: EVENT_WORKSPACE_CREATE_FAILED,
        payload: {
          workspaceName: ctx.intent.payload.workspaceName,
          projectPath,
          error: error instanceof Error ? error.message : String(error),
          ...(ctx.intent.payload.source !== undefined && { source: ctx.intent.payload.source }),
        },
      } satisfies WorkspaceCreateFailedEvent);
      throw error;
    }
  }

  private async executeWorkspaceOpen(
    ctx: OperationContext<OpenWorkspaceIntent, typeof schemas>,
    projectPath: ProjectPath
  ): Promise<OpenWorkspaceResult> {
    // Dispatch project:resolve to get projectId from projectPath
    const projResolved = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    });
    const resolvedProjectId = projResolved.projectId;

    // Hook: "create" — worktree creation (fatal on error)
    const createCtx: CreateHookInput = { intent: ctx.intent, projectPath };
    const { results: createResults, errors: createErrors } = await ctx.hooks.collect(
      "create",
      createCtx
    );

    throwHookErrors(createErrors, "workspace:open create hooks failed");

    const create = mergeHookResults(createResults, "create");
    const { workspacePath, branch, metadata, resolvedBase } = create;
    if (workspacePath === undefined || branch === undefined || metadata === undefined) {
      throw new Error("Create hook did not provide all required fields");
    }

    // Metadata written by later hook points folds into the create snapshot, so the
    // workspace:created event (and the returned Workspace) carry it. Without this a
    // setup/finalize write would only surface after a restart re-read git config:
    // its workspace:metadata-changed event lands before the row exists and the
    // presenter drops it (presentation-module.ts, EVENT_METADATA_CHANGED).
    const mergedMetadata: Record<string, string> = { ...metadata };

    // Hook 3b: "setup" — keepfiles is best-effort (internal try/catch), agent is fatal
    const setupCtx: SetupHookInput = {
      intent: ctx.intent,
      workspacePath,
      projectPath,
    };
    const setupResult = await ctx.hooks.collect("setup", setupCtx);

    throwHookErrors(setupResult.errors, "workspace:open setup hooks failed");

    // Accumulate env vars and read agentType from setup hook results. Multiple
    // modules can contribute env vars; the active agent module contributes agentType
    // (a result, not a capability — nothing in the hook point requires it).
    const envVars: Record<string, string> = {};
    let agentType: AgentType | null = null;
    for (const result of setupResult.results) {
      if (result.envVars) {
        Object.assign(envVars, result.envVars);
      }
      if (result.agentType != null) {
        agentType = result.agentType;
      }
      mergeMetadata(mergedMetadata, result.metadata);
    }

    // Hook 3c: "finalize" — workspace URL (fatal on error)
    const finalizeCtx: FinalizeHookInput = {
      intent: ctx.intent,
      workspacePath,
      envVars,
      agentType,
    };
    const { errors: finalizeErrors, results: finalizeResults } = await ctx.hooks.collect(
      "finalize",
      finalizeCtx
    );

    throwHookErrors(finalizeErrors, "workspace:open finalize hooks failed");

    for (const result of finalizeResults) {
      mergeMetadata(mergedMetadata, result.metadata);
    }

    // Only the IDE server contributes a workspace URL; other finalize handlers
    // contribute metadata or nothing at all.
    const workspaceUrl = lastDefined(finalizeResults, (result) => result.workspaceUrl);
    if (!workspaceUrl) {
      throw new Error("Finalize hook did not provide workspaceUrl");
    }

    // Build Workspace return value. The name comes from the payload, NOT from
    // the basename of workspacePath: the hook returns a normalized Path
    // string, which is lowercased on Windows and would break the renderer's
    // case-sensitive name matching (loading event vs created event).
    const resolvedWorkspaceName = (ctx.intent.payload.existingWorkspace?.name ??
      ctx.intent.payload.workspaceName) as WorkspaceName;
    const projectId = resolvedProjectId;

    const workspace: OpenWorkspaceResult = {
      projectId,
      name: resolvedWorkspaceName,
      branch,
      metadata: mergedMetadata,
      path: workspacePath,
      url: workspaceUrl,
    };

    // Build and emit domain event
    const eventBase = resolvedBase ?? ctx.intent.payload.base;
    const eventPayload: WorkspaceCreatedPayload = {
      projectId,
      workspaceName: resolvedWorkspaceName,
      workspacePath,
      projectPath,
      branch,
      ...(eventBase !== undefined && { base: eventBase }),
      ...(ctx.intent.payload.tracking !== undefined && { tracking: ctx.intent.payload.tracking }),
      metadata: mergedMetadata,
      workspaceUrl,
      ...(ctx.intent.payload.agent !== undefined && {
        agent: ctx.intent.payload.agent,
      }),
      ...(ctx.intent.payload.stealFocus !== undefined && {
        stealFocus: ctx.intent.payload.stealFocus,
      }),
      ...(ctx.intent.payload.existingWorkspace !== undefined && { reopened: true }),
      ...(ctx.intent.payload.source !== undefined && { source: ctx.intent.payload.source }),
    };

    const event: WorkspaceCreatedEvent = {
      type: EVENT_WORKSPACE_CREATED,
      payload: eventPayload,
    };
    ctx.emit(event);

    // Switch to new workspace unless stealFocus is false with an existing active workspace.
    // When stealFocus is false but no workspace is active, still switch so the user
    // sees the new workspace rather than an empty view.
    let shouldSwitch: boolean;
    if (ctx.intent.payload.stealFocus !== false) {
      shouldSwitch = true;
    } else {
      const activeWorkspace = await ctx.dispatch<GetActiveWorkspaceIntent>({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {},
      });
      shouldSwitch = activeWorkspace === null;
    }

    if (shouldSwitch) {
      await ctx.dispatch<SwitchWorkspaceIntent>({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath, focus: true },
      });
    }

    return workspace;
  }
}
