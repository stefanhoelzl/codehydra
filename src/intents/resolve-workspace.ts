/**
 * ResolveWorkspaceOperation - Shared workspace resolution.
 *
 * Centralizes the workspacePath → (projectPath, workspaceName) lookup
 * used by multiple operations. Each consuming operation dispatches this
 * intent instead of running its own resolve hook.
 *
 * Single hook point:
 * 1. "resolve" — collected from modules (e.g., gitWorktreeWorkspaceModule)
 *
 * Throws if no handler returns projectPath or workspaceName.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  hookCtxSchema,
  projectPathSchema,
  workspaceNameSchema,
  workspacePathSchema,
} from "./contract";
import type { ProjectPath } from "./contract";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_RESOLVE_WORKSPACE = "workspace:resolve" as const;
export const RESOLVE_WORKSPACE_OPERATION_ID = "resolve-workspace";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const resolveWorkspacePayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
  })
  .readonly();

export const resolveWorkspaceResultSchema = z
  .object({
    projectPath: projectPathSchema,
    workspaceName: workspaceNameSchema,
    active: z.boolean(),
    /** Current branch name, or null for detached HEAD. */
    branch: z.string().nullable(),
    /** The workspace's raw domain metadata. Consumers interpret it (never store
     *  it raw) — see `readTitle`/`extractTags` in shared/api/types. */
    metadata: z.record(z.string(), z.string()).readonly(),
  })
  .readonly();

/** Per-handler result for "resolve" (fields optional — each handler contributes a subset). */
export const resolveHookResultSchema = z
  .object({
    projectPath: projectPathSchema.optional(),
    workspaceName: workspaceNameSchema.optional(),
    active: z.boolean().optional(),
    branch: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "resolve" hook point (beyond the base HookContext). */
const resolveEnrichmentSchema = z.object({ workspacePath: workspacePathSchema });

/** Runtime whole-context validation schema for "resolve" (its inferred type isn't the ctx type). */
export const resolveHookInputSchema = hookCtxSchema(
  resolveWorkspacePayloadSchema,
  resolveEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_RESOLVE_WORKSPACE,
  payload: resolveWorkspacePayloadSchema,
  result: resolveWorkspaceResultSchema,
  hooks: {
    resolve: { input: resolveHookInputSchema, result: resolveHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ResolveWorkspacePayload = z.infer<typeof resolveWorkspacePayloadSchema>;
export type ResolveWorkspaceResult = z.infer<typeof resolveWorkspaceResultSchema>;
export type ResolveWorkspaceIntent = IntentOf<typeof schemas>;
export type ResolveHookResult = z.infer<typeof resolveHookResultSchema>;

/** Whole input context for "resolve" handlers: base envelope + inferred enrichment. */
export type ResolveHookInput = HookContext & z.infer<typeof resolveEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class ResolveWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = RESOLVE_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<ResolveWorkspaceIntent, typeof schemas>
  ): Promise<ResolveWorkspaceResult> {
    const { payload } = ctx.intent;

    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect("resolve", resolveCtx);
    throwHookErrors(errors, "workspace:resolve hooks failed");

    let projectPath: ProjectPath | undefined;
    let workspaceName: ResolveWorkspaceResult["workspaceName"] | undefined;
    let active = false;
    // branch can legitimately be null (detached HEAD), so track "provided"
    // separately from the null value.
    let branch: string | null = null;
    let metadata: Readonly<Record<string, string>> = {};
    for (const r of results) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
      if (r.workspaceName !== undefined) workspaceName = r.workspaceName;
      if (r.active === true) active = true;
      if (r.branch !== undefined) branch = r.branch;
      if (r.metadata !== undefined) metadata = r.metadata;
    }

    if (!projectPath || !workspaceName) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    return { projectPath, workspaceName, active, branch, metadata };
  }
}
