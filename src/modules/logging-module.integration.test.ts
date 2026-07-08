// @vitest-environment node
/**
 * Integration tests for LoggingModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

import type {
  Operation,
  OperationContext,
  HookContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, InitHookContext, ConfigureResult } from "../intents/app-start";
import { createMockLogger } from "../boundaries/platform/logging";
import { createLoggingModule } from "./logging-module";
import { createMockConfig } from "../boundaries/platform/config.test-utils";

// =============================================================================
// Minimal Test Operation
// =============================================================================

const appStartSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
} satisfies OperationSchemas;

/** Runs "before-ready" and "init" hook points in sequence. */
class MinimalAppStartOperation implements Operation<typeof appStartSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = appStartSchemas;
  async execute(ctx: OperationContext<IntentOf<typeof appStartSchemas>>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };

    const { errors: beforeReadyErrors } = await ctx.hooks.collect<ConfigureResult>(
      "before-ready",
      hookCtx
    );
    if (beforeReadyErrors.length > 0) throw beforeReadyErrors[0]!;

    const initCtx: InitHookContext = {
      intent: ctx.intent,
      requiredScripts: [],
      capabilities: { "app-ready": true },
    };
    const { errors: initErrors } = await ctx.hooks.collect<void>("init", initCtx);
    if (initErrors.length > 0) throw initErrors[0]!;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createDeps(configValues?: Record<string, unknown>) {
  const loggingService = {
    initialize: vi.fn(),
    configure: vi.fn(),
  };
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
  const configService = createMockConfig({
    defaults: {
      "log.level": "warn",
      "log.output": "file",
      "log.format": "text",
      ...configValues,
    },
  });

  return {
    loggingService,
    buildInfo,
    platformInfo,
    logger,
    configService,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("LoggingModule Integration", () => {
  it("logs build and platform info during before-ready hook", async () => {
    const deps = createDeps();
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new MinimalAppStartOperation());
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

  it("initializes logging service during init hook", async () => {
    const deps = createDeps();
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.loggingService.initialize).toHaveBeenCalledOnce();
  });

  it("logs startup info before initializing logging service", async () => {
    const deps = createDeps();
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    const logOrder = deps.logger.info.mock.invocationCallOrder[0]!;
    const initOrder = deps.loggingService.initialize.mock.invocationCallOrder[0]!;
    expect(logOrder).toBeLessThan(initOrder);
  });

  it("configures logging from configService during before-ready hook", async () => {
    const deps = createDeps({
      "log.level": "debug",
      "log.output": "file,console",
      "log.format": "json",
    });
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.loggingService.configure).toHaveBeenCalledWith({
      logLevel: "debug",
      logFile: true,
      logConsole: true,
      allowedLoggers: undefined,
      logFormat: "json",
    });
  });

  it("configures with file-only output by default", async () => {
    const deps = createDeps({
      "log.level": "warn",
      "log.output": "file",
      "log.format": "text",
    });
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.loggingService.configure).toHaveBeenCalledWith({
      logLevel: "warn",
      logFile: true,
      logConsole: false,
      allowedLoggers: undefined,
      logFormat: "text",
    });
  });
});
