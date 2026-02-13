/**
 * AppStartOperation - Orchestrates application startup.
 *
 * Runs hook points in sequence:
 * 1. "show-ui" - Show starting screen
 * 2. "check-config" - Load configuration (collect, isolated contexts)
 * 3. "check-deps" - Check binaries and extensions (collect, isolated contexts)
 * 4. "wire" - Wire services (after setup completes if dispatched)
 * 5. "start" - Start servers and wire services (CodeServer, Agent, Badge, MCP,
 *              Telemetry, AutoUpdater, IpcBridge)
 * 6. "activate" - Wire callbacks, gather project paths (Data, View)
 * 7. "finalize" - Post-project-load actions (show main view)
 *
 * Between "activate" and "finalize", dispatches project:open for each saved
 * project path (best-effort, skips invalid projects).
 *
 * The "check-config" and "check-deps" hook points use collect() for isolated
 * handler contexts. Each handler returns a typed result; the operation merges
 * results and derives boolean flags (needsSetup, needsBinaryDownload, etc.).
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
import type { BinaryType } from "../../services/vscode-setup/types";
import { INTENT_SETUP } from "./setup";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "./open-project";
import { Path } from "../../services/platform/path";

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

/** Per-handler result for "check-config" hook point. Returns just configuredAgent. */
export interface CheckConfigResult {
  readonly configuredAgent: ConfigAgentType | null;
}

/** Input context for "check-deps" -- carries configuredAgent from check-config. */
export interface CheckDepsHookContext extends HookContext {
  readonly configuredAgent: ConfigAgentType | null;
}

/** Per-handler result for "check-deps" hook point. Arrays only -- booleans derived by operation. */
export interface CheckDepsResult {
  readonly missingBinaries?: readonly BinaryType[];
  readonly missingExtensions?: readonly string[];
  readonly outdatedExtensions?: readonly string[];
}

/**
 * Per-handler result for "show-ui" hook point.
 * Only the retry module returns a value; UI module returns void.
 */
export interface ShowUIHookResult {
  readonly waitForRetry?: () => Promise<void>;
}

/**
 * Per-handler result for "start" hook point.
 * CodeServerModule returns codeServerPort; McpModule returns mcpPort.
 * Side-effect handlers return `{}`.
 */
export interface StartHookResult {
  readonly codeServerPort?: number;
  readonly mcpPort?: number;
}

/**
 * Input context for "activate" hook -- carries ports from start results.
 */
export interface ActivateHookInput extends HookContext {
  readonly codeServerPort?: number;
  readonly mcpPort?: number;
}

/**
 * Per-handler result for "activate" hook point.
 * DataLifecycleModule returns projectPaths; others return `{}`.
 */
export interface ActivateHookResult {
  readonly projectPaths?: readonly string[];
}

/** Merged check results produced by runChecks(). */
interface CheckResult {
  readonly needsSetup: boolean;
  readonly configuredAgent: ConfigAgentType | null;
  readonly needsAgentSelection: boolean;
  readonly needsBinaryDownload: boolean;
  readonly missingBinaries: readonly BinaryType[];
  readonly needsExtensions: boolean;
  readonly missingExtensions: readonly string[];
  readonly outdatedExtensions: readonly string[];
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

    // Hook 1: "show-ui" -- Show starting screen, capture waitForRetry
    const { results: showUiResults, errors: showUiErrors } =
      await ctx.hooks.collect<ShowUIHookResult>("show-ui", hookCtx);
    if (showUiErrors.length > 0) {
      throw showUiErrors[0]!;
    }
    let waitForRetry: (() => Promise<void>) | undefined;
    for (const result of showUiResults) {
      if (result.waitForRetry !== undefined) waitForRetry = result.waitForRetry;
    }

    // Hooks 2-3: "check-config" + "check-deps" (collect, isolated contexts)
    let checkResult = await this.runChecks(ctx);

