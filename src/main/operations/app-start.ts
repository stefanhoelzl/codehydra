/**
 * AppStartOperation - Orchestrates application startup.
 *
 * Runs hook points in sequence:
 * 1. "before-ready" - Collect script declarations, read env config (no I/O)
 * 2. "await-ready" - Wait for Electron ready event
 * 3. "init" - Post-ready initialization (config file, logging, shell, scripts)
 * 4. "show-ui" - Show starting screen
 * 5. "check-deps" - Check binaries and extensions (collect, isolated contexts)
 * 6. "start" - Start servers, wire services, mount renderer.
 *              Handlers that need ports (mcpPort, codeServerPort) declare
 *              `requires` and read from ctx.capabilities. Capability-based
 *              ordering replaces the former separate "activate" hook point.
 *
 * After "start", the renderer signals ready via lifecycle.ready IPC,
 * which dispatches app:ready to load initial projects (see app-ready.ts).
 *
 * The "check-deps" hook point uses collect() for isolated handler contexts.
 * Each handler returns a typed result; the operation merges results and
 * derives boolean flags (needsSetup, needsBinaryDownload, etc.).
 *
 * `configuredAgent` is obtained from config module's "init" result,
 * eliminating the separate "check-config" hook point.
 *
 * If checks determine setup is needed, dispatches app:setup as a blocking
 * sub-operation. Setup manages its own UI (shows/hides setup screen).
 *
 * Aborts on error in any hook. Services that are optional must handle
 * their own errors internally (e.g., PluginServer graceful degradation in
 * CodeServerModule).
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ConfigAgentType } from "../../shared/api/types";
import type {
  BinaryType,
  ExtensionRequirement,
  ExtensionInstallEntry,
} from "../../services/vscode-setup/types";
import type { ConfigKeyDefinition } from "../../services/config/config-definition";
import { INTENT_SETUP } from "./setup";
import { INTENT_UPDATE_APPLY } from "./update-apply";

// =============================================================================
// Intent Types
// =============================================================================

export interface AppStartPayload {
  /** No payload needed - startup configuration comes from module closures. */
  readonly [key: string]: never;
}

export interface AppStartIntent extends Intent<void> {
  readonly type: "app:start";
  readonly payload: AppStartPayload;
}

export const INTENT_APP_START = "app:start" as const;

// =============================================================================
// Hook Context & Result Types
// =============================================================================

export const APP_START_OPERATION_ID = "app-start";

/** Input context for "check-deps". Agent modules use their own isActive flag. */
export interface CheckDepsHookContext extends HookContext {
  readonly configuredAgent: ConfigAgentType | null;
  readonly extensionRequirements: readonly ExtensionRequirement[];
}

/** Per-handler result for "check-deps" hook point. Arrays only -- booleans derived by operation. */
export interface CheckDepsResult {
  readonly missingBinaries?: readonly BinaryType[];
  readonly extensionInstallPlan?: readonly ExtensionInstallEntry[];
  /** True when auto-update config is "ask" and an update was detected. */
  readonly updateNeedsChoice?: boolean;
}

/**
 * Per-handler result for "register-config" hook point.
 * Modules return their config key definitions.
 */
export interface RegisterConfigResult {
  readonly definitions?: readonly ConfigKeyDefinition<unknown>[];
}

/**
 * Input context for "before-ready" — carries config definitions collected from register-config.
 */
export interface BeforeReadyHookContext extends HookContext {
  readonly configDefinitions: readonly ConfigKeyDefinition<unknown>[];
}

/**
 * Per-handler result for "before-ready" hook point.
 * Returns optional script declarations to be copied to bin directory.
 */
export interface ConfigureResult {
  readonly scripts?: readonly string[];
}

/** Input context for "init" -- carries requiredScripts collected from before-ready results. */
export interface InitHookContext extends HookContext {
  readonly requiredScripts: readonly string[];
}

/**
 * Per-handler result for "init" hook point.
 * Config module returns configuredAgent; extension module returns extensionRequirements.
 * Other init handlers return `{}`.
 */
export interface InitResult {
  readonly configuredAgent?: ConfigAgentType | null;
  readonly extensionRequirements?: readonly ExtensionRequirement[];
}

/**
 * Per-handler result for "show-ui" hook point.
 * Only the retry module returns a value; UI module returns void.
 */
export interface ShowUIHookResult {
  readonly waitForRetry?: () => Promise<void>;
}

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
  readonly updateNeedsChoice: boolean;
}

// =============================================================================
// Operation
// =============================================================================

