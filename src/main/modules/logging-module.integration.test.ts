// @vitest-environment node
/**
 * Integration tests for LoggingModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, InitHookContext, ConfigureResult } from "../operations/app-start";
import { createMockLogger } from "../../services/logging";
import { createLoggingModule } from "./logging-module";
import type { ConfigService } from "../../services/config/config-service";

// =============================================================================
// Mock ConfigService
// =============================================================================

function createMockConfigService(values?: Record<string, unknown>): ConfigService {
  const store = new Map<string, unknown>(Object.entries(values ?? {}));
  return {
    register: () => {},
    load: () => {},
    get: (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getDefinitions: () => new Map(),
    getEffective: () => Object.fromEntries(store),
  };
}

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
  const configService = createMockConfigService({
    "log.level": "warn",
    "log.output": "file",
    "log.format": "text",
    ...configValues,
  });

  return { loggingService, registerLogHandlers, buildInfo, platformInfo, logger, configService };
}

// =============================================================================
// Tests
// =============================================================================

describe("LoggingModule Integration", () => {
  it("logs build and platform info during before-ready hook", async () => {
    const deps = createDeps();
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

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
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

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
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

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

  it("configures logging from configService during before-ready hook", async () => {
    const deps = createDeps({
      "log.level": "debug",
      "log.output": "file,console",
      "log.format": "json",
    });
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
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
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
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