    // Dispatch app:setup if needed (blocking sub-operation)
    // Setup manages its own UI (shows/hides setup screen)
    // Retry loop: if setup fails and waitForRetry is available, wait for user retry signal
    if (checkResult.needsSetup) {
      let setupComplete = false;
      while (!setupComplete) {
        try {
          await ctx.dispatch(
            {
              type: INTENT_SETUP,
              payload: {
                needsAgentSelection: checkResult.needsAgentSelection,
                needsBinaryDownload: checkResult.needsBinaryDownload,
                missingBinaries: checkResult.missingBinaries,
                needsExtensions: checkResult.needsExtensions,
                missingExtensions: checkResult.missingExtensions,
                outdatedExtensions: checkResult.outdatedExtensions,
                configuredAgent: checkResult.configuredAgent,
              },
            },
            ctx.causation
          );
          setupComplete = true;
        } catch (error) {
          // Setup failed -- error event already emitted by SetupOperation
          // If retry is supported, wait for user to click retry
          if (waitForRetry) {
            await waitForRetry();
            // Re-run check hooks to get fresh preflight state for retry
            checkResult = await this.runChecks(ctx);
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

    // Hook 4: "wire" -- Wire services (after setup completes)
    const { errors: wireErrors } = await ctx.hooks.collect<void>("wire", hookCtx);
    if (wireErrors.length > 0) {
      throw wireErrors[0]!;
    }

    // Hook 5: "start" -- Start servers and wire services
    const { results: startResults, errors: startErrors } = await ctx.hooks.collect<StartHookResult>(
      "start",
      hookCtx
    );
    if (startErrors.length > 0) {
      throw startErrors[0]!;
    }
    let codeServerPort: number | undefined;
    let mcpPort: number | undefined;
    for (const result of startResults) {
      if (result.codeServerPort !== undefined) codeServerPort = result.codeServerPort;
      if (result.mcpPort !== undefined) mcpPort = result.mcpPort;
    }

    // Hook 6: "activate" -- Wire callbacks, gather project paths
    const activateInput: ActivateHookInput = {
      intent: ctx.intent,
      ...(codeServerPort !== undefined && { codeServerPort }),
      ...(mcpPort !== undefined && { mcpPort }),
    };
    const { results: activateResults, errors: activateErrors } =
      await ctx.hooks.collect<ActivateHookResult>("activate", activateInput);
    if (activateErrors.length > 0) {
      throw activateErrors[0]!;
    }
    const projectPaths: string[] = [];
    for (const result of activateResults) {
      if (result.projectPaths) projectPaths.push(...result.projectPaths);
    }

    // Dispatch project:open for each saved project (best-effort).
    // Each project:open dispatches workspace:create + workspace:switch internally.
    for (const projectPath of projectPaths) {
      try {
        await ctx.dispatch(
          {
            type: INTENT_OPEN_PROJECT,
            payload: { path: new Path(projectPath) },
          } as OpenProjectIntent,
          ctx.causation
        );
      } catch {
        // Skip invalid projects (no longer exist, not git repos, etc.)
      }
    }

    // Hook 7: "finalize" -- Post-project-load actions (show main view)
    const { errors: finalizeErrors } = await ctx.hooks.collect<void>("finalize", hookCtx);
    if (finalizeErrors.length > 0) {
      throw finalizeErrors[0]!;
    }
  }

  /**
   * Run check-config and check-deps hook points using collect() (isolated contexts).
   * Merges results and derives boolean flags.
   */
  private async runChecks(ctx: OperationContext<AppStartIntent>): Promise<CheckResult> {
    // 1. check-config: get agent configuration
    const { results: configResults, errors: configErrors } =
      await ctx.hooks.collect<CheckConfigResult>("check-config", { intent: ctx.intent });
    if (configErrors.length > 0) {
      throw new AggregateError(configErrors, "check-config hooks failed");
    }

    let configuredAgent: ConfigAgentType | null = null;
    for (const result of configResults) {
      if (result.configuredAgent !== undefined) configuredAgent = result.configuredAgent;
    }

    // 2. check-deps: binary + extension checks (collect, isolated contexts)
    const depsCtx: CheckDepsHookContext = { intent: ctx.intent, configuredAgent };
    const { results: depsResults, errors: depsErrors } = await ctx.hooks.collect<CheckDepsResult>(
      "check-deps",
      depsCtx
    );
    if (depsErrors.length > 0) {
      throw new AggregateError(depsErrors, "check-deps hooks failed");
    }

    // Merge dep results (concatenate arrays from all handlers)
    const missingBinaries: BinaryType[] = [];
    const missingExtensions: string[] = [];
    const outdatedExtensions: string[] = [];

    for (const result of depsResults) {
      if (result.missingBinaries) missingBinaries.push(...result.missingBinaries);
      if (result.missingExtensions) missingExtensions.push(...result.missingExtensions);
      if (result.outdatedExtensions) outdatedExtensions.push(...result.outdatedExtensions);
    }

    // Derive booleans (dissolved from needsSetupModule)
    const needsAgentSelection = configuredAgent === null;
    const needsBinaryDownload = missingBinaries.length > 0;
    const needsExtensions = missingExtensions.length > 0 || outdatedExtensions.length > 0;
    const needsSetup = needsAgentSelection || needsBinaryDownload || needsExtensions;

    return {
      needsSetup,
      configuredAgent,
      needsAgentSelection,
      needsBinaryDownload,
      missingBinaries,
      needsExtensions,
      missingExtensions,
      outdatedExtensions,
    };
  }
}
