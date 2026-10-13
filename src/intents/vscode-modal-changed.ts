/**
 * VscodeModalChangedOperation - Reports that a workspace gained or lost its open modals.
 *
 * Two sources, each reporting its own edges: `editor` (the modals below) and
 * `sidebar` (a sidebar card attached to the workspace that waits for an answer —
 * `ch ws ask --sidebar`). Either one parks the workspace on idle; only an editor
 * modal also holds back the terminal focus, since only it sits in front of the
 * terminal.
 *
 * Every `vscode:show-message` modal (notification, quick pick, input box) blocks the
 * workspace's editor on the user until it is dismissed, whoever raised it. The API server
 * server tracks each one from emit until the sidekick acks its dismissal (or the socket
 * drops) and dispatches this intent on the edges: `open: true` when the first modal
 * appears, `open: false` when the last one goes.
 *
 * The "modal" hook is resolved per-workspace agent by the workspace-agent resolver,
 * then handled by the matching agent module, which overlays "idle" on the workspace's
 * status while a modal is open. No domain event is emitted here — the overlaid status
 * propagates via agent:update-status.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/hook input
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` type is
 * **derived** from that bundle via `IntentOf` — never restated. The result is void.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, workspaceRefSchema, workspaceTargetShape } from "./contract";
import { resolveWorkspaceIdentity } from "./lib/workspace-identity";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_VSCODE_MODAL_CHANGED = "vscode:modal-changed" as const;

export const VSCODE_MODAL_CHANGED_OPERATION_ID = "vscode-modal-changed";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const vscodeModalChangedPayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    /** Where the question is shown: the workspace's editor, or a sidebar card. */
    source: z.enum(["editor", "sidebar"]),
    /** True while at least one question from this source is open. */
    open: z.boolean(),
  })
  .readonly();

/** Operation-added enrichment for the "modal" hook point (beyond the base HookContext). */
const modalEnrichmentSchema = z.object({
  ...workspaceTargetShape,
  source: z.enum(["editor", "sidebar"]),
  open: z.boolean(),
});

/** Runtime whole-context validation schema for "modal". */
export const modalHookInputSchema = hookCtxSchema(
  vscodeModalChangedPayloadSchema,
  modalEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_VSCODE_MODAL_CHANGED,
  payload: vscodeModalChangedPayloadSchema,
  hooks: {
    modal: { input: modalHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type VscodeModalChangedPayload = z.infer<typeof vscodeModalChangedPayloadSchema>;
export type ModalSource = VscodeModalChangedPayload["source"];
export type VscodeModalChangedIntent = IntentOf<typeof schemas>;

/** Input context for the "modal" hook point: base envelope + inferred enrichment. */
export type ModalHookInput = HookContext & z.infer<typeof modalEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class VscodeModalChangedOperation implements Operation<typeof schemas> {
  readonly id = VSCODE_MODAL_CHANGED_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<VscodeModalChangedIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;

    const modalCtx: ModalHookInput = {
      intent: ctx.intent,
      workspaceRef: payload.workspaceRef,
      workspacePath: (
        await resolveWorkspaceIdentity(ctx.dispatch, payload.workspaceRef, { withProject: false })
      ).workspacePath,
      source: payload.source,
      open: payload.open,
    };
    const { errors } = await ctx.hooks.collect("modal", modalCtx);
    throwHookErrors(errors, "vscode-modal-changed modal hooks failed");
  }
}
