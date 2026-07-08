/**
 * AgentLaunchOptionsOperation - Query the per-backend launch options shown in
 * the creation form (Claude permission modes; OpenCode currently none).
 *
 * Trivial query operation: no workspace, no domain events. The agent modules
 * fill in the options via the "launch-options" hook point — only the module
 * whose provider type matches the requested backend contributes. Detection is
 * best-effort: a provider that fails to report contributes nothing, so the form
 * falls back to offering only the default.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema } from "./contract";

export const INTENT_GET_LAUNCH_OPTIONS = "agent:get-launch-options" as const;

export const GET_LAUNCH_OPTIONS_OPERATION_ID = "get-launch-options";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/**
 * Local schema for `LifecycleAgentType` (`"opencode" | "claude"`, from shared/ipc).
 * That shared type is not part of the intent `contract` vocabulary, so it is defined
 * here; its inferred type is structurally identical to `LifecycleAgentType`.
 */
const lifecycleAgentTypeSchema = z.enum(["opencode", "claude"]);

export const getLaunchOptionsPayloadSchema = z
  .object({
    /** Backend the form currently targets. */
    backend: lifecycleAgentTypeSchema,
  })
  .readonly();

/**
 * Launch options for a backend.
 * - permissionModes: selectable Claude permission modes (empty for OpenCode,
 *   or when detection fails — the form then offers only the default).
 */
export const launchOptionsResultSchema = z
  .object({
    permissionModes: z.array(z.string()).readonly(),
  })
  .readonly();

/**
 * Per-handler result for the "launch-options" hook point. Each agent module
 * contributes only when the requested backend matches its provider type.
 */
export const launchOptionsHookResultSchema = z
  .object({
    permissionModes: z.array(z.string()).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "launch-options" hook point (beyond the base HookContext). */
const launchOptionsEnrichmentSchema = z.object({ backend: lifecycleAgentTypeSchema });

/** Runtime whole-context validation schema for "launch-options". */
export const launchOptionsHookInputSchema = hookCtxSchema(
  getLaunchOptionsPayloadSchema,
  launchOptionsEnrichmentSchema.shape
);

const schemas = {
  type: INTENT_GET_LAUNCH_OPTIONS,
  payload: getLaunchOptionsPayloadSchema,
  result: launchOptionsResultSchema,
  hooks: {
    "launch-options": {
      input: launchOptionsHookInputSchema,
      result: launchOptionsHookResultSchema,
    },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetLaunchOptionsPayload = z.infer<typeof getLaunchOptionsPayloadSchema>;
export type LaunchOptionsResult = z.infer<typeof launchOptionsResultSchema>;
export type GetLaunchOptionsIntent = IntentOf<typeof schemas>;
export type LaunchOptionsHookResult = z.infer<typeof launchOptionsHookResultSchema>;

/** Input context for the "launch-options" hook point: base envelope + inferred enrichment. */
export type LaunchOptionsHookInput = HookContext & z.infer<typeof launchOptionsEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class AgentLaunchOptionsOperation implements Operation<typeof schemas> {
  readonly id = GET_LAUNCH_OPTIONS_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<GetLaunchOptionsIntent>): Promise<LaunchOptionsResult> {
    const hookCtx: LaunchOptionsHookInput = {
      intent: ctx.intent,
      backend: ctx.intent.payload.backend,
    };
    const { results } = await ctx.hooks.collect<LaunchOptionsHookResult>("launch-options", hookCtx);

    const permissionModes: string[] = [];
    for (const result of results) {
      if (result.permissionModes) permissionModes.push(...result.permissionModes);
    }
    return { permissionModes };
  }
}
