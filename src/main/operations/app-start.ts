/**
 * AppStartOperation - Orchestrates application service startup.
 *
 * Runs two hook points in sequence:
 * 1. "start" - Start servers and wire services (CodeServer, Agent, Badge, MCP,
 *              Telemetry, AutoUpdater, IpcBridge)
 * 2. "activate" - Load persisted data and activate first workspace (Data, View)
 *
 * Aborts on error in either hook. Services that are optional must handle
 * their own errors internally (e.g., PluginServer graceful degradation in
 * CodeServerModule).
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";

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
 * Fields are populated by hook modules across the two hook points:
 * - "start": codeServerPort, mcpPort
 * - "activate": (modules read context set by start hook)
 */
export interface AppStartHookContext extends HookContext {
  /** Set by CodeServerModule (start hook) -- consumed by activate hook modules. */
  codeServerPort?: number;
  /** Set by McpModule (start hook) -- consumed by activate hook modules. */
  mcpPort?: number;
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

    // Hook 1: "start" -- Start servers and wire services
    await ctx.hooks.run("start", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Hook 2: "activate" -- Load data and activate first workspace
    await ctx.hooks.run("activate", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }
  }
}
