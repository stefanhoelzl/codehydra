/**
 * AppStartOperation - Orchestrates application startup.
 *
 * Runs six hook points in sequence:
 * 1. "show-ui" - Show starting screen
 * 2. "check" - Check if setup is needed (agent, binaries, extensions)
 * 3. "wire" - Wire services (after setup completes if dispatched)
 * 4. "start" - Start servers and wire services (CodeServer, Agent, Badge, MCP,
 *              Telemetry, AutoUpdater, IpcBridge)
 * 5. "activate" - Wire callbacks, gather project paths (Data, View)
 * 6. "finalize" - Post-project-load actions (show main view)
 *
 * Between "activate" and "finalize", dispatches project:open for each saved
 * project path (best-effort, skips invalid projects).
 *
 * If check hooks determine setup is needed, dispatches app:setup as a blocking
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
// Hook Context
// =============================================================================

export const APP_START_OPERATION_ID = "app-start";

/**
 * Extended hook context for app:start.
 *
 * Fields are populated by hook modules across the six hook points:
 * - "show-ui": (no fields, sends IPC to show starting screen)
 * - "check": needsSetup, needsAgentSelection, needsBinaryDownload, needsExtensions, configuredAgent
 * - "wire": (no fields, wires services)
 * - "start": codeServerPort, mcpPort
 * - "activate": projectPaths (modules read context set by start hook)
 * - "finalize": (post-project-load actions, e.g. show main view)
 */
export interface AppStartHookContext extends HookContext {
  // Check hook fields
  /** Set by check hooks: true if any setup is needed */
  needsSetup?: boolean;
  /** Set by ConfigCheckModule: true if agent not selected in config */
  needsAgentSelection?: boolean;
  /** Set by BinaryPreflightModule: true if any binaries need download */
  needsBinaryDownload?: boolean;
  /** Set by BinaryPreflightModule: list of binaries that need download */
  missingBinaries?: readonly BinaryType[];
  /** Set by ExtensionPreflightModule: true if any extensions need install */
  needsExtensions?: boolean;
  /** Set by ExtensionPreflightModule: list of extensions that need install */
  missingExtensions?: readonly string[];
  /** Set by ExtensionPreflightModule: list of extensions that need update */
  outdatedExtensions?: readonly string[];
  /** Set by ConfigCheckModule: currently configured agent (may be null) */
  configuredAgent?: ConfigAgentType | null;

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

    // Hook 2: "check" -- Check if setup is needed
    await ctx.hooks.run("check", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Dispatch app:setup if needed (blocking sub-operation)
    // Setup manages its own UI (shows/hides setup screen)
    // Retry loop: if setup fails and waitForRetry is available, wait for user retry signal
    if (hookCtx.needsSetup) {
      let setupComplete = false;
      while (!setupComplete) {
        try {
          await ctx.dispatch(
            {
              type: INTENT_SETUP,
              payload: {
                needsAgentSelection: hookCtx.needsAgentSelection,
                needsBinaryDownload: hookCtx.needsBinaryDownload,
                missingBinaries: hookCtx.missingBinaries,
                needsExtensions: hookCtx.needsExtensions,
                missingExtensions: hookCtx.missingExtensions,
                outdatedExtensions: hookCtx.outdatedExtensions,
                configuredAgent: hookCtx.configuredAgent,
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
            delete hookCtx.needsSetup;
            delete hookCtx.needsAgentSelection;
            delete hookCtx.needsBinaryDownload;
            delete hookCtx.missingBinaries;
            delete hookCtx.needsExtensions;
            delete hookCtx.missingExtensions;
            delete hookCtx.outdatedExtensions;
            delete hookCtx.error;
            await ctx.hooks.run("check", hookCtx);
            if (hookCtx.error) {
              throw hookCtx.error;
            }
            // If no longer needs setup after re-check, break out
            if (!hookCtx.needsSetup) {
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

    // Hook 3: "wire" -- Wire services (after setup completes)
    await ctx.hooks.run("wire", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Hook 4: "start" -- Start servers and wire services
    await ctx.hooks.run("start", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Hook 5: "activate" -- Wire callbacks, gather project paths
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

    // Hook 6: "finalize" -- Post-project-load actions (show main view)
    await ctx.hooks.run("finalize", hookCtx);
    if (hookCtx.error) {
      throw hookCtx.error;
    }
  }
}
