// @vitest-environment node
/**
 * Integration tests for LoggingModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/lib/operation";
import type { Intent } from "../intents/lib/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, InitHookContext, ConfigureResult } from "../intents/app-start";
import { INTENT_APP_SHUTDOWN, APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { createMockLogger } from "../boundaries/platform/logging";
import { createLoggingModule } from "./logging-module";
import type { Config } from "../boundaries/platform/config";

// =============================================================================
// Mock Config
// =============================================================================

function createMockConfig(values?: Record<string, unknown>): Config {
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
    getDefaults: () => ({}),
    getHelpText: () => "",
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

/** Runs the "stop" hook for shutdown. */
class MinimalAppShutdownOperation implements Operation<Intent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    await ctx.hooks.collect<void>("stop", hookCtx);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createDeps(configValues?: Record<string, unknown>) {
  const loggingService = {
    initialize: vi.fn(),
    configure: vi.fn(),
    getElectronLogFilePath: vi.fn().mockReturnValue("/logs/electron.log"),
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
    "log.level": "warn",
    "log.output": "file",
    "log.format": "text",
    ...configValues,
  });
  const app = {
    commandLine: { appendSwitch: vi.fn() },
  };
  const files = new Map<string, string>();
  const fileSystem = {
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return files.get(path)!;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
  };
  const scheduledTicks: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
  const scheduler = {
    setInterval: vi.fn((handler: () => void, ms: number) => {
      const entry = { handler, ms, cleared: false };
      scheduledTicks.push(entry);
      return entry;
    }),
    clearInterval: vi.fn((handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    }),
  };

  return {
    loggingService,
    buildInfo,
    platformInfo,
    logger,
    configService,
    app,
    fileSystem,
    scheduler,
    scheduledTicks,
    files,
  };
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

  it("initializes logging service during init hook", async () => {
    const deps = createDeps();
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(deps.loggingService.initialize).toHaveBeenCalledOnce();
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

  it("appends --enable-logging=file, --log-file, and --v=1 during before-ready", async () => {
    const deps = createDeps();
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

    expect(deps.app.commandLine.appendSwitch).toHaveBeenCalledWith("enable-logging", "file");
    expect(deps.app.commandLine.appendSwitch).toHaveBeenCalledWith(
      "log-file",
      "/logs/electron.log"
    );
    expect(deps.app.commandLine.appendSwitch).toHaveBeenCalledWith("v", "1");
  });

  it("starts the truncation watcher during init", async () => {
    const deps = createDeps();
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

    expect(deps.scheduler.setInterval).toHaveBeenCalledOnce();
    expect(deps.scheduledTicks).toHaveLength(1);
    expect(deps.scheduledTicks[0]!.ms).toBe(15 * 60 * 1000);
  });

  it("truncates electron.log to last 20 MB when the watcher fires on an oversize file", async () => {
    const deps = createDeps();
    // Seed an oversize file (21 MB of 'A')
    const oversize = "A".repeat(21 * 1024 * 1024);
    deps.files.set("/logs/electron.log", oversize);

    const dispatcher = new Dispatcher({ logger: createMockLogger() });
    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));
    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

    // Manually fire the watcher tick
    deps.scheduledTicks[0]!.handler();
    // Tick handler is sync-scheduled but async-internal; wait a microtask
    await new Promise((r) => setImmediate(r));

    const truncated = deps.files.get("/logs/electron.log");
    expect(truncated).toBeDefined();
    expect(Buffer.byteLength(truncated!, "utf8")).toBe(20 * 1024 * 1024);
  });

  it("does nothing when the watcher fires and the file is within size", async () => {
    const deps = createDeps();
    deps.files.set("/logs/electron.log", "small");

    const dispatcher = new Dispatcher({ logger: createMockLogger() });
    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));
    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

    deps.scheduledTicks[0]!.handler();
    await new Promise((r) => setImmediate(r));

    expect(deps.fileSystem.writeFile).not.toHaveBeenCalled();
    expect(deps.files.get("/logs/electron.log")).toBe("small");
  });

  it("silently ignores missing electron.log when the watcher fires", async () => {
    const deps = createDeps();
    // No file seeded — readFile rejects with ENOENT

    const dispatcher = new Dispatcher({ logger: createMockLogger() });
    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerModule(createLoggingModule(deps));
    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

    deps.scheduledTicks[0]!.handler();
    await new Promise((r) => setImmediate(r));

    expect(deps.fileSystem.writeFile).not.toHaveBeenCalled();
  });

  it("stops the truncation watcher on app:shutdown stop hook", async () => {
    const deps = createDeps();
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new MinimalAppShutdownOperation());
    dispatcher.registerModule(createLoggingModule(deps));

    await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);
    await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent);

    expect(deps.scheduler.clearInterval).toHaveBeenCalledOnce();
    expect(deps.scheduledTicks[0]!.cleared).toBe(true);
  });
});
