/**
 * AppStartOperation - Orchestrates application startup.
 *
 * Runs hook points in sequence:
 * 1. "before-ready" - Collect script declarations, apply pre-ready config (no async I/O)
 * 2. "init" - Initialization (logging, shell, scripts, extensions).
 *             Electron lifecycle module provides "app-ready" capability after
 *             app.whenReady(). Handlers needing Electron declare
 *             `requires: { "app-ready": ANY_VALUE }`.
 * 3. "show-ui" - Show starting screen
 * 4. "register-agents" / "agent-selection" / "save-agent" - (first run only)
 *    Collect the selectable agents, show the picker, persist the choice.
 * 5. "check-deps" - Check binaries and extensions (collect, isolated contexts)
 * 6. "start" - Start servers, wire services, mount renderer.
 *              Handlers that need ports (mcpPort, ideServerPort) declare
 *              `requires` and read from ctx.capabilities. Capability-based
 *              ordering replaces the former separate "activate" hook point.
 *
 * Agent selection MUST precede "check-deps": the deps check is agent-specific
 * (each agent module only reports its own missing binary, and only when it is
 * the configured agent), so running it before the agent is known would report an
 * empty binary list and the chosen agent's binary would never be downloaded.
 *
 * Configuration is loaded before this operation runs (via Config.load()).
 * configuredAgent is read from Config, not from hook results.
 *
 * After "start", the renderer signals ready via the `ui-connected` ui:event,
 * which dispatches app:ready to load initial projects (see app-ready.ts).
 *
 * The "check-deps" hook point uses collect() for isolated handler contexts.
 * Each handler returns a typed result; the operation merges results and
 * derives boolean flags (needsSetup, needsBinaryDownload, etc.).
 *
 * If checks determine setup is needed, dispatches app:setup as a blocking
 * sub-operation. Setup manages its own UI (shows/hides setup screen).
 *
 * Aborts on error in any hook. Services that are optional must handle
 * their own errors internally (e.g., PluginServer graceful degradation in
 * IdeServerModule).
 *
 * Contract schemas (item 2): zod is the single source of truth. Payload, per-hook-point
 * (result/input) schemas are declared once and hung on the operation's `schemas` field; the
 * `Intent`, result, and hook-input-context types are **derived** via `IntentOf`/`z.infer`.
 * Every hook point declares an input schema, including those whose context is just the
 * intent ("start", "await-retry"), so a handler's context type is derived rather than
 * hand-written and nothing undeclared can ride along.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  agentInfoSchema,
  agentTypeSchema,
  binaryTypeSchema,
  hookCtxSchema,
  serializedErrorSchema,
} from "./contract";
import type { AgentType, BinaryType } from "./contract";
import { toSerializedError } from "../shared/error-utils";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import { INTENT_SETUP } from "./setup";
import { INTENT_APP_READY, type AppReadyIntent } from "./app-ready";
import { throwHookErrors } from "./lib/hook-helpers";

/** Re-exported for use by operation integration tests (avoids direct service import). */
export type { BinaryType } from "./contract";

export const INTENT_APP_START = "app:start" as const;

// =============================================================================
// Hook Context & Result Types
// =============================================================================

export const APP_START_OPERATION_ID = "app-start";

/** The app:start hook point that runs when startup fails fatally. */
export const APP_START_ERROR_HOOK = "error" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const appStartPayloadSchema = z.object({}).readonly();

/** What the manifest declares — produced by extension-module, consumed by ide-server-module. */
export const extensionRequirementSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    /** Native path to the .vsix file. */
    vsixPath: z.string(),
  })
  .readonly();

/** What needs to be installed — produced by ide-server-module check-deps, consumed by setup. */
export const extensionInstallEntrySchema = z
  .object({
    id: z.string(),
    vsixPath: z.string(),
  })
  .readonly();

/**
 * The startup phase in which a fatal error occurred. Mirrors the hook-point
 * sequence, plus "setup" for the app:setup sub-operation region. Attached to the
 * startup failure report so a crash can be attributed to a phase.
 */
export const appStartPhaseSchema = z.enum([
  "before-ready",
  "init",
  "show-ui",
  "agent-selection",
  "check-deps",
  "setup",
  "start",
]);

