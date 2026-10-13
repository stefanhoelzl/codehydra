/**
 * VscodeShowMessageOperation - Unified VS Code UI messaging.
 *
 * Covers toasts, the status bar, and the questions that wait for the user (an
 * ask's buttons, a quick pick, an input box, a file dialog) through a single
 * intent with a `type` discriminator.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to turn workspaceRef into the workspace
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
import { onlyDefined } from "./lib/hook-helpers";
import { hookCtxSchema, workspaceRefSchema, workspaceTargetShape } from "./contract";

export const INTENT_VSCODE_SHOW_MESSAGE = "vscode:show-message" as const;
export const VSCODE_SHOW_MESSAGE_OPERATION_ID = "vscode-show-message";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const vscodeShowMessageTypeSchema = z.enum([
  "info",
  "warning",
  "error",
  "status",
  "ask",
  "select",
  "input",
  "pick-file",
]);

/** One entry of a `select` list. */
export const vscodeSelectItemSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    detail: z.string().optional(),
    /** Ticked in advance (multi-select only). */
    picked: z.boolean().optional(),
  })
  .readonly();

/**
 * Fields each type reads; the others are ignored.
 *
 * - info/warning/error: a toast (`message`). Never waits.
 * - status: status-bar text (`message`, `hint` = tooltip); null message clears it.
 * - ask: a modal with `options` as buttons, `detail` under the message, `severity`
 *   for its icon. VS Code adds Cancel itself.
 * - select: a quick pick of `items` (`message` = title, `hint` = placeholder), `many`.
 * - input: a text box (`message` = prompt, `hint` = placeholder), `value`, `password`.
 * - pick-file: an open dialog (`message` = title), `folders`, `many`, `save` (a
 *   save dialog instead), `filters`, `start`.
 */
export const vscodeShowMessagePayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    type: vscodeShowMessageTypeSchema,
    /** Display text. null = dismiss (only valid for status). */
    message: z.string().nullable(),
    /** Tooltip for status, placeholder for select and input. */
    hint: z.string().optional(),
    /** Secondary text of an ask. */
    detail: z.string().optional(),
    /** Icon of an ask. */
    severity: z.enum(["info", "warning", "error"]).optional(),
    /** Buttons of an ask. */
    options: z.array(z.string()).readonly().optional(),
    /** Entries of a select. */
    items: z.array(vscodeSelectItemSchema).readonly().optional(),
    /** Answer with several: a select's ticked items, a pick-file's paths. */
    many: z.boolean().optional(),
    /** Prefilled text of an input. */
    value: z.string().optional(),
    /** Mask an input's text. */
    password: z.boolean().optional(),
    /** Pick folders instead of files. */
    folders: z.boolean().optional(),
    /** A save dialog: a path that need not exist yet. */
    save: z.boolean().optional(),
    /** File filters: name → extensions without the dot. */
    filters: z.record(z.string(), z.array(z.string()).readonly()).readonly().optional(),
    /** Absolute directory (or file, for save) the dialog starts at. */
    start: z.string().optional(),
    /** Give up waiting after this long; the answer is then null. */
    timeoutMs: z.number().optional(),
    /**
     * Opaque token naming this wait, so a caller that goes away can end it with
     * `vscode:cancel-message { waiter }`. Minted by the registry entry per call.
     */
    waiter: z.string().min(1).optional(),
  })
  .readonly();

/** The answer: a string, several with `many`, null when dismissed, timed out or cancelled. */
export const vscodeShowMessageResultSchema = z
  .union([z.string(), z.array(z.string()).readonly()])
  .nullable();

/** Per-handler result for the "show" hook point. */
export const showHookResultSchema = z
  .object({
    result: vscodeShowMessageResultSchema.optional(),
  })
  .readonly();

/** Operation-added enrichment for the "show" hook point (beyond the base HookContext). */
const showEnrichmentSchema = z.object(workspaceTargetShape);

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
export type VscodeShowMessageResult = z.infer<typeof vscodeShowMessageResultSchema>;
export type VscodeSelectItem = z.infer<typeof vscodeSelectItemSchema>;
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
      buildInput: (intent, target) => ({ intent, ...target }),
      errorLabel: "vscode-show-message show hooks failed",
      extract: (results) => onlyDefined(results, "result", "vscode:show-message show") ?? null,
    });
  }
}
