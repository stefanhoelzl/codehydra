/**
 * ResolveProjectOperation - Shared project resolution.
 *
 * Centralizes the projectPath → (projectId, projectName) lookup
 * used by multiple operations. Each consuming operation dispatches this
 * intent instead of running its own resolve-project hook.
 *
 * Single hook point:
 * 1. "resolve" — collected from modules (e.g., localProjectModule)
 *
 * Throws if no handler returns projectId.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { projectIdSchema, hookCtxSchema } from "./contract";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_RESOLVE_PROJECT = "project:resolve" as const;
export const RESOLVE_PROJECT_OPERATION_ID = "resolve-project";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const resolveProjectPayloadSchema = z
  .object({
    projectPath: z.string(),
  })
  .readonly();

export const resolveProjectResultSchema = z
  .object({
    projectId: projectIdSchema,
    projectName: z.string(),
  })
  .readonly();

/** Per-handler result for "resolve" (fields optional — each handler contributes a subset). */
export const resolveHookResultSchema = z
  .object({
    projectId: projectIdSchema.optional(),
    projectName: z.string().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "resolve" hook point (beyond the base HookContext). */
const resolveEnrichmentSchema = z.object({ projectPath: z.string() });

/** Runtime whole-context validation schema for "resolve" (its inferred type isn't the ctx type). */
export const resolveHookInputSchema = hookCtxSchema(
  resolveProjectPayloadSchema,
  resolveEnrichmentSchema.shape
);

const schemas = {
  type: INTENT_RESOLVE_PROJECT,
  payload: resolveProjectPayloadSchema,
  result: resolveProjectResultSchema,
  hooks: {
    resolve: { input: resolveHookInputSchema, result: resolveHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ResolveProjectPayload = z.infer<typeof resolveProjectPayloadSchema>;
export type ResolveProjectResult = z.infer<typeof resolveProjectResultSchema>;
export type ResolveProjectIntent = IntentOf<typeof schemas>;
export type ResolveHookResult = z.infer<typeof resolveHookResultSchema>;

/** Whole input context for "resolve" handlers: base envelope + inferred enrichment. */
export type ResolveHookInput = HookContext & z.infer<typeof resolveEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class ResolveProjectOperation implements Operation<typeof schemas> {
  readonly id = RESOLVE_PROJECT_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<ResolveProjectIntent>): Promise<ResolveProjectResult> {
    const { payload } = ctx.intent;

    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath,
    };
    const { results, errors } = await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    throwHookErrors(errors, "project:resolve hooks failed");

    let projectId: ResolveProjectResult["projectId"] | undefined;
    let projectName: string | undefined;
    for (const r of results) {
      if (r.projectId !== undefined) projectId = r.projectId;
      if (r.projectName !== undefined) projectName = r.projectName;
    }

    if (!projectId) {
      throw new Error(`Project not found for path: ${payload.projectPath}`);
    }

    return { projectId, projectName: projectName ?? "" };
  }
}
