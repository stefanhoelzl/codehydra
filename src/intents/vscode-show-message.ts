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
 */

import type { Intent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export type VscodeShowMessageType = "info" | "warning" | "error" | "status" | "select";

export interface VscodeShowMessagePayload {
  readonly workspacePath: string;
  readonly type: VscodeShowMessageType;
  /** Display text. null = dismiss (only valid for status). */
  readonly message: string | null;
  /** Secondary text: tooltip for status, placeholder for select. */
  readonly hint?: string;
  /** Action buttons (notification) or selection items (select). Omit for free text input. */
  readonly options?: readonly string[];
  /** Timeout in milliseconds for interactive operations. */
  readonly timeoutMs?: number;
}

export interface VscodeShowMessageIntent extends Intent<string | null> {
  readonly type: "vscode:show-message";
  readonly payload: VscodeShowMessagePayload;
}

export const INTENT_VSCODE_SHOW_MESSAGE = "vscode:show-message" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const VSCODE_SHOW_MESSAGE_OPERATION_ID = "vscode-show-message";

/** Input context for "show" handlers. */
export interface ShowHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for the "show" hook point. */
export interface ShowHookResult {
  readonly result?: string | null;
}

// =============================================================================
// Operation
// =============================================================================

export class VscodeShowMessageOperation extends WorkspaceHookOperation<
  VscodeShowMessageIntent,
  ShowHookResult,
  string | null
> {
  constructor() {
    super(VSCODE_SHOW_MESSAGE_OPERATION_ID, {
      hookPoint: "show",
      errorLabel: "vscode-show-message show hooks failed",
      extract: (results) => lastDefined(results, (r) => r.result) ?? null,
    });
  }
}
