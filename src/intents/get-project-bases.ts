/**
 * GetProjectBasesOperation - Returns cached branch bases for a project.
 *
 * Two hook points:
 * 1. "list" — fast local read of cached bases + default base branch
 * 2. "refresh" — slow remote fetch (git fetch)
 *
 * Flow:
 * 1. Dispatch project:resolve to get projectId
 * 2. hooks.collect("list") → bases, defaultBaseBranch
 * 3. If refresh:
 *    - wait=false (default): fire-and-forget refresh → re-list → emit bases:updated
 *    - wait=true: await refresh → re-list → return fresh data (no event)
 * 4. Return cached bases (or fresh bases when wait=true)
 *
 * No provider dependencies — hook handlers do the actual work.
 *
 * Contract schemas (item 2): zod is the single source of truth; the Intent, result,
 * hook, and event payload types are derived from the `schemas` bundle.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { projectIdSchema, baseInfoSchema, hookCtxSchema } from "./contract";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors, mergeHookResults } from "./lib/hook-helpers";

export const INTENT_GET_PROJECT_BASES = "project:get-bases" as const;
export const EVENT_BASES_UPDATED = "bases:updated" as const;
export const GET_PROJECT_BASES_OPERATION_ID = "get-project-bases";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getProjectBasesPayloadSchema = z
  .object({
    projectPath: z.string(),
    refresh: z.boolean().optional(),
    /** When true (and refresh is true), await the refresh and return fresh data. */
    wait: z.boolean().optional(),
  })
  .readonly();

export const getProjectBasesResultSchema = z
  .object({
    bases: z.array(baseInfoSchema).readonly(),
    defaultBaseBranch: z.string().optional(),
    projectPath: z.string(),
    projectId: projectIdSchema,
  })
  .readonly();

export const basesUpdatedPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    projectPath: z.string(),
    bases: z.array(baseInfoSchema).readonly(),
    /** Fresh default base branch; absent when detection found none (authoritative). */
    defaultBaseBranch: z.string().optional(),
  })
  .readonly();

export const listBasesHookResultSchema = z
  .object({
    bases: z.array(baseInfoSchema).readonly().optional(),
    defaultBaseBranch: z.string().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "list" / "refresh" hook points. */
const listBasesEnrichmentSchema = z.object({ projectPath: z.string() });
const refreshBasesEnrichmentSchema = z.object({ projectPath: z.string() });

export const listBasesHookInputSchema = hookCtxSchema(
  getProjectBasesPayloadSchema,
  listBasesEnrichmentSchema.shape
);
export const refreshBasesHookInputSchema = hookCtxSchema(
  getProjectBasesPayloadSchema,
  refreshBasesEnrichmentSchema.shape
);

const schemas = {
  type: INTENT_GET_PROJECT_BASES,
  payload: getProjectBasesPayloadSchema,
  result: getProjectBasesResultSchema,
  hooks: {
    list: { input: listBasesHookInputSchema, result: listBasesHookResultSchema },
    refresh: { input: refreshBasesHookInputSchema },
  },
  events: {
    [EVENT_BASES_UPDATED]: basesUpdatedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetProjectBasesPayload = z.infer<typeof getProjectBasesPayloadSchema>;
export type GetProjectBasesResult = z.infer<typeof getProjectBasesResultSchema>;
export type GetProjectBasesIntent = IntentOf<typeof schemas>;
export type BasesUpdatedPayload = z.infer<typeof basesUpdatedPayloadSchema>;
export type ListBasesHookResult = z.infer<typeof listBasesHookResultSchema>;

/** Whole input context for "list" handlers: base envelope + inferred enrichment. */
export type ListBasesHookInput = HookContext & z.infer<typeof listBasesEnrichmentSchema>;
/** Whole input context for "refresh" handlers: base envelope + inferred enrichment. */
export type RefreshBasesHookInput = HookContext & z.infer<typeof refreshBasesEnrichmentSchema>;

export interface BasesUpdatedEvent extends DomainEvent {
  readonly type: "bases:updated";
  readonly payload: BasesUpdatedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class GetProjectBasesOperation implements Operation<typeof schemas> {
  readonly id = GET_PROJECT_BASES_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<GetProjectBasesIntent>): Promise<GetProjectBasesResult> {
    const { projectPath, refresh } = ctx.intent.payload;

    // 1. Dispatch project:resolve to get projectId
    const { projectId } = await ctx.dispatch({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    } as ResolveProjectIntent);

    // 2. Collect "list" hook — fast local read
    const listCtx: ListBasesHookInput = { intent: ctx.intent, projectPath };
    const { results: listResults, errors: listErrors } =
      await ctx.hooks.collect<ListBasesHookResult>("list", listCtx);

    throwHookErrors(listErrors, "project:get-bases list hooks failed");

    const listMerged = mergeHookResults(listResults, "list");
    const bases = listMerged.bases ?? [];
    const defaultBaseBranch = listMerged.defaultBaseBranch;

    // 3. Refresh if requested
    if (refresh) {
      const refreshAndRelist = async (): Promise<GetProjectBasesResult | undefined> => {
        const refreshCtx: RefreshBasesHookInput = { intent: ctx.intent, projectPath };
        const { errors: refreshErrors } = await ctx.hooks.collect("refresh", refreshCtx);
        if (refreshErrors.length > 0) return undefined;

        const { results: freshListResults } = await ctx.hooks.collect<ListBasesHookResult>(
          "list",
          listCtx
        );
        const freshMerged = mergeHookResults(freshListResults, "list");
        const freshBases = freshMerged.bases ?? [];
        return {
          bases: freshBases,
          ...(freshMerged.defaultBaseBranch !== undefined && {
            defaultBaseBranch: freshMerged.defaultBaseBranch,
          }),
          projectPath,
          projectId,
        };
      };

      if (ctx.intent.payload.wait) {
        // Await refresh and return fresh data; fall back to cached on error
        try {
          const freshResult = await refreshAndRelist();
          if (freshResult) return freshResult;
        } catch {
          // Refresh failed — fall through to return cached
        }
      } else {
        // Fire-and-forget: refresh in background, emit event with fresh data
        void (async () => {
          try {
            const freshResult = await refreshAndRelist();
            if (freshResult) {
              const freshEvent: BasesUpdatedEvent = {
                type: EVENT_BASES_UPDATED,
                payload: {
                  projectId,
                  projectPath,
                  bases: freshResult.bases,
                  ...(freshResult.defaultBaseBranch !== undefined && {
                    defaultBaseBranch: freshResult.defaultBaseBranch,
                  }),
                },
              };
              ctx.emit(freshEvent);
            }
          } catch {
            // Fire-and-forget: errors are silently swallowed
          }
        })();
      }
    }

    // 4. Return cached result
    return {
      bases,
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      projectPath,
      projectId,
    };
  }
}
