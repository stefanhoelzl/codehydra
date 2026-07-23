/**
 * Factory for creating minimal test operations.
 *
 * Replaces boilerplate Minimal*Operation classes in module integration tests.
 * Each created operation calls a single hook point via `ctx.hooks.collect()`,
 * optionally throws the first error, and returns the first result.
 *
 * Since operations are parameterized by their schema bundle (`Operation<S>`), a minimal
 * operation carries a permissive schema (`z.unknown()` for payload and result) so the
 * dispatcher's validation is a no-op for it. `intentType` becomes the operation's
 * `schemas.type` — the dispatcher registration key.
 *
 * The result schema is `z.unknown()` rather than `z.custom<TResult>()`. Both accept anything,
 * but only one of them says so: `z.custom<T>()` runs no validator at all, so it reads like a
 * typed schema while behaving as an assertion — the pattern the intent contract now bans. It
 * was never buying the typing it appeared to, either. A dispatched result is typed by the
 * *intent's* phantom carrier, not by the registered operation's schema (the dispatcher erases
 * it at `registerOperation`), and `execute` already narrows to `TResult` on its way out. So
 * `TResult` stays as a parameter for `defaultResult` and the return type, and the schema
 * honestly declares that this test double validates nothing.
 */

import { z } from "zod/v4";
import type { Intent } from "./types";
import type { Operation, OperationContext, HookContext, OperationSchemas } from "./operation";
import { DELETE_WORKSPACE_OPERATION_ID, INTENT_DELETE_WORKSPACE } from "../delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../delete-workspace";
import type { ProjectId, ProjectPath, WorkspaceName } from "../contract";
import { projectPathSchema } from "../contract";

/** Options for `createMinimalOperation`. */
export interface MinimalOperationOptions<TResult = void> {
  /** Whether to throw `errors[0]` when the hook returns errors. Default: `true`. */
  throwOnError?: boolean;
  /** Custom hook context builder. Default: `{ intent: ctx.intent }`. */
  hookContext?: (ctx: OperationContext<Intent>) => HookContext;
  /** Fallback returned when the hook produced no result (`results[0] ?? defaultResult`). */
  defaultResult?: TResult;
}

/** The permissive schema shape a minimal test operation carries. */
type MinimalSchemas = {
  readonly type: string;
  readonly payload: z.ZodUnknown;
  readonly result: z.ZodUnknown;
};

/**
 * Create a minimal test operation that collects a single hook point.
 *
 * Behavior:
 * 1. Calls `ctx.hooks.collect(hookPoint, hookContext)`
 * 2. If `throwOnError !== false` and `errors.length > 0`: throws `errors[0]`
 * 3. Returns `results[0] ?? defaultResult`
 *
 * @param operationId hook-point owner id (what modules register handlers against)
 * @param intentType  intent type — the dispatcher registration key (`schemas.type`)
 * @param hookPoint   the single hook point to collect
 *
 * @example
 * const op = createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start");
 * const op = createMinimalOperation<GetStatusHookResult | undefined>(
 *   GET_WORKSPACE_STATUS_OPERATION_ID, INTENT_GET_WORKSPACE_STATUS, "get",
 *   { hookContext: (ctx) => ({ intent: ctx.intent, workspacePath: "/test/workspace" }) },
 * );
 */
export function createMinimalOperation<TResult = void>(
  operationId: string,
  intentType: string,
  hookPoint: string,
  options?: MinimalOperationOptions<TResult>
): Operation<MinimalSchemas> {
  const schemas = {
    type: intentType,
    payload: z.unknown(),
    result: z.unknown(),
  } satisfies OperationSchemas;
  const throwOnError = options?.throwOnError !== false;
  const buildHookContext = options?.hookContext;

  const op: Operation<typeof schemas> = {
    id: operationId,
    schemas,
    async execute(ctx) {
      const hookCtx = buildHookContext
        ? buildHookContext(ctx)
        : { intent: ctx.intent, capabilities: {} };
      const { results, errors } = await ctx.hooks.collect(hookPoint, hookCtx);
      if (throwOnError && errors.length > 0) throw errors[0]!;
      return (results[0] ?? options?.defaultResult) as TResult;
    },
  };
  return op;
}

/** Canned event fields for `createDeleteEventOperation`. */
export interface DeleteEventOperationFields {
  readonly projectId?: ProjectId;
  readonly workspaceName?: WorkspaceName;
  readonly projectPath?: ProjectPath;
}

// This one's result is trivially expressible, so it is a real schema rather than a
// permissive one — there was never a reason for it to opt out of validation.
const deleteEventSchemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: z.unknown(),
  result: z.object({ started: z.literal(true) }).readonly(),
} satisfies OperationSchemas;

/**
 * Minimal delete-workspace operation that only emits EVENT_WORKSPACE_DELETED,
 * so tests can trigger workspace:deleted through the public dispatcher API
 * without the full DeleteWorkspaceOperation pipeline.
 */
export function createDeleteEventOperation(
  fields: DeleteEventOperationFields = {}
): Operation<typeof deleteEventSchemas> {
  return {
    id: DELETE_WORKSPACE_OPERATION_ID,
    schemas: deleteEventSchemas,
    async execute(ctx): Promise<{ started: true }> {
      const intent = ctx.intent as DeleteWorkspaceIntent;
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: fields.projectId ?? ("test-12345678" as ProjectId),
          workspaceName: fields.workspaceName ?? ("ws" as WorkspaceName),
          workspacePath: intent.payload.workspacePath,
          worktreeRemoved: intent.payload.removeWorktree,
          projectPath: fields.projectPath ?? projectPathSchema.parse("/projects/test"),
        },
      };
      ctx.emit(event);
      return { started: true };
    },
  };
}
