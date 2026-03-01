// @vitest-environment node
/**
 * Integration tests for LoggingModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, InitHookContext, ConfigureResult } from "../operations/app-start";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { createMockLogger } from "../../services/logging";
import { createLoggingModule } from "./logging-module";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "before-ready" and "init" hook points in sequence. */
class MinimalAppStartOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };

    const { errors: beforeReadyErrors } = await ctx.hooks.collect<ConfigureResult>(
      "before-ready",
      hookCtx
    );
    if (beforeReadyErrors.length > 0) throw beforeReadyErrors[0]!;

    const initCtx: InitHookContext = {
      intent: ctx.intent,
      requiredScripts: [],
    };
    const { errors: initErrors } = await ctx.hooks.collect<void>("init", initCtx);
    if (initErrors.length > 0) throw initErrors[0]!;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createDeps() {
  const loggingService = {
    initialize: vi.fn(),
    configure: vi.fn(),
  };
  const registerLogHandlers = vi.fn();
  const buildInfo = {
    version: "2026.2.0-test",
    isDevelopment: true,
    isPackaged: false,
  };
  const platformInfo = {
    platform: "linux" as NodeJS.Platform,
    arch: "x64" as const,
  };
  const logger = createMockLogger();

  return { loggingService, registerLogHandlers, buildInfo, platformInfo, logger };
}

// =============================================================================
// Tests
// =============================================================================

describe("LoggingModule Integration", () => {
  it("logs build and platform info during before-ready hook", async () => {
    const deps = createDeps();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.logger.info).toHaveBeenCalledWith("App starting", {
      version: "2026.2.0-test",
      isDev: true,
      isPackaged: false,
      platform: "linux",
      arch: "x64",
    });
  });

  it("initializes logging service and registers log handlers during init hook", async () => {
    const deps = createDeps();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.loggingService.initialize).toHaveBeenCalledOnce();
    expect(deps.registerLogHandlers).toHaveBeenCalledOnce();
  });

  it("logs startup info before initializing logging service", async () => {
    const deps = createDeps();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    const logOrder = deps.logger.info.mock.invocationCallOrder[0]!;
    const initOrder = deps.loggingService.initialize.mock.invocationCallOrder[0]!;
    expect(logOrder).toBeLessThan(initOrder);
  });

  it("logs all changed config values on config:updated event", () => {
    const deps = createDeps();
    const module = createLoggingModule(deps);

    const handler = module.events![EVENT_CONFIG_UPDATED]!;
    handler({
      type: EVENT_CONFIG_UPDATED,
      payload: { values: { agent: "claude", "log.level": "debug" } },
    } as ConfigUpdatedEvent);

    expect(deps.logger.info).toHaveBeenCalledWith("Config updated", {
      agent: "claude",
      "log.level": "debug",
    });
  });

  it("converts undefined config values to null when logging", () => {
    const deps = createDeps();
    const module = createLoggingModule(deps);

    const handler = module.events![EVENT_CONFIG_UPDATED]!;
    handler({
      type: EVENT_CONFIG_UPDATED,
      payload: { values: { "telemetry.distinct-id": undefined } },
    } as unknown as ConfigUpdatedEvent);

    expect(deps.logger.info).toHaveBeenCalledWith("Config updated", {
      "telemetry.distinct-id": null,
    });
  });

  it("reconfigures logging when log.format changes", () => {
    const deps = createDeps();
    const module = createLoggingModule(deps);

    const handler = module.events![EVENT_CONFIG_UPDATED]!;
    handler({
      type: EVENT_CONFIG_UPDATED,
      payload: { values: { "log.level": "debug", "log.output": "file", "log.format": "json" } },
    } as ConfigUpdatedEvent);

    expect(deps.loggingService.configure).toHaveBeenCalledWith({
      logLevel: "debug",
      logFile: true,
      logConsole: false,
      allowedLoggers: undefined,
      logFormat: "json",
    });
  });

  it("reconfigures with logFormat when only log.format changes", () => {
    const deps = createDeps();
    const module = createLoggingModule(deps);

    const handler = module.events![EVENT_CONFIG_UPDATED]!;
    handler({
      type: EVENT_CONFIG_UPDATED,
      payload: { values: { "log.format": "json" } },
    } as ConfigUpdatedEvent);

    expect(deps.loggingService.configure).toHaveBeenCalledWith(
      expect.objectContaining({ logFormat: "json" })
    );
  });

  it("includes logFormat in reconfigure when log.level changes", () => {
    const deps = createDeps();
    const module = createLoggingModule(deps);

    const handler = module.events![EVENT_CONFIG_UPDATED]!;
    handler({
      type: EVENT_CONFIG_UPDATED,
      payload: { values: { "log.level": "info" } },
    } as ConfigUpdatedEvent);

    expect(deps.loggingService.configure).toHaveBeenCalledWith(
      expect.objectContaining({ logFormat: "text" })
    );
  });
});
