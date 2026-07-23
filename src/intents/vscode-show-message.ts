/**
 * VscodeShowMessageOperation - Unified VS Code UI messaging.
 *
 * Covers notifications, status bar, quick pick, and input box through
 * a single intent with a `type` discriminator.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "show" hook — handler performs the actual VS Code UI call
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a UI pass-through operation.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { HookContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined } from "./lib/hook-helpers";
import { hookCtxSchema, workspacePathSchema } from "./contract";

export const INTENT_VSCODE_SHOW_MESSAGE = "vscode:show-message" as const;
export const VSCODE_SHOW_MESSAGE_OPERATION_ID = "vscode-show-message";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const vscodeShowMessageTypeSchema = z.enum(["info", "warning", "error", "status", "select"]);

export const vscodeShowMessagePayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
    type: vscodeShowMessageTypeSchema,
    /** Display text. null = dismiss (only valid for status). */
    message: z.string().nullable(),
    /** Secondary text: tooltip for status, placeholder for select. */
    hint: z.string().optional(),
    /** Action buttons (notification) or selection items (select). Omit for free text input. */
    options: z.array(z.string()).readonly().optional(),
    /** Timeout in milliseconds for interactive operations. */
    timeoutMs: z.number().optional(),
  })
  .readonly();

export const vscodeShowMessageResultSchema = z.string().nullable();

/** Per-handler result for the "show" hook point. */
export const showHookResultSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "show" hook point (beyond the base HookContext). */
const showEnrichmentSchema = z.object({ workspacePath: workspacePathSchema });

/** Runtime whole-context validation schema for "show". */
export const showHookInputSchema = hookCtxSchema(
  vscodeShowMessagePayloadSchema,
  showEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_VSCODE_SHOW_MESSAGE,
  payload: vscodeShowMessagePayloadSchema,
  result: vscodeShowMessageResultSchema,
  hooks: {
    show: { input: showHookInputSchema, result: showHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type VscodeShowMessageType = z.infer<typeof vscodeShowMessageTypeSchema>;
export type VscodeShowMessagePayload = z.infer<typeof vscodeShowMessagePayloadSchema>;
export type VscodeShowMessageIntent = IntentOf<typeof schemas>;
export type ShowHookResult = z.infer<typeof showHookResultSchema>;

/** Whole input context for "show" handlers: base envelope + inferred enrichment. */
export type ShowHookInput = HookContext & z.infer<typeof showEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class VscodeShowMessageOperation extends WorkspaceHookOperation<typeof schemas> {
  readonly schemas = schemas;

  constructor() {
    super(VSCODE_SHOW_MESSAGE_OPERATION_ID, {
      hookPoint: "show",
      buildInput: (intent, workspacePath) => ({ intent, workspacePath }),
      errorLabel: "vscode-show-message show hooks failed",
      extract: (results) => lastDefined(results, (r) => r.result) ?? null,
    });
  }
}
