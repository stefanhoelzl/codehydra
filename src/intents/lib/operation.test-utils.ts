/**
 * Factory for creating minimal test operations.
 *
 * Replaces boilerplate Minimal*Operation classes in module integration tests.
 * Each created operation calls a single hook point via `ctx.hooks.collect()`,
 * optionally throws the first error, and returns the first result.
 */

import type { Intent } from "./types";
import type { Operation, OperationContext, HookContext } from "./operation";
import { DELETE_WORKSPACE_OPERATION_ID, EVENT_WORKSPACE_DELETED } from "../delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../delete-workspace";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

/**
 * Options for `createMinimalOperation`.
 *
 * @template TIntent - The intent type the operation handles.
 */
export interface MinimalOperationOptions<TIntent extends Intent, TResult = void> {
  /** Whether to throw `errors[0]` when the hook returns errors. Default: `true`. */
  throwOnError?: boolean;
  /** Custom hook context builder. Default: `{ intent: ctx.intent }`. */
  hookContext?: (ctx: OperationContext<TIntent>) => HookContext;
  /** Fallback returned when the hook produced no result (`results[0] ?? defaultResult`). */
  defaultResult?: TResult;
}

/**
 * Create a minimal test operation that collects a single hook point.
 *
 * Behavior:
 * 1. Calls `ctx.hooks.collect<TResult>(hookPoint, hookContext)`
 * 2. If `throwOnError !== false` and `errors.length > 0`: throws `errors[0]`
 * 3. Returns `results[0] as TResult`
 *
 * @example
 * // Simple void operation
 * const op = createMinimalOperation(APP_START_OPERATION_ID, "start");
 *
 * // No-throw (shutdown/stop)
 * const op = createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false });
 *
 * // Custom hook context
 * const op = createMinimalOperation<Intent, GetStatusHookResult | undefined>(
 *   GET_WORKSPACE_STATUS_OPERATION_ID, "get",
 *   { hookContext: (ctx) => ({ intent: ctx.intent, workspacePath: "/test/workspace" }) },
 * );
 */
export function createMinimalOperation<TIntent extends Intent = Intent, TResult = void>(
  operationId: string,
  hookPoint: string,
  options?: MinimalOperationOptions<TIntent, TResult>
): Operation<TIntent, TResult> {
  const throwOnError = options?.throwOnError !== false;
  const buildHookContext = options?.hookContext;

  return {
    id: operationId,
    async execute(ctx: OperationContext<TIntent>): Promise<TResult> {
      const hookCtx = buildHookContext
        ? buildHookContext(ctx)
        : { intent: ctx.intent, capabilities: {} };
      const { results, errors } = await ctx.hooks.collect<TResult>(hookPoint, hookCtx);
      if (throwOnError && errors.length > 0) throw errors[0]!;
      return (results[0] ?? options?.defaultResult) as TResult;
    },
  };
}

/** Canned event fields for `createDeleteEventOperation`. */
export interface DeleteEventOperationFields {
  readonly projectId?: ProjectId;
  readonly workspaceName?: WorkspaceName;
  readonly projectPath?: string;
}

/**
 * Minimal delete-workspace operation that only emits EVENT_WORKSPACE_DELETED,
 * so tests can trigger workspace:deleted through the public dispatcher API
 * without the full DeleteWorkspaceOperation pipeline. The workspacePath comes
 * from the intent; the remaining event fields are canned (overridable).
 */
export function createDeleteEventOperation(
  fields: DeleteEventOperationFields = {}
): Operation<DeleteWorkspaceIntent, { started: true }> {
  return {
    id: DELETE_WORKSPACE_OPERATION_ID,
    async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: fields.projectId ?? ("test-12345678" as ProjectId),
          workspaceName: fields.workspaceName ?? ("ws" as WorkspaceName),
          workspacePath: ctx.intent.payload.workspacePath,
          projectPath: fields.projectPath ?? "/projects/test",
        },
      };
      ctx.emit(event);
      return { started: true };
    },
  };
}
