/**
 * ResolveWorkspaceOperation - Shared workspace resolution.
 *
 * Turns a workspace's ref into the workspace: its path, its project, its name
 * and its state. Operations carry refs; this is where one becomes a path. Each
 * consuming operation dispatches this intent instead of running its own resolve
 * hook.
 *
 * A path is accepted too, for the edges that only know one — a shell's working
 * directory, an editor's folder. It matches the workspace containing it.
 *
 * Two hook points:
 * 1. "resolve" — the workspace's identity, from the module that owns the
 *    workspace (gitWorktreeWorkspaceModule)
 * 2. "state" — what other modules know about it (active, closing), with the
 *    identity resolved
 *
 * Throws WORKSPACE_NOT_FOUND if no handler identifies the workspace.
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
  projectRefSchema,
  workspaceClosingSchema,
  workspaceNameSchema,
  workspacePathSchema,
  workspaceRefSchema,
} from "./contract";
import type { WorkspaceClosing } from "./contract";
import { throwHookErrors } from "./lib/hook-helpers";
import { WorkspaceError } from "../shared/errors/service-errors";
import { Path } from "../utils/path/path";

export const INTENT_RESOLVE_WORKSPACE = "workspace:resolve" as const;
export const RESOLVE_WORKSPACE_OPERATION_ID = "resolve-workspace";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/** Exactly one of the two: the workspace's ref, or a path inside it. */
export const resolveWorkspacePayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema.optional(),
    workspacePath: workspacePathSchema.optional(),
  })
  .refine((p) => (p.workspaceRef === undefined) !== (p.workspacePath === undefined), {
    message: "workspace:resolve takes exactly one of workspaceRef and workspacePath",
  })
  .readonly();

/** A workspace's identity: the result of the "resolve" hook point. */
const workspaceIdentityShape = {
  workspaceRef: workspaceRefSchema,
  workspacePath: workspacePathSchema,
  projectRef: projectRefSchema,
  projectPath: projectPathSchema,
  workspaceName: workspaceNameSchema,
  /** Current branch name, or null for detached HEAD. */
  branch: z.string().nullable(),
  /** The workspace's raw domain metadata. Consumers interpret it (never store
   *  it raw) — see `readTitle`/`extractTags` in shared/api/types. */
  metadata: z.record(z.string(), z.string()).readonly(),
};

export const resolveWorkspaceResultSchema = z
  .object({
    ...workspaceIdentityShape,
    active: z.boolean(),
    /**
     * Why a teardown pipeline currently owns this workspace, or null when none
     * does. See `workspaceClosingSchema` in ./contract.
     *
     * This is a SNAPSHOT taken at resolve time, not a lock: a caller that
     * resolved before the teardown started still holds `null`. It is how the
     * state reaches consumers that act immediately; anything that acts later
     * (notably spawning a git subprocess in the workspace) must re-check at the
     * point of use instead.
     */
    closing: workspaceClosingSchema.nullable(),
  })
  .readonly();

/** Result of "resolve": the identity, from the one module that knows the workspace. */
export const resolveHookResultSchema = z.object(workspaceIdentityShape).partial().readonly();

/** Result of "state": what a module knows about the identified workspace. */
export const stateHookResultSchema = z
  .object({
    active: z.boolean().optional(),
    closing: workspaceClosingSchema.optional(),
  })
  .readonly();

/** Runtime whole-context validation schema for "resolve": the payload is all it gets. */
export const resolveHookInputSchema = hookCtxSchema(resolveWorkspacePayloadSchema, {});

/** Operation-added enrichment for "state": the resolved identity. */
const stateEnrichmentSchema = z.object({
  workspaceRef: workspaceRefSchema,
  workspacePath: workspacePathSchema,
});

/** Runtime whole-context validation schema for "state". */
export const stateHookInputSchema = hookCtxSchema(
  resolveWorkspacePayloadSchema,
  stateEnrichmentSchema.shape
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
    state: { input: stateHookInputSchema, result: stateHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ResolveWorkspacePayload = z.infer<typeof resolveWorkspacePayloadSchema>;
export type ResolveWorkspaceResult = z.infer<typeof resolveWorkspaceResultSchema>;
export type ResolveWorkspaceIntent = IntentOf<typeof schemas>;
export type ResolveHookResult = z.infer<typeof resolveHookResultSchema>;
export type StateHookResult = z.infer<typeof stateHookResultSchema>;

/** Whole input context for "resolve" handlers: the bare intent. */
export type ResolveHookInput = HookContext & { readonly intent: ResolveWorkspaceIntent };

/** Whole input context for "state" handlers: base envelope + the resolved identity. */
export type StateHookInput = HookContext & z.infer<typeof stateEnrichmentSchema>;

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

    const { results, errors } = await ctx.hooks.collect("resolve", { intent: ctx.intent });
    throwHookErrors(errors, "workspace:resolve hooks failed");

    // The identity comes whole from one module; the last complete one wins.
    let identity: z.infer<z.ZodObject<typeof workspaceIdentityShape>> | undefined;
    for (const r of results) {
      const parsed = z.object(workspaceIdentityShape).safeParse(r);
      if (parsed.success) identity = parsed.data;
    }

    if (!identity) {
      // Coded so callers can tell "you named a workspace that isn't there" apart
      // from a genuine failure — the MCP tools map it to `workspace-not-found`.
      // Same code and message the provider already uses for this condition.
      throw new WorkspaceError(
        `Workspace not found: ${payload.workspaceRef ?? payload.workspacePath ?? ""}`,
        "WORKSPACE_NOT_FOUND"
      );
    }

    const stateCtx: StateHookInput = {
      intent: ctx.intent,
      workspaceRef: identity.workspaceRef,
      workspacePath: identity.workspacePath,
    };
    const state = await ctx.hooks.collect("state", stateCtx);
    throwHookErrors(state.errors, "workspace:resolve state hooks failed");

    let active = false;
    let closing: WorkspaceClosing | null = null;
    for (const r of state.results) {
      if (r.active === true) active = true;
      if (r.closing !== undefined) closing = r.closing;
    }

    // The resolve step is where a workspace becomes a name: tag this dispatch,
    // and the operation that asked, with it.
    ctx.setLogTarget({
      project: new Path(identity.projectPath).basename,
      ws: identity.workspaceName,
      path: identity.workspacePath,
    });

    return { ...identity, active, closing };
  }
}
