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
 * Extended hook context for app:start.
 *
 * Fields are populated by hook modules across the shared-context hook points:
 * - "show-ui": (no fields, sends IPC to show starting screen)
 * - "wire": (no fields, wires services)
 * - "start": codeServerPort, mcpPort
 * - "activate": projectPaths (modules read context set by start hook)
 * - "finalize": (post-project-load actions, e.g. show main view)
 *
 * Check fields (configuredAgent, missingBinaries, etc.) are NOT on this context.
 * They flow through isolated collect() hook points (check-config, check-deps)
 * and are merged by the operation into a CheckResult.
 */
export interface AppStartHookContext extends HookContext {
  // Start hook fields
  /** Set by CodeServerModule (start hook) -- consumed by activate hook modules. */
  codeServerPort?: number;
  /** Set by McpModule (start hook) -- consumed by activate hook modules. */
  mcpPort?: number;

  // Activate hook fields
  /** Set by DataLifecycleModule (activate hook): saved project paths to open */
  projectPaths?: readonly string[];

  // Retry support
  /**
   * Set by RetryModule: returns a promise that resolves when the user clicks retry.
   * Used by the operation to wait for user action before re-dispatching app:setup.
   */
  waitForRetry?: () => Promise<void>;
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
    const hookCtx: AppStartHookContext = {
      intent: ctx.intent,
    };

    // Hook 1: "show-ui" -- Show starting screen
    await ctx.hooks.run("show-ui", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
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
          if (hookCtx.waitForRetry) {
            await hookCtx.waitForRetry();
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
    await ctx.hooks.run("wire", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Hook 5: "start" -- Start servers and wire services
    await ctx.hooks.run("start", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Hook 6: "activate" -- Wire callbacks, gather project paths
    await ctx.hooks.run("activate", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Dispatch project:open for each saved project (best-effort).
    // Each project:open dispatches workspace:create + workspace:switch internally.
    for (const projectPath of hookCtx.projectPaths ?? []) {
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
    await ctx.hooks.run("finalize", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
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

    const configuredAgent = configResults[0]?.configuredAgent ?? null;

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
