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

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ConfigAgentType, SetupRowId, SetupRowStatus } from "../shared/api/types";
import type { BinaryType } from "../utils/binary-resolution/types";
import type { ExtensionInstallEntry } from "./app-start";
import type { LifecycleAgentType } from "../shared/ipc";
import { throwHookErrors } from "./lib/hook-helpers";

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
  /** Extensions to install (from check-deps install plan) */
  readonly extensionInstallPlan?: readonly ExtensionInstallEntry[];
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
 * Per-handler result contract for the "register-agents" hook point.
 * Each per-agent module returns its agent info for the selection UI.
 */
export interface RegisterAgentResult {
  readonly agent: LifecycleAgentType;
  readonly label: string;
  readonly icon: string;
}

// selectedAgent is the agent-selection hook *result* (operation-consumed, not a
// capability — nothing in the hook point requires it).

/**
 * Input context for the "agent-selection" hook — carries available agents from register-agents.
 */
export interface AgentSelectionHookContext extends HookContext {
  readonly availableAgents: readonly RegisterAgentResult[];
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
  readonly report: SetupProgressReporter;
}

/**
 * Input context for the "extensions" hook — carries install plan from payload.
 */
export interface ExtensionsHookInput extends HookContext {
  readonly extensionInstallPlan?: readonly ExtensionInstallEntry[];
  readonly report: SetupProgressReporter;
}

// =============================================================================
// Domain Events
// =============================================================================

export const EVENT_SETUP_PROGRESS = "setup:progress" as const;

export interface SetupProgressPayload {
  readonly id: SetupRowId;
  readonly status: SetupRowStatus;
  readonly message?: string;
  readonly error?: string;
  readonly progress?: number;
}

export interface SetupProgressEvent {
  readonly type: typeof EVENT_SETUP_PROGRESS;
  readonly payload: SetupProgressPayload;
}

/**
 * Progress reporter callback for setup screen rows.
 * Injected into hook contexts by SetupOperation.execute().
 */
export type SetupProgressReporter = (
  id: SetupRowId,
  status: SetupRowStatus,
  message?: string,
  error?: string,
  progress?: number
) => void;

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
      throwHookErrors(showUiErrors, "app:setup show-ui hooks failed");

      // Hook 2: "agent-selection" -- (conditional) Collect agent info + show UI
      let selectedAgent: ConfigAgentType | undefined;
      if (payload.needsAgentSelection) {
        // 2a: Collect available agents from per-agent modules
        const { results: agentInfos, errors: registerErrors } =
          await ctx.hooks.collect<RegisterAgentResult>("register-agents", hookCtx);
        throwHookErrors(registerErrors, "app:setup register-agents hooks failed");

        // 2b: Show agent selection UI with collected agents
        const selectionCtx: AgentSelectionHookContext = { ...hookCtx, availableAgents: agentInfos };
        const { errors: agentErrors, results: agentResults } =
          await ctx.hooks.collect<LifecycleAgentType>("agent-selection", selectionCtx);
        throwHookErrors(agentErrors, "app:setup agent-selection hooks failed");
        // Single result-producer (the picker); results[0] is the chosen agent.
        selectedAgent = agentResults[0] as ConfigAgentType | undefined;
      }

      // Hook 3: "save-agent" -- (conditional) Persist agent selection
      if (selectedAgent) {
        const saveAgentInput: SaveAgentHookInput = {
          intent: ctx.intent,
          selectedAgent,
        };
        const { errors: saveErrors } = await ctx.hooks.collect<void>("save-agent", saveAgentInput);
        throwHookErrors(saveErrors, "app:setup save-agent hooks failed");
      }

      // Create progress reporter that emits domain events
      const report: SetupProgressReporter = (id, status, message?, error?, progress?) => {
        const progressPayload: SetupProgressPayload = {
          id,
          status,
          ...(message !== undefined && { message }),
          ...(error !== undefined && { error }),
          ...(progress !== undefined && { progress }),
        };
        ctx.emit({ type: EVENT_SETUP_PROGRESS, payload: progressPayload });
      };

      // Hook 4: "binary" -- Update binary progress (downloads if needed)
      const binaryInput: BinaryHookInput = {
        intent: ctx.intent,
        report,
        ...(selectedAgent !== undefined && { selectedAgent }),
        ...(payload.configuredAgent !== undefined && { configuredAgent: payload.configuredAgent }),
        ...(payload.missingBinaries !== undefined && { missingBinaries: payload.missingBinaries }),
      };
      const { errors: binaryErrors } = await ctx.hooks.collect<void>("binary", binaryInput);
      throwHookErrors(binaryErrors, "app:setup binary hooks failed");

      // Hook 5: "extensions" -- Update extension progress (installs if needed)
      const extensionsInput: ExtensionsHookInput = {
        intent: ctx.intent,
        report,
        ...(payload.extensionInstallPlan !== undefined && {
          extensionInstallPlan: payload.extensionInstallPlan,
        }),
      };
      const { errors: extensionsErrors } = await ctx.hooks.collect<void>(
        "extensions",
        extensionsInput
      );
      throwHookErrors(extensionsErrors, "app:setup extensions hooks failed");

      // Hook 6: "hide-ui" -- Hide setup screen (return to starting screen)
      const { errors: hideUiErrors } = await ctx.hooks.collect<void>("hide-ui", hookCtx);
      throwHookErrors(hideUiErrors, "app:setup hide-ui hooks failed");

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
