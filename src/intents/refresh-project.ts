/**
 * RefreshProjectOperation - Bring what a project's type knows up to date with
 * its upstream.
 *
 * For git that is a fetch: unmerged-commit counts, the branch list and the
 * default branch are then measured against current remote refs. A type with no
 * upstream answers nothing, and the refresh is a no-op.
 *
 * One hook point, "refresh", answered by the project's own type (each handler
 * selects itself on the project ref). A failing handler fails the dispatch;
 * callers treat a refresh as best-effort and fall back to what is cached.
 *
 * Flow:
 * 1. Dispatch project:resolve for the project's path
 * 2. hooks.collect("refresh")
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, projectPathSchema, projectRefSchema } from "./contract";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_REFRESH_PROJECT = "project:refresh" as const;
export const REFRESH_PROJECT_OPERATION_ID = "refresh-project";

export const refreshProjectPayloadSchema = z.object({ projectRef: projectRefSchema }).readonly();

/** Operation-added enrichment for the "refresh" hook point. */
const refreshEnrichmentSchema = z.object({
  projectRef: projectRefSchema,
  projectPath: projectPathSchema,
});
const refreshHookInputSchema = hookCtxSchema(
  refreshProjectPayloadSchema,
  refreshEnrichmentSchema.shape
);

export const schemas = {
  type: INTENT_REFRESH_PROJECT,
  payload: refreshProjectPayloadSchema,
  hooks: {
    refresh: { input: refreshHookInputSchema },
  },
} satisfies OperationSchemas;

export type RefreshProjectPayload = z.infer<typeof refreshProjectPayloadSchema>;
export type RefreshProjectIntent = IntentOf<typeof schemas>;
/** Whole input context for "refresh" handlers. */
export type RefreshProjectHookInput = HookContext & z.infer<typeof refreshEnrichmentSchema>;

export class RefreshProjectOperation implements Operation<typeof schemas> {
  readonly id = REFRESH_PROJECT_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<RefreshProjectIntent, typeof schemas>): Promise<void> {
    const { projectRef } = ctx.intent.payload;
    const { projectPath } = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectRef },
    });
    const refreshCtx: RefreshProjectHookInput = { intent: ctx.intent, projectRef, projectPath };
    const { errors } = await ctx.hooks.collect("refresh", refreshCtx);
    throwHookErrors(errors, "project:refresh refresh hooks failed");
  }
}
