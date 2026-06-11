/**
 * VscodeCommandOperation - Execute a VS Code command in a workspace.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "execute" hook — handler performs the actual command execution
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a command pass-through operation.
 */

import type { Intent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface VscodeCommandPayload {
  readonly workspacePath: string;
  readonly command: string;
  readonly args?: readonly unknown[] | undefined;
}

export interface VscodeCommandIntent extends Intent<unknown> {
  readonly type: "vscode:command";
  readonly payload: VscodeCommandPayload;
}

export const INTENT_VSCODE_COMMAND = "vscode:command" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const VSCODE_COMMAND_OPERATION_ID = "vscode-command";

/** Input context for "execute" handlers. */
export interface ExecuteHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for the "execute" hook point. */
export interface ExecuteHookResult {
  readonly result?: unknown;
}

// =============================================================================
// Operation
// =============================================================================

export class VscodeCommandOperation extends WorkspaceHookOperation<
  VscodeCommandIntent,
  ExecuteHookResult,
  unknown
> {
  constructor() {
    super(VSCODE_COMMAND_OPERATION_ID, {
      hookPoint: "execute",
      errorLabel: "vscode-command execute hooks failed",
      // No required result — a command may legitimately return undefined.
      extract: (results) => lastDefined(results, (r) => r.result),
    });
  }
}
