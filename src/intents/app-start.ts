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
 * 4. "check-deps" - Check binaries and extensions (collect, isolated contexts)
 * 5. "start" - Start servers, wire services, mount renderer.
 *              Handlers that need ports (mcpPort, ideServerPort) declare
 *              `requires` and read from ctx.capabilities. Capability-based
 *              ordering replaces the former separate "activate" hook point.
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
 * The "start" and "await-retry" hook points return void (no schema). `BinaryType` is a shared
 * binary-resolution type modeled with `z.custom` so its exact named type flows through.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { configAgentTypeSchema, hookCtxSchema } from "./contract";
import type { ConfigAgentType } from "../shared/api/types";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { BinaryType } from "../utils/binary-resolution/types";
import { INTENT_SETUP } from "./setup";
import { INTENT_APP_READY, type AppReadyIntent } from "./app-ready";
import { throwHookErrors } from "./lib/hook-helpers";

/** Re-exported for use by operation integration tests (avoids direct service import). */
export type { BinaryType } from "../utils/binary-resolution/types";

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
  "check-deps",
  "setup",
  "start",
]);

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
    missingBinaries: z.array(z.custom<BinaryType>()).readonly().optional(),
    extensionInstallPlan: z.array(extensionInstallEntrySchema).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for "init" -- carries requiredScripts from before-ready results. */
const initEnrichmentSchema = z.object({
  requiredScripts: z.array(z.string()).readonly(),
});
const initHookInputSchema = hookCtxSchema(appStartPayloadSchema, initEnrichmentSchema.shape);

/** Operation-added enrichment for "check-deps". Agent modules use their own isActive flag. */
const checkDepsEnrichmentSchema = z.object({
  configuredAgent: configAgentTypeSchema.nullable(),
  extensionRequirements: z.array(extensionRequirementSchema).readonly(),
});
const checkDepsHookInputSchema = hookCtxSchema(
  appStartPayloadSchema,
  checkDepsEnrichmentSchema.shape
);

/**
 * Operation-added enrichment for the "error" hook point. Carries the live fatal error
 * (a real Error instance — host-only) and the phase it occurred in.
 */
const appStartErrorEnrichmentSchema = z.object({
  error: z.instanceof(Error),
  phase: appStartPhaseSchema,
});
const appStartErrorHookInputSchema = hookCtxSchema(
  appStartPayloadSchema,
  appStartErrorEnrichmentSchema.shape
);

const schemas = {
  type: INTENT_APP_START,
  payload: appStartPayloadSchema,
  hooks: {
    "before-ready": { result: configureResultSchema },
    init: { input: initHookInputSchema, result: initResultSchema },
    "show-ui": { result: showUIHookResultSchema },
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
  readonly configuredAgent: ConfigAgentType | null;
  readonly needsAgentSelection: boolean;
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
    private readonly agentConfig: PersistedAccessor<ConfigAgentType>,
    /** Whether config.json existed at load; false = first run → agent selection. */
    private readonly wasConfigured: () => boolean
  ) {}

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
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
      const { results: configResults, errors: configErrors } =
        await ctx.hooks.collect<ConfigureResult>("before-ready", hookCtx);
      throwHookErrors(configErrors, "app:start before-ready hooks failed");
      const requiredScripts = configResults.flatMap((r) => r.scripts ?? []);

      // --- Hook 2: "init" ---
      // Electron lifecycle module provides "app-ready" capability after whenReady().
      // Handlers needing Electron declare requires: { "app-ready": ANY_VALUE }.
      // Receives requiredScripts from before-ready results.
      phase = "init";
      const initCtx: InitHookContext = { ...hookCtx, requiredScripts };
      const { results: initResults, errors: initErrors } = await ctx.hooks.collect<InitResult>(
        "init",
        initCtx
      );
      throwHookErrors(initErrors, "app:start init hooks failed");

      // Extract extensionRequirements from init results
      const extensionRequirements: ExtensionRequirement[] = [];
      for (const result of initResults) {
        if (result.extensionRequirements)
          extensionRequirements.push(...result.extensionRequirements);
      }

      // On first run (no config.json yet) the agent is treated as "not chosen":
      // null defers binary checks and drives needsAgentSelection, exactly as a null
      // agent value used to. Once configured, the real (non-null) agent is used.
      const configuredAgent: ConfigAgentType | null = this.wasConfigured()
        ? this.agentConfig.get()
        : null;

      // Hook 3: "show-ui" -- Show starting screen; learn whether a retry loop is supported.
      phase = "show-ui";
      const { results: showUiResults, errors: showUiErrors } =
        await ctx.hooks.collect<ShowUIHookResult>("show-ui", hookCtx);
      throwHookErrors(showUiErrors, "app:start show-ui hooks failed");
      const retrySupported = showUiResults.some((r) => r.retrySupported === true);

      // Hook 4: "check-deps" (collect, isolated contexts)
      phase = "check-deps";
      let checkResult = await this.runChecks(ctx, configuredAgent, extensionRequirements);

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
                needsAgentSelection: checkResult.needsAgentSelection,
                needsBinaryDownload: checkResult.needsBinaryDownload,
                missingBinaries: checkResult.missingBinaries,
                needsExtensions: checkResult.needsExtensions,
                extensionInstallPlan: checkResult.extensionInstallPlan,
                configuredAgent: checkResult.configuredAgent,
              },
            });
            setupComplete = true;
          } catch (setupError) {
            // Setup failed -- error event already emitted by SetupOperation
            // If retry is supported, wait for user to click retry. The "await-retry"
            // hook point blocks (host-side, in the UI handler) until the user clicks
            // Retry and returns data — no closure crosses the hook contract.
            if (retrySupported) {
              const { errors: retryErrors } = await ctx.hooks.collect<void>("await-retry", hookCtx);
              throwHookErrors(retryErrors, "app:start await-retry hooks failed");
              // Re-run check hooks to get fresh preflight state for retry
              checkResult = await this.runChecks(ctx, configuredAgent, extensionRequirements);
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
      const { errors: startErrors } = await ctx.hooks.collect<void>("start", hookCtx);
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
        error: error instanceof Error ? error : new Error(String(error)),
        phase,
      };
      await ctx.hooks.collect(APP_START_ERROR_HOOK, errorCtx);
      throw error;
    }
  }

  /**
   * Run check-deps hook point using collect() (isolated contexts).
   * Merges results and derives boolean flags.
   */
  private async runChecks(
    ctx: OperationContext<AppStartIntent>,
    configuredAgent: ConfigAgentType | null,
    extensionRequirements: readonly ExtensionRequirement[]
  ): Promise<CheckResult> {
    // check-deps: binary + extension checks (collect, isolated contexts)
    const depsCtx: CheckDepsHookContext = {
      intent: ctx.intent,
      configuredAgent,
      extensionRequirements,
    };
    const { results: depsResults, errors: depsErrors } = await ctx.hooks.collect<CheckDepsResult>(
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
    const needsAgentSelection = configuredAgent === null;
    const needsBinaryDownload = missingBinaries.length > 0;
    const needsExtensions = extensionInstallPlan.length > 0;
    const needsSetup = needsAgentSelection || needsBinaryDownload || needsExtensions;

    return {
      needsSetup,
      configuredAgent,
      needsAgentSelection,
      needsBinaryDownload,
      missingBinaries,
      needsExtensions,
      extensionInstallPlan,
    };
  }
}
