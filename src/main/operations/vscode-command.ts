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

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";

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

export class VscodeCommandOperation implements Operation<VscodeCommandIntent, unknown> {
  readonly id = VSCODE_COMMAND_OPERATION_ID;

  async execute(ctx: OperationContext<VscodeCommandIntent>): Promise<unknown> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. execute — handler performs the actual command
    const executeCtx: ExecuteHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ExecuteHookResult>("execute", executeCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Extract result — last-write-wins
    let result: unknown;
    for (const r of results) {
      if (r.result !== undefined) result = r.result;
    }

    return result;
  }
}