export class AppStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // --- Hook 0: "register-config" — collect config definitions from all modules ---
    const { results: regResults, errors: regErrors } =
      await ctx.hooks.collect<RegisterConfigResult>("register-config", hookCtx);
    if (regErrors.length > 0) throw regErrors[0]!;
    const configDefinitions = regResults.flatMap((r) => r.definitions ?? []);

    // --- Hook 1: "before-ready" (pre-ready, no I/O) ---
    // Env config + script declarations. All independent.
    const beforeReadyCtx: BeforeReadyHookContext = { ...hookCtx, configDefinitions };
    const { results: configResults, errors: configErrors } =
      await ctx.hooks.collect<ConfigureResult>("before-ready", beforeReadyCtx);
    if (configErrors.length > 0) throw configErrors[0]!;
    const requiredScripts = configResults.flatMap((r) => r.scripts ?? []);

    // --- Hook 2: "await-ready" ---
    // Module provides app.whenReady(). Decouples operation from Electron.
    const { errors: readyErrors } = await ctx.hooks.collect<void>("await-ready", hookCtx);
    if (readyErrors.length > 0) throw readyErrors[0]!;

    // --- Hook 3: "init" (post-ready) ---
    // All independent. Receives requiredScripts from before-ready results.
    // Config module returns configuredAgent in its init result.
    const initCtx: InitHookContext = { ...hookCtx, requiredScripts };
    const { results: initResults, errors: initErrors } = await ctx.hooks.collect<InitResult>(
      "init",
      initCtx
    );
    if (initErrors.length > 0) throw initErrors[0]!;

    // Extract configuredAgent and extensionRequirements from init results
    let configuredAgent: ConfigAgentType | null = null;
    const extensionRequirements: ExtensionRequirement[] = [];
    for (const result of initResults) {
      if (result.configuredAgent !== undefined) configuredAgent = result.configuredAgent;
      if (result.extensionRequirements) extensionRequirements.push(...result.extensionRequirements);
    }

    // Hook 4: "show-ui" -- Show starting screen, capture waitForRetry
    const { results: showUiResults, errors: showUiErrors } =
      await ctx.hooks.collect<ShowUIHookResult>("show-ui", hookCtx);
    if (showUiErrors.length > 0) {
      throw showUiErrors[0]!;
    }
    let waitForRetry: (() => Promise<void>) | undefined;
    for (const result of showUiResults) {
      if (result.waitForRetry !== undefined) waitForRetry = result.waitForRetry;
    }

    // Hook 5: "check-deps" (collect, isolated contexts)
    let checkResult = await this.runChecks(ctx, configuredAgent, extensionRequirements);

    // Dispatch app:update before setup (interceptor rejects if config="never" or no update)
    try {
      await ctx.dispatch({
        type: INTENT_UPDATE_APPLY,
        payload: { needsChoice: checkResult.updateNeedsChoice ?? false },
      });
    } catch {
      // Update rejected by interceptor or failed — non-fatal, continue startup
    }

    // Dispatch app:setup if needed (blocking sub-operation)
    // Setup manages its own UI (shows/hides setup screen)
    // Retry loop: if setup fails and waitForRetry is available, wait for user retry signal
    if (checkResult.needsSetup) {
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
        } catch (error) {
          // Setup failed -- error event already emitted by SetupOperation
          // If retry is supported, wait for user to click retry
          if (waitForRetry) {
            await waitForRetry();
            // Re-run check hooks to get fresh preflight state for retry
            checkResult = await this.runChecks(ctx, configuredAgent, extensionRequirements);
            if (!checkResult.needsSetup) {
              setupComplete = true;
            }
            // Otherwise loop continues to retry app:setup
          } else {
            // No retry support -- propagate the error with original cause
            throw new Error("Setup failed and no retry mechanism available", { cause: error });
          }
        }
      }
    }

    // Hook 6: "start" -- Start servers, wire callbacks, mount renderer
    // Handlers that need ports (mcpPort, codeServerPort) declare `requires` and
    // read from ctx.capabilities. Capability-based ordering replaces the former
    // separate "activate" hook point.
    const { errors: startErrors } = await ctx.hooks.collect<void>("start", hookCtx);
    if (startErrors.length > 0) {
      throw startErrors[0]!;
    }
  }

  /**
   * Run check-deps hook point using collect() (isolated contexts).
   * Merges results and derives boolean flags.
   * configuredAgent and extensionRequirements are provided by the caller
   * (from init results).
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
    if (depsErrors.length > 0) {
      throw new AggregateError(depsErrors, "check-deps hooks failed");
    }

    // Merge dep results (concatenate arrays from all handlers)
    const missingBinaries: BinaryType[] = [];
    const extensionInstallPlan: ExtensionInstallEntry[] = [];
    let updateNeedsChoice = false;

    for (const result of depsResults) {
      if (result.missingBinaries) missingBinaries.push(...result.missingBinaries);
      if (result.extensionInstallPlan) extensionInstallPlan.push(...result.extensionInstallPlan);
      if (result.updateNeedsChoice) updateNeedsChoice = true;
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
      updateNeedsChoice,
    };
  }
}
