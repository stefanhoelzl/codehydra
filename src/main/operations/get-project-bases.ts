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
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetProjectBasesPayload {
  readonly projectPath: string;
  readonly refresh?: boolean;
  /** When true (and refresh is true), await the refresh and return fresh data. */
  readonly wait?: boolean;
}

export interface GetProjectBasesResult {
  readonly bases: readonly { name: string; isRemote: boolean }[];
  readonly defaultBaseBranch?: string;
  readonly projectPath: string;
  readonly projectId: ProjectId;
}

export interface GetProjectBasesIntent extends Intent<GetProjectBasesResult> {
  readonly type: "project:get-bases";
  readonly payload: GetProjectBasesPayload;
}

export const INTENT_GET_PROJECT_BASES = "project:get-bases" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface BasesUpdatedPayload {
  readonly projectId: ProjectId;
  readonly projectPath: string;
  readonly bases: readonly { name: string; isRemote: boolean }[];
}

export interface BasesUpdatedEvent extends DomainEvent {
  readonly type: "bases:updated";
  readonly payload: BasesUpdatedPayload;
}

export const EVENT_BASES_UPDATED = "bases:updated" as const;

// =============================================================================
// Hook Point Types
// =============================================================================

export interface ListBasesHookInput extends HookContext {
  readonly projectPath: string;
}

export interface ListBasesHookResult {
  readonly bases?: readonly { name: string; isRemote: boolean }[];
  readonly defaultBaseBranch?: string;
}

export interface RefreshBasesHookInput extends HookContext {
  readonly projectPath: string;
}

// =============================================================================
// Operation
// =============================================================================

export const GET_PROJECT_BASES_OPERATION_ID = "get-project-bases";

/** Merge hook results field-by-field. Throws if two handlers contribute the same field. */
function mergeHookResults<T extends object>(results: readonly T[], hookPoint: string): Partial<T> {
  const merged: Record<string, unknown> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined) {
        if (key in merged) {
          throw new Error(`${hookPoint} hook conflict: "${key}" provided by multiple handlers`);
        }
        merged[key] = value;
      }
    }
  }
  return merged as Partial<T>;
}

export class GetProjectBasesOperation implements Operation<
  GetProjectBasesIntent,
  GetProjectBasesResult
> {
  readonly id = GET_PROJECT_BASES_OPERATION_ID;

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

    if (listErrors.length > 0) throw listErrors[0]!;

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
                payload: { projectId, projectPath, bases: freshResult.bases },
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
