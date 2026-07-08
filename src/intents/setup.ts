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
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent`, hook,
 * and event types are **derived** from that bundle — never restated.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import type { ConfigAgentType } from "../shared/api/types";
import {
  configAgentTypeSchema,
  setupRowIdSchema,
  setupRowStatusSchema,
  hookCtxSchema,
} from "./contract";
import type { LifecycleAgentType } from "../shared/ipc";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_SETUP = "app:setup" as const;
export const SETUP_OPERATION_ID = "setup";

export const EVENT_SETUP_PROGRESS = "setup:progress" as const;
export const EVENT_SETUP_ERROR = "setup:error" as const;

// =============================================================================
// Local schemas (types missing from the shared contract)
// =============================================================================

/** Binaries the setup flow can download. Local schema; mirrors binary-resolution's BinaryType. */
const binaryTypeSchema = z.enum(["vscodium", "opencode", "claude"]);

/** Selectable agent backend. Local schema; mirrors shared/ipc's LifecycleAgentType. */
const lifecycleAgentTypeSchema = z.enum(["opencode", "claude"]);

/** What needs to be installed. Local schema; mirrors app-start's ExtensionInstallEntry. */
const extensionInstallEntrySchema = z
  .object({
    id: z.string(),
    vsixPath: z.string(),
  })
  .readonly();

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const setupPayloadSchema = z
  .object({
    /** True if agent selection is needed */
    needsAgentSelection: z.boolean().optional(),
    /** True if binary download is needed */
    needsBinaryDownload: z.boolean().optional(),
    /** List of binaries that need download */
    missingBinaries: z.array(binaryTypeSchema).readonly().optional(),
    /** True if extensions need install */
    needsExtensions: z.boolean().optional(),
    /** Extensions to install (from check-deps install plan) */
    extensionInstallPlan: z.array(extensionInstallEntrySchema).readonly().optional(),
    /** Currently configured agent (may be null) */
    configuredAgent: configAgentTypeSchema.nullable().optional(),
  })
  .readonly();

// =============================================================================
// Per-hook-point schemas
// =============================================================================

/**
 * Per-handler result contract for the "register-agents" hook point.
 * Each per-agent module returns its agent info for the selection UI.
 */
export const registerAgentResultSchema = z
  .object({
    agent: lifecycleAgentTypeSchema,
    label: z.string(),
    icon: z.string(),
  })
  .readonly();

// selectedAgent is the agent-selection hook *result* (operation-consumed, not a
// capability — nothing in the hook point requires it).

/** Operation-added enrichment for the "agent-selection" hook (available agents from register-agents). */
const agentSelectionEnrichmentSchema = z.object({
  availableAgents: z.array(registerAgentResultSchema).readonly(),
});
const agentSelectionInputSchema = hookCtxSchema(
  setupPayloadSchema,
  agentSelectionEnrichmentSchema.shape
);

/** Operation-added enrichment for the "save-agent" hook (selectedAgent from agent-selection). */
const saveAgentEnrichmentSchema = z.object({ selectedAgent: configAgentTypeSchema });
const saveAgentInputSchema = hookCtxSchema(setupPayloadSchema, saveAgentEnrichmentSchema.shape);

/**
 * Operation-added enrichment for the "binary" hook (agent + binary info from payload/selection).
 * Progress is streamed by the handler (an async generator that yields `SetupProgressPayload`
 * frames); the operation emits `setup:progress` for each — no `report` closure in the context.
 */
const binaryEnrichmentSchema = z.object({
  selectedAgent: configAgentTypeSchema.optional(),
  configuredAgent: configAgentTypeSchema.nullable().optional(),
  missingBinaries: z.array(binaryTypeSchema).readonly().optional(),
});
const binaryInputSchema = hookCtxSchema(setupPayloadSchema, binaryEnrichmentSchema.shape);

/**
 * Operation-added enrichment for the "extensions" hook (install plan from payload).
 * Progress streams the same way as the "binary" hook (yielded frames, not a closure).
 */
const extensionsEnrichmentSchema = z.object({
  extensionInstallPlan: z.array(extensionInstallEntrySchema).readonly().optional(),
});
const extensionsInputSchema = hookCtxSchema(setupPayloadSchema, extensionsEnrichmentSchema.shape);

// =============================================================================
// Event payload schemas (events defined in this file)
// =============================================================================

const setupProgressSchema = z
  .object({
    id: setupRowIdSchema,
    status: setupRowStatusSchema,
    message: z.string().optional(),
    error: z.string().optional(),
    progress: z.number().optional(),
  })
  .readonly();

const setupErrorSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
  })
  .readonly();

const schemas = {
  type: INTENT_SETUP,
  payload: setupPayloadSchema,
  hooks: {
    "register-agents": { result: registerAgentResultSchema },
    "agent-selection": {
      input: agentSelectionInputSchema,
      result: lifecycleAgentTypeSchema,
    },
    "save-agent": { input: saveAgentInputSchema },
    binary: { input: binaryInputSchema },
    extensions: { input: extensionsInputSchema },
  },
  events: {
    [EVENT_SETUP_PROGRESS]: setupProgressSchema,
    [EVENT_SETUP_ERROR]: setupErrorSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SetupPayload = z.infer<typeof setupPayloadSchema>;
export type SetupIntent = IntentOf<typeof schemas>;

export type RegisterAgentResult = z.infer<typeof registerAgentResultSchema>;

/**
 * Input context for the "agent-selection" hook — carries available agents from register-agents.
 */
export type AgentSelectionHookContext = HookContext &
  z.infer<typeof agentSelectionEnrichmentSchema>;

/**
 * Input context for the "save-agent" hook — carries selectedAgent from agent-selection.
 */
export type SaveAgentHookInput = HookContext & z.infer<typeof saveAgentEnrichmentSchema>;

/**
 * Input context for the "binary" hook — carries agent and binary info from payload/selection.
 */
export type BinaryHookInput = HookContext & z.infer<typeof binaryEnrichmentSchema>;

/**
 * Input context for the "extensions" hook — carries install plan from payload.
 */
export type ExtensionsHookInput = HookContext & z.infer<typeof extensionsEnrichmentSchema>;

export type SetupProgressPayload = z.infer<typeof setupProgressSchema>;

export interface SetupProgressEvent {
  readonly type: typeof EVENT_SETUP_PROGRESS;
  readonly payload: SetupProgressPayload;
}

export type SetupErrorPayload = z.infer<typeof setupErrorSchema>;

export interface SetupErrorEvent {
  readonly type: typeof EVENT_SETUP_ERROR;
  readonly payload: SetupErrorPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class SetupOperation implements Operation<typeof schemas> {
  readonly id = SETUP_OPERATION_ID;
  readonly schemas = schemas;

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

      // Streaming handlers (binary/extensions) yield SetupProgressPayload frames;
      // the operation emits setup:progress for each. DomainEvent.payload is unknown,
      // so the frame forwards straight through — the handler owns its typed yields.
      const emitProgress = (frame: unknown): void => {
        void ctx.emit({ type: EVENT_SETUP_PROGRESS, payload: frame });
      };

      // Hook 4: "binary" -- Update binary progress (downloads if needed)
      const binaryInput: BinaryHookInput = {
        intent: ctx.intent,
        ...(selectedAgent !== undefined && { selectedAgent }),
        ...(payload.configuredAgent !== undefined && { configuredAgent: payload.configuredAgent }),
        ...(payload.missingBinaries !== undefined && { missingBinaries: payload.missingBinaries }),
      };
      const { errors: binaryErrors } = await ctx.hooks.collect<void>("binary", binaryInput, {
        onYield: emitProgress,
      });
      throwHookErrors(binaryErrors, "app:setup binary hooks failed");

      // Hook 5: "extensions" -- Update extension progress (installs if needed)
      const extensionsInput: ExtensionsHookInput = {
        intent: ctx.intent,
        ...(payload.extensionInstallPlan !== undefined && {
          extensionInstallPlan: payload.extensionInstallPlan,
        }),
      };
      const { errors: extensionsErrors } = await ctx.hooks.collect<void>(
        "extensions",
        extensionsInput,
        { onYield: emitProgress }
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
