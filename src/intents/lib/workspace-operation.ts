/**
 * WorkspaceHookOperation — shared skeleton for workspace-scoped operations.
 *
 * Six operations (get-agent-session, get-metadata, restart-agent,
 * set-metadata, vscode-command, vscode-show-message) follow the same shape:
 *
 * 1. Resolve the workspaceRef through `resolveWorkspaceIdentity` — with the
 *    project when the operation emits an event (its payload carries the
 *    project's id), without it otherwise
 * 2. Run a single hook point with `{ intent, workspaceRef, workspacePath }` input
 * 3. Throw hook errors via the standard guard (lone error raw, multiple
 *    aggregated)
 * 4. Extract the operation result from the hook results
 * 5. Optionally emit a domain event built from the resolved identity
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
  resolveWorkspaceIdentity,
  type ResolvedWorkspace,
  type ResolvedWorkspaceIdentity,
} from "./workspace-identity";
import type { WorkspacePath, WorkspaceRef } from "../contract";
import type { HookPointOf, HookResultOf, InputOf, EventOf } from "./operation";

/** An intent whose payload carries the target workspace's ref. */
export type WorkspaceScopedIntent<R> = Intent<R> & {
  readonly payload: { readonly workspaceRef: WorkspaceRef };
};

/** Operation schemas whose payload carries the target workspace's ref. */
export type WorkspaceScopedSchemas = OperationSchemas & {
  readonly payload: z.ZodType<{ readonly workspaceRef: WorkspaceRef }>;
};

/** The resolved target a hook context carries. */
export interface WorkspaceTarget {
  readonly workspaceRef: WorkspaceRef;
  readonly workspacePath: WorkspacePath;
}

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
    target: WorkspaceTarget
  ) => InputOf<S, HookPointOf<S> & string>;
  /** AggregateError message when multiple handlers fail. */
  readonly errorLabel: string;
  /** Merge hook results into the operation result. May throw (missing required result). */
  readonly extract: (results: readonly WorkspaceHookResult<S>[]) => R;
  /**
   * Optional post-hook domain event. An operation that declares one resolves the
   * workspace together with its project, so `identity` carries the project's id.
   */
  readonly onSuccess?: (args: {
    readonly intent: I;
    readonly identity: ResolvedWorkspaceIdentity;
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
    const { workspaceRef } = ctx.intent.payload;
    const { onSuccess } = this.spec;

    // Resolve the workspace — together with its project only when an event
    // needs it — then run the hook point and emit the optional domain event.
    if (onSuccess) {
      const identity = await resolveWorkspaceIdentity(ctx.dispatch, workspaceRef);
      const result = await this.run(ctx, identity);
      ctx.emit(onSuccess({ intent: ctx.intent, identity, result }));
      return result;
    }
    const resolved = await resolveWorkspaceIdentity(ctx.dispatch, workspaceRef, {
      withProject: false,
    });
    return this.run(ctx, resolved);
  }

  /** Run the hook point — handlers do the actual work — and extract the result. */
  private async run(
    ctx: OperationContext<IntentOf<S>, S>,
    resolved: ResolvedWorkspace
  ): Promise<ResultOf<S>> {
    const hookCtx = this.spec.buildInput(ctx.intent, {
      workspaceRef: resolved.workspaceRef,
      workspacePath: resolved.workspacePath,
    });
    const { results, errors } = await ctx.hooks.collect(this.spec.hookPoint, hookCtx);
    throwHookErrors(errors, this.spec.errorLabel);
    return this.spec.extract(results);
  }
}
