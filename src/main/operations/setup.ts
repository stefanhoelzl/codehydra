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
 * Per-handler result contract for the "agent-selection" hook point.
 */
export interface AgentSelectionHookResult {
  readonly selectedAgent: ConfigAgentType;
}

/**
 * Input context for the "save-agent" hook — carries selectedAgent from agent-selection.
 */
export interface SaveAgentHookInput extends HookContext {
  readonly selectedAgent: ConfigAgentType;
}

/**
 * Input context for the "binary" hook — carries agent and binary info from payload/selection.
 */
export interface BinaryHookInput extends HookContext {
  readonly selectedAgent?: ConfigAgentType;
  readonly configuredAgent?: ConfigAgentType | null;
  readonly missingBinaries?: readonly BinaryType[];
}

/**
 * Input context for the "extensions" hook — carries extension info from payload.
 */
export interface ExtensionsHookInput extends HookContext {
  readonly missingExtensions?: readonly string[];
  readonly outdatedExtensions?: readonly string[];
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
    const { payload } = ctx.intent;
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    try {
      // Hook 1: "show-ui" -- Show setup screen
      const { errors: showUiErrors } = await ctx.hooks.collect<void>("show-ui", hookCtx);
      if (showUiErrors.length > 0) {
        throw showUiErrors[0]!;
      }

      // Hook 2: "agent-selection" -- (conditional) Show UI, wait for user selection
      let selectedAgent: ConfigAgentType | undefined;
      if (payload.needsAgentSelection) {
        const { results: agentResults, errors: agentErrors } =
          await ctx.hooks.collect<AgentSelectionHookResult>("agent-selection", hookCtx);
        if (agentErrors.length > 0) {
          throw agentErrors[0]!;
        }
        for (const result of agentResults) {
          if (result.selectedAgent !== undefined) selectedAgent = result.selectedAgent;
        }
      }

      // Hook 3: "save-agent" -- (conditional) Persist agent selection
      if (selectedAgent) {
        const saveAgentInput: SaveAgentHookInput = {
          intent: ctx.intent,
          selectedAgent,
        };
        const { errors: saveErrors } = await ctx.hooks.collect<void>("save-agent", saveAgentInput);
        if (saveErrors.length > 0) {
          throw saveErrors[0]!;
        }
      }

      // Hook 4: "binary" -- Update binary progress (downloads if needed)
      const binaryInput: BinaryHookInput = {
        intent: ctx.intent,
        ...(selectedAgent !== undefined && { selectedAgent }),
        ...(payload.configuredAgent !== undefined && { configuredAgent: payload.configuredAgent }),
        ...(payload.missingBinaries !== undefined && { missingBinaries: payload.missingBinaries }),
      };
      const { errors: binaryErrors } = await ctx.hooks.collect<void>("binary", binaryInput);
      if (binaryErrors.length > 0) {
        throw binaryErrors[0]!;
      }

      // Hook 5: "extensions" -- Update extension progress (installs if needed)
      const extensionsInput: ExtensionsHookInput = {
        intent: ctx.intent,
        ...(payload.missingExtensions !== undefined && {
          missingExtensions: payload.missingExtensions,
        }),
        ...(payload.outdatedExtensions !== undefined && {
          outdatedExtensions: payload.outdatedExtensions,
        }),
      };
      const { errors: extensionsErrors } = await ctx.hooks.collect<void>(
        "extensions",
        extensionsInput
      );
      if (extensionsErrors.length > 0) {
        throw extensionsErrors[0]!;
      }

      // Hook 6: "hide-ui" -- Hide setup screen (return to starting screen)
      const { errors: hideUiErrors } = await ctx.hooks.collect<void>("hide-ui", hookCtx);
      if (hideUiErrors.length > 0) {
        throw hideUiErrors[0]!;
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
