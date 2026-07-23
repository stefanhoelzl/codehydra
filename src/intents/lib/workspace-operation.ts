/**
 * WorkspaceHookOperation — shared skeleton for workspace-scoped operations.
 *
 * Six operations (get-agent-session, get-metadata, restart-agent,
 * set-metadata, vscode-command, vscode-show-message) follow the same shape:
 *
 * 1. Dispatch workspace:resolve to validate workspacePath (and obtain
 *    workspaceName for event payloads)
 * 2. Optionally dispatch project:resolve (only needed when a post-hook
 *    domain event wants projectId)
 * 3. Run a single hook point with `{ intent, workspacePath }` input
 * 4. Throw hook errors via the standard guard (lone error raw, multiple
 *    aggregated)
 * 5. Extract the operation result from the hook results
 * 6. Optionally emit a domain event built from the resolved identity
 *
 * Concrete operations subclass this with a spec — they keep their exported
 * class names so registration in main.ts and tests is unchanged.
 */

import type { z } from "zod/v4";
import type { Intent } from "./types";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
  ResultOf,
} from "./operation";
import { throwHookErrors } from "./hook-helpers";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
  type ResolveWorkspaceResult,
} from "../resolve-workspace";
import {
  INTENT_RESOLVE_PROJECT,
  type ResolveProjectIntent,
  type ResolveProjectResult,
} from "../resolve-project";
import type { WorkspacePath } from "../contract";
import type { HookPointOf, HookResultOf, InputOf, EventOf } from "./operation";

/** An intent whose payload carries the target workspace path. */
export type WorkspaceScopedIntent<R> = Intent<R> & {
  readonly payload: { readonly workspacePath: WorkspacePath };
};

/** Operation schemas whose payload carries the target workspace path. */
export type WorkspaceScopedSchemas = OperationSchemas & {
  readonly payload: z.ZodType<{ readonly workspacePath: WorkspacePath }>;
};

/**
 * The per-handler result type of the single hook point these operations collect.
 *
 * Derived from the bundle rather than supplied as a type parameter: every
 * `WorkspaceHookOperation` declares exactly one hook point, so `HookPointOf<S>` is a single
 * literal and this resolves to that hook point's `result` schema.
 */
export type WorkspaceHookResult<S extends WorkspaceScopedSchemas> = HookResultOf<S, HookPointOf<S>>;

export interface WorkspaceHookSpec<
  S extends WorkspaceScopedSchemas,
  I extends WorkspaceScopedIntent<R>,
  R,
> {
  /** Hook point to collect — must be one this operation's bundle declares. */
  readonly hookPoint: HookPointOf<S> & string;
  /**
   * Build the hook input context.
   *
   * Supplied by the subclass rather than built here because only the subclass knows the
   * concrete schema bundle: inside this generic base `InputOf<S, …>` is unresolved, so a
   * context built here could only be forced into place with an assertion. At the call site
   * `S` is a literal bundle and the returned object is checked against the hook point's
   * declared `input` schema.
   */
  readonly buildInput: (
    intent: IntentOf<S>,
    workspacePath: WorkspacePath
  ) => InputOf<S, HookPointOf<S> & string>;
  /** Also dispatch project:resolve — needed only when onSuccess wants projectId. */
  readonly resolveProject?: boolean;
  /** AggregateError message when multiple handlers fail. */
  readonly errorLabel: string;
  /** Merge hook results into the operation result. May throw (missing required result). */
  readonly extract: (results: readonly WorkspaceHookResult<S>[]) => R;
  /** Optional post-hook domain event. `project` is set iff `resolveProject` is true. */
  readonly onSuccess?: (args: {
    readonly intent: I;
    readonly resolved: ResolveWorkspaceResult;
    readonly project: ResolveProjectResult | undefined;
    readonly result: R;
  }) => EventOf<S>;
}

export abstract class WorkspaceHookOperation<
  S extends WorkspaceScopedSchemas,
> implements Operation<S> {
  abstract readonly schemas: S;

  protected constructor(
    readonly id: string,
    private readonly spec: WorkspaceHookSpec<S, IntentOf<S>, ResultOf<S>>
  ) {}

  async execute(ctx: OperationContext<IntentOf<S>, S>): Promise<ResultOf<S>> {
    const { workspacePath } = ctx.intent.payload;

    // 1. Dispatch shared workspace resolution
    const resolved = await ctx.dispatch<ResolveWorkspaceIntent>({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath },
    });

    // 2. Dispatch shared project resolution (event payloads only)
    const project = this.spec.resolveProject
      ? await ctx.dispatch<ResolveProjectIntent>({
          type: INTENT_RESOLVE_PROJECT,
          payload: { projectPath: resolved.projectPath },
        })
      : undefined;

    // 3. Run the hook point — handlers do the actual work
    const hookCtx = this.spec.buildInput(ctx.intent, workspacePath);
    const { results, errors } = await ctx.hooks.collect(this.spec.hookPoint, hookCtx);
    throwHookErrors(errors, this.spec.errorLabel);

    // 4. Extract result and emit optional domain event
    const result = this.spec.extract(results);
    if (this.spec.onSuccess) {
      ctx.emit(this.spec.onSuccess({ intent: ctx.intent, resolved, project, result }));
    }
    return result;
  }
}
