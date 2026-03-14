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

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";

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

export class VscodeShowMessageOperation implements Operation<
  VscodeShowMessageIntent,
  string | null
> {
  readonly id = VSCODE_SHOW_MESSAGE_OPERATION_ID;

  async execute(ctx: OperationContext<VscodeShowMessageIntent>): Promise<string | null> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. show — handler performs the actual VS Code UI call
    const showCtx: ShowHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ShowHookResult>("show", showCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Extract result — last-write-wins
    let result: string | null | undefined;
    for (const r of results) {
      if (r.result !== undefined) result = r.result;
    }

    return result ?? null;
  }
}
