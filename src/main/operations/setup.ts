/**
 * SetupOperation - Orchestrates setup UI and work.
 *
 * Called as a blocking sub-operation from AppStartOperation when setup is needed.
 * Runs six hook points in sequence:
 * 1. "show-ui" - Show setup screen
 * 2. "agent-selection" - (if needsAgentSelection) Show agent selection UI, wait for user
 * 3. "save-agent" - (if selectedAgent) Persist agent selection to config
 * 4. "binary" - Update binary progress (downloads if needed)
 * 5. "extensions" - Update extension progress (installs if needed)
 * 6. "hide-ui" - Hide setup screen (return to starting screen)
 *
 * On completion, returns control to AppStartOperation (no dispatch).
 * On failure, emits setup:error domain event for renderer error UI.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ConfigAgentType } from "../../shared/api/types";
import type { BinaryType } from "../../services/vscode-setup/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface SetupPayload {
  /** True if agent selection is needed */
  readonly needsAgentSelection?: boolean;
  /** True if binary download is needed */
  readonly needsBinaryDownload?: boolean;
  /** List of binaries that need download */
  readonly missingBinaries?: readonly BinaryType[];
  /** True if extensions need install */
  readonly needsExtensions?: boolean;
  /** List of extensions that need install */
  readonly missingExtensions?: readonly string[];
  /** List of extensions that need update */
  readonly outdatedExtensions?: readonly string[];
  /** Currently configured agent (may be null) */
  readonly configuredAgent?: ConfigAgentType | null;
}

export interface SetupIntent extends Intent<void> {
  readonly type: "app:setup";
  readonly payload: SetupPayload;
}

export const INTENT_SETUP = "app:setup" as const;

// =============================================================================
// Hook Context
// =============================================================================

export const SETUP_OPERATION_ID = "setup";

/**
 * Extended hook context for app:setup.
 *
 * Fields are populated from the intent payload (set by AppStartOperation)
 * and by hook modules across the six hook points:
 * - "show-ui": (no fields, sends IPC to show setup screen)
 * - "agent-selection": selectedAgent (from renderer)
 * - "save-agent": (no new fields, persists selectedAgent)
 * - "binary": (no new fields, downloads binaries if needed, updates progress)
 * - "extensions": (no new fields, installs extensions if needed, updates progress)
 * - "hide-ui": (no fields, sends IPC to return to starting screen)
 */
export interface SetupHookContext extends HookContext {
  // Fields from intent payload (set by AppStartOperation check hooks)
  /** True if agent not selected in config */
  needsAgentSelection?: boolean;
  /** Currently configured agent (may be null) */
  configuredAgent?: ConfigAgentType | null;
  /** True if any binaries need download */
  needsBinaryDownload?: boolean;
  /** List of binaries that need download */
  missingBinaries?: readonly BinaryType[];
  /** True if any extensions need install */
  needsExtensions?: boolean;
  /** List of extensions that need install */
  missingExtensions?: readonly string[];
  /** List of extensions that need update */
  outdatedExtensions?: readonly string[];

  // Fields set during setup
  /** Set by RendererModule after user selection: the chosen agent */
  selectedAgent?: ConfigAgentType;
}

// =============================================================================
// Domain Events
// =============================================================================

export const EVENT_SETUP_ERROR = "setup:error" as const;

export interface SetupErrorPayload {
  readonly message: string;
  readonly code?: string;
}

export interface SetupErrorEvent {
  readonly type: typeof EVENT_SETUP_ERROR;
  readonly payload: SetupErrorPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class SetupOperation implements Operation<SetupIntent, void> {
  readonly id = SETUP_OPERATION_ID;

  async execute(ctx: OperationContext<SetupIntent>): Promise<void> {
    // Copy payload fields to hook context (exactOptionalPropertyTypes: only include defined values)
    const { payload } = ctx.intent;
    const hookCtx: SetupHookContext = {
      intent: ctx.intent,
      ...(payload.needsAgentSelection !== undefined && {
        needsAgentSelection: payload.needsAgentSelection,
      }),
      ...(payload.configuredAgent !== undefined && { configuredAgent: payload.configuredAgent }),
      ...(payload.needsBinaryDownload !== undefined && {
        needsBinaryDownload: payload.needsBinaryDownload,
      }),
      ...(payload.missingBinaries !== undefined && { missingBinaries: payload.missingBinaries }),
      ...(payload.needsExtensions !== undefined && { needsExtensions: payload.needsExtensions }),
      ...(payload.missingExtensions !== undefined && {
        missingExtensions: payload.missingExtensions,
      }),
      ...(payload.outdatedExtensions !== undefined && {
        outdatedExtensions: payload.outdatedExtensions,
      }),
    };

    try {
      // Hook 1: "show-ui" -- Show setup screen
      await ctx.hooks.run("show-ui", hookCtx);
      if (hookCtx.error) {
        throw hookCtx.error;
      }

      // Hook 2: "agent-selection" -- (conditional) Show UI, wait for user selection
      if (hookCtx.needsAgentSelection) {
        await ctx.hooks.run("agent-selection", hookCtx);
        if (hookCtx.error) {
          throw hookCtx.error;
        }
      }

      // Hook 3: "save-agent" -- (conditional) Persist agent selection
      if (hookCtx.selectedAgent) {
        await ctx.hooks.run("save-agent", hookCtx);
        if (hookCtx.error) {
          throw hookCtx.error;
        }
      }

      // Hook 4: "binary" -- Update binary progress (downloads if needed)
      await ctx.hooks.run("binary", hookCtx);
      if (hookCtx.error) {
        throw hookCtx.error;
      }

      // Hook 5: "extensions" -- Update extension progress (installs if needed)
      await ctx.hooks.run("extensions", hookCtx);
      if (hookCtx.error) {
        throw hookCtx.error;
      }

      // Hook 6: "hide-ui" -- Hide setup screen (return to starting screen)
      await ctx.hooks.run("hide-ui", hookCtx);
      if (hookCtx.error) {
        throw hookCtx.error;
      }

      // Control returns to AppStartOperation (no dispatch)
    } catch (error) {
      // Emit domain event for error handling
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && "code" in error
          ? (error as Error & { code?: string }).code
          : undefined;
      // Conditionally include code only when defined (exactOptionalPropertyTypes)
      const event: SetupErrorEvent = {
        type: EVENT_SETUP_ERROR,
        payload: code !== undefined ? { message, code } : { message },
      };
      ctx.emit(event);
      throw error;
    }
  }
}
