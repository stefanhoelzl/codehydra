/**
 * VscodeCommandOperation - Execute a VS Code command in a workspace.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to turn workspaceRef into the workspace
 * 2. "execute" hook — handler performs the actual command execution
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a command pass-through operation.
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

export const INTENT_VSCODE_COMMAND = "vscode:command" as const;
export const VSCODE_COMMAND_OPERATION_ID = "vscode-command";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const vscodeCommandPayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    command: z.string(),
    args: z.array(z.unknown()).readonly().optional(),
  })
  .readonly();

/** Command results are pass-through — a command may legitimately return anything (or nothing). */
export const vscodeCommandResultSchema = z.unknown();

/** Per-handler result for the "execute" hook point. */
export const executeHookResultSchema = z
  .object({
    result: z.unknown().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "execute" hook point (beyond the base HookContext). */
const executeEnrichmentSchema = z.object(workspaceTargetShape);

/** Runtime whole-context validation schema for "execute". */
export const executeHookInputSchema = hookCtxSchema(
  vscodeCommandPayloadSchema,
  executeEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_VSCODE_COMMAND,
  payload: vscodeCommandPayloadSchema,
  result: vscodeCommandResultSchema,
  hooks: {
    execute: { input: executeHookInputSchema, result: executeHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type VscodeCommandPayload = z.infer<typeof vscodeCommandPayloadSchema>;
export type VscodeCommandIntent = IntentOf<typeof schemas>;
export type ExecuteHookResult = z.infer<typeof executeHookResultSchema>;

/** Whole input context for "execute" handlers: base envelope + inferred enrichment. */
export type ExecuteHookInput = HookContext & z.infer<typeof executeEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class VscodeCommandOperation extends WorkspaceHookOperation<typeof schemas> {
  readonly schemas = schemas;

  constructor() {
    super(VSCODE_COMMAND_OPERATION_ID, {
      hookPoint: "execute",
      buildInput: (intent, target) => ({ intent, ...target }),
      errorLabel: "vscode-command execute hooks failed",
      // No required result — a command may legitimately return undefined.
      extract: (results) => onlyDefined(results, "result", "vscode:command execute"),
    });
  }
}