/**
 * Per-handler result for the "register-agents" hook point.
 * Each per-agent module returns its agent info for the selection UI.
 */
export const registerAgentResultSchema = agentInfoSchema;

/**
 * Per-handler result for "before-ready" hook point.
 * Returns optional script declarations to be copied to bin directory.
 */
export const configureResultSchema = z
  .object({
    scripts: z.array(z.string()).readonly().optional(),
  })
  .readonly();

/**
 * Per-handler result for "init" hook point.
 * Extension module returns extensionRequirements. Other init handlers return `{}`.
 */
export const initResultSchema = z
  .object({
    extensionRequirements: z.array(extensionRequirementSchema).readonly().optional(),
  })
  .readonly();

/**
 * Per-handler result for "show-ui" hook point.
 * The UI module returns `{ retrySupported: true }` when it can host a setup retry loop;
 * other handlers return void. Data-only: the actual "wait for the user to click Retry"
 * is a separate `await-retry` hook point (the handler blocks internally and returns data),
 * not a closure handed back to the operation.
 */
export const showUIHookResultSchema = z
  .object({
    retrySupported: z.boolean().optional(),
  })
  .readonly();

/** Per-handler result for "check-deps" hook point. Arrays only -- booleans derived by operation. */
export const checkDepsResultSchema = z
  .object({
    missingBinaries: z.array(binaryTypeSchema).readonly().optional(),
    extensionInstallPlan: z.array(extensionInstallEntrySchema).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for "init" -- carries requiredScripts from before-ready results. */
const initEnrichmentSchema = z.object({
  requiredScripts: z.array(z.string()).readonly(),
});
const initHookInputSchema = hookCtxSchema(appStartPayloadSchema, initEnrichmentSchema.shape);

/** Operation-added enrichment for the "agent-selection" hook (agents from register-agents). */
const agentSelectionEnrichmentSchema = z.object({
  availableAgents: z.array(registerAgentResultSchema).readonly(),
});
const agentSelectionInputSchema = hookCtxSchema(
  appStartPayloadSchema,
  agentSelectionEnrichmentSchema.shape
);

/** Operation-added enrichment for the "save-agent" hook (selectedAgent from agent-selection). */
const saveAgentEnrichmentSchema = z.object({ selectedAgent: agentTypeSchema });
const saveAgentInputSchema = hookCtxSchema(appStartPayloadSchema, saveAgentEnrichmentSchema.shape);

/**
 * Operation-added enrichment for "check-deps". Agent modules use their own isActive flag.
 * Non-nullable: agent selection runs first, so the agent is always known here.
 */
const checkDepsEnrichmentSchema = z.object({
  configuredAgent: agentTypeSchema,
  extensionRequirements: z.array(extensionRequirementSchema).readonly(),
});
const checkDepsHookInputSchema = hookCtxSchema(
  appStartPayloadSchema,
  checkDepsEnrichmentSchema.shape
);

/**
 * Operation-added enrichment for the "error" hook point. Carries the fatal error as plain
 * data (with its `cause` chain) and the phase it occurred in. The operation converts with
 * `toSerializedError()`; a handler that needs a real `Error` rebuilds one.
 */
const appStartErrorEnrichmentSchema = z.object({
  error: serializedErrorSchema,
  phase: appStartPhaseSchema,
});
const appStartErrorHookInputSchema = hookCtxSchema(
  appStartPayloadSchema,
  appStartErrorEnrichmentSchema.shape
);

/**
 * The hook points whose context is just the intent. Declared rather than omitted: a hook
 * point with no input schema has no contract, and `InputOf` has nothing to derive from.
 */
const bareHookInputSchema = hookCtxSchema(appStartPayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_APP_START,
  payload: appStartPayloadSchema,
  hooks: {
    "before-ready": { input: bareHookInputSchema, result: configureResultSchema },
    init: { input: initHookInputSchema, result: initResultSchema },
    "show-ui": { input: bareHookInputSchema, result: showUIHookResultSchema },
    "register-agents": { input: bareHookInputSchema, result: registerAgentResultSchema },
    start: { input: bareHookInputSchema },
    "await-retry": { input: bareHookInputSchema },
    "agent-selection": { input: agentSelectionInputSchema, result: agentTypeSchema },
    "save-agent": { input: saveAgentInputSchema },
    "check-deps": { input: checkDepsHookInputSchema, result: checkDepsResultSchema },
    [APP_START_ERROR_HOOK]: { input: appStartErrorHookInputSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type AppStartPayload = z.infer<typeof appStartPayloadSchema>;
export type AppStartIntent = IntentOf<typeof schemas>;

export type ExtensionRequirement = z.infer<typeof extensionRequirementSchema>;
export type ExtensionInstallEntry = z.infer<typeof extensionInstallEntrySchema>;
export type AppStartPhase = z.infer<typeof appStartPhaseSchema>;

export type ConfigureResult = z.infer<typeof configureResultSchema>;
export type InitResult = z.infer<typeof initResultSchema>;
export type ShowUIHookResult = z.infer<typeof showUIHookResultSchema>;
export type CheckDepsResult = z.infer<typeof checkDepsResultSchema>;
export type RegisterAgentResult = z.infer<typeof registerAgentResultSchema>;

/** Input context for the "agent-selection" hook — carries agents from register-agents. */
export type AgentSelectionHookContext = HookContext &
  z.infer<typeof agentSelectionEnrichmentSchema>;

/** Input context for the "save-agent" hook — carries selectedAgent from agent-selection. */
export type SaveAgentHookInput = HookContext & z.infer<typeof saveAgentEnrichmentSchema>;

/** Input context for "init" -- carries requiredScripts collected from before-ready results. */
export type InitHookContext = HookContext & z.infer<typeof initEnrichmentSchema>;

/** Input context for "check-deps". Agent modules use their own isActive flag. */
export type CheckDepsHookContext = HookContext & z.infer<typeof checkDepsEnrichmentSchema>;

/**
 * Input context for the "error" hook point. Carries the fatal error and the
 * phase it occurred in. Run inside execute()'s catch — awaited, so a handler can
 * report + flush — before the operation re-throws to the composition root, which
 * shows the native failure box and quits.
 */
export type AppStartErrorHookContext = HookContext & z.infer<typeof appStartErrorEnrichmentSchema>;

// ActivateHookContext removed — ports are now read from capabilities within the "start" hook point.

/** Merged check results produced by runChecks(). */
interface CheckResult {
  readonly needsSetup: boolean;
  readonly needsBinaryDownload: boolean;
  readonly missingBinaries: readonly BinaryType[];
  readonly needsExtensions: boolean;
  readonly extensionInstallPlan: readonly ExtensionInstallEntry[];
}

// =============================================================================
// Operation
// =============================================================================

export class AppStartOperation implements Operation<typeof schemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = schemas;

  constructor(
    private readonly agentConfig: PersistedAccessor<AgentType>,
    /** Whether config.json existed at load; false = first run → agent selection. */
    private readonly wasConfigured: () => boolean
  ) {}

  async execute(ctx: OperationContext<AppStartIntent, typeof schemas>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Track the current phase so a fatal failure can be attributed to it in the
    // startup report (crash_source: "startup"). The catch runs the "error" hook —
    // awaited, so its handler can capture + flush — before re-throwing to the
    // composition root, which shows the native failure box and quits.
    let phase: AppStartPhase = "before-ready";
    try {
      // --- Hook 1: "before-ready" (pre-ready) ---
      // Script declarations, noAsar, data paths, electron flags. All independent.
      phase = "before-ready";
      const { results: configResults, errors: configErrors } = await ctx.hooks.collect(
        "before-ready",
        hookCtx
      );
      throwHookErrors(configErrors, "app:start before-ready hooks failed");
      const requiredScripts = configResults.flatMap((r) => r.scripts ?? []);

      // --- Hook 2: "init" ---
      // Electron lifecycle module provides "app-ready" capability after whenReady().
      // Handlers needing Electron declare requires: { "app-ready": ANY_VALUE }.
      // Receives requiredScripts from before-ready results.
      phase = "init";
      const initCtx: InitHookContext = { ...hookCtx, requiredScripts };
      const { results: initResults, errors: initErrors } = await ctx.hooks.collect("init", initCtx);
      throwHookErrors(initErrors, "app:start init hooks failed");

      // Extract extensionRequirements from init results
      const extensionRequirements: ExtensionRequirement[] = [];
      for (const result of initResults) {
        if (result.extensionRequirements)
          extensionRequirements.push(...result.extensionRequirements);
      }

      // On first run (no config.json yet) the agent is treated as "not chosen":
      // null drives the agent-selection hook points below. The `agent` config key is
      // non-nullable (it defaults to "claude"), so file existence — not the value —
      // is what distinguishes "never chosen" from "chose Claude".
      const configuredAgent: AgentType | null = this.wasConfigured()
        ? this.agentConfig.get()
        : null;

      // Hook 3: "show-ui" -- Show starting screen; learn whether a retry loop is supported.
      phase = "show-ui";
      const { results: showUiResults, errors: showUiErrors } = await ctx.hooks.collect(
        "show-ui",
        hookCtx
      );
      throwHookErrors(showUiErrors, "app:start show-ui hooks failed");
      const retrySupported = showUiResults.some((r) => r.retrySupported === true);

      // Hook 4: agent selection (first run only) -- register-agents, agent-selection, save-agent.
      // Runs BEFORE check-deps so the deps check knows which agent's binary to look for.
      let agent: AgentType;
      if (configuredAgent === null) {
        phase = "agent-selection";
        agent = await this.selectAgent(ctx, hookCtx, retrySupported);
      } else {
        agent = configuredAgent;
      }

      // Hook 5: "check-deps" (collect, isolated contexts)
      phase = "check-deps";
      let checkResult = await this.runChecks(ctx, agent, extensionRequirements);

      // Dispatch app:setup if needed (blocking sub-operation)
      // Setup manages its own UI (shows/hides setup screen)
      // Retry loop: if setup fails and retry is supported, wait via the await-retry hook
      if (checkResult.needsSetup) {
        phase = "setup";
        let setupComplete = false;
        while (!setupComplete) {
          try {
            await ctx.dispatch({
              type: INTENT_SETUP,
              payload: {
                needsBinaryDownload: checkResult.needsBinaryDownload,
                missingBinaries: checkResult.missingBinaries,
                needsExtensions: checkResult.needsExtensions,
                extensionInstallPlan: checkResult.extensionInstallPlan,
                configuredAgent: agent,
              },
            });
            setupComplete = true;
          } catch (setupError) {
            // Setup failed -- error event already emitted by SetupOperation
            // If retry is supported, wait for user to click retry. The "await-retry"
            // hook point blocks (host-side, in the UI handler) until the user clicks
            // Retry and returns data — no closure crosses the hook contract.
            if (retrySupported) {
              const { errors: retryErrors } = await ctx.hooks.collect("await-retry", hookCtx);
              throwHookErrors(retryErrors, "app:start await-retry hooks failed");
              // Re-run check hooks to get fresh preflight state for retry
              checkResult = await this.runChecks(ctx, agent, extensionRequirements);
              if (!checkResult.needsSetup) {
                setupComplete = true;
              }
              // Otherwise loop continues to retry app:setup
            } else {
              // No retry support -- propagate the error with original cause
              throw new Error("Setup failed and no retry mechanism available", {
                cause: setupError,
              });
            }
          }
        }
      }

      // Hook 5: "start" -- Start servers, wire callbacks, mount renderer
      // Handlers that need ports (mcpPort, ideServerPort) declare `requires` and
      // read from ctx.capabilities. Capability-based ordering replaces the former
      // separate "activate" hook point.
      phase = "start";
      const { errors: startErrors } = await ctx.hooks.collect("start", hookCtx);
      throwHookErrors(startErrors, "app:start start hooks failed");

      // After all start handlers (IDE server included) are up, load initial projects.
      // Fire-and-forget: the snapshot stream carries the result, so startup must not
      // block on projects finishing. (Operation owns this dispatch; the presentation
      // start handler only advances the UI phase.)
      const readyHandle = ctx.dispatch<AppReadyIntent>({
        type: INTENT_APP_READY,
        payload: {},
      });
      void readyHandle.catch(() => {
        // app:ready failures surface via its own events/logging; don't fail startup.
      });
    } catch (error) {
      // Fatal startup failure. Run the "error" hook so the failure is captured and
      // flushed (hook collection is awaited, unlike fire-and-forget events) before
      // we re-throw. collect() never throws — it swallows handler errors — so the
      // ORIGINAL error is what propagates, leaving the composition root's native
      // box + app.quit path unchanged.
      const errorCtx: AppStartErrorHookContext = {
        intent: ctx.intent,
        error: toSerializedError(error),
        phase,
      };
      await ctx.hooks.collect(APP_START_ERROR_HOOK, errorCtx);
      throw error;
    }
  }

  /**
   * First-run agent selection: collect the selectable agents, show the picker, persist
   * the choice. Wrapped in the same retry loop app:setup uses, so a failed or cancelled
   * pick re-prompts rather than killing startup (when the UI can host a retry).
   *
   * Nothing is persisted unless the user actually picks: if the picker rejects (e.g.
   * app:shutdown during selection), save-agent never runs and the next launch re-prompts.
   */
  private async selectAgent(
    ctx: OperationContext<AppStartIntent, typeof schemas>,
    hookCtx: HookContext,
    retrySupported: boolean
  ): Promise<AgentType> {
    for (;;) {
      try {
        const { results: agentInfos, errors: registerErrors } = await ctx.hooks.collect(
          "register-agents",
          hookCtx
        );
        throwHookErrors(registerErrors, "app:start register-agents hooks failed");

        const selectionCtx: AgentSelectionHookContext = { ...hookCtx, availableAgents: agentInfos };
        const { results: agentResults, errors: agentErrors } = await ctx.hooks.collect(
          "agent-selection",
          selectionCtx
        );
        throwHookErrors(agentErrors, "app:start agent-selection hooks failed");

        // Single result-producer (the picker); results[0] is the chosen agent.
        const selectedAgent = agentResults[0];
        if (selectedAgent === undefined) {
          throw new Error("app:start agent-selection produced no agent");
        }

        const saveAgentInput: SaveAgentHookInput = { intent: ctx.intent, selectedAgent };
        const { errors: saveErrors } = await ctx.hooks.collect("save-agent", saveAgentInput);
        throwHookErrors(saveErrors, "app:start save-agent hooks failed");

        return selectedAgent;
      } catch (selectionError) {
        if (!retrySupported) {
          throw new Error("Agent selection failed and no retry mechanism available", {
            cause: selectionError,
          });
        }
        const { errors: retryErrors } = await ctx.hooks.collect("await-retry", hookCtx);
        throwHookErrors(retryErrors, "app:start await-retry hooks failed");
      }
    }
  }

  /**
   * Run check-deps hook point using collect() (isolated contexts).
   * Merges results and derives boolean flags.
   *
   * `agent` is non-null: selection has already happened. Agent modules only report
   * their own missing binary when they are the configured agent, so calling this with
   * a null agent would silently produce an empty binary list.
   */
  private async runChecks(
    ctx: OperationContext<AppStartIntent, typeof schemas>,
    configuredAgent: AgentType,
    extensionRequirements: readonly ExtensionRequirement[]
  ): Promise<CheckResult> {
    // check-deps: binary + extension checks (collect, isolated contexts)
    const depsCtx: CheckDepsHookContext = {
      intent: ctx.intent,
      configuredAgent,
      extensionRequirements,
    };
    const { results: depsResults, errors: depsErrors } = await ctx.hooks.collect(
      "check-deps",
      depsCtx
    );
    throwHookErrors(depsErrors, "check-deps hooks failed");

    // Merge dep results (concatenate arrays from all handlers)
    const missingBinaries: BinaryType[] = [];
    const extensionInstallPlan: ExtensionInstallEntry[] = [];

    for (const result of depsResults) {
      if (result.missingBinaries) missingBinaries.push(...result.missingBinaries);
      if (result.extensionInstallPlan) extensionInstallPlan.push(...result.extensionInstallPlan);
    }

    // Derive booleans (dissolved from needsSetupModule)
    const needsBinaryDownload = missingBinaries.length > 0;
    const needsExtensions = extensionInstallPlan.length > 0;
    const needsSetup = needsBinaryDownload || needsExtensions;

    return {
      needsSetup,
      needsBinaryDownload,
      missingBinaries,
      needsExtensions,
      extensionInstallPlan,
    };
  }
}
