// @vitest-environment node
/**
 * Integration tests for ElectronLifecycleModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { Path } from "../utils/path/path";
import { SILENT_LOGGER } from "../boundaries/platform/logging";

import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, ConfigureResult } from "../intents/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import {
  createElectronLifecycleModule,
  DEFAULT_DISABLED_FEATURES,
  type ElectronLifecycleModuleDeps,
} from "./electron-lifecycle-module";
import { createMockConfig } from "../boundaries/platform/config.test-utils";

// =============================================================================
// Minimal Test Operations
// =============================================================================

const beforeReadySchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<ConfigureResult>(),
} satisfies OperationSchemas;

/** Runs "before-ready" hook point only. */
class MinimalBeforeReadyOperation implements Operation<typeof beforeReadySchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = beforeReadySchemas;
  async execute(
    ctx: OperationContext<IntentOf<typeof beforeReadySchemas>>
  ): Promise<ConfigureResult> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    const merged: ConfigureResult = {};
    for (const r of results) {
      if (r.scripts) {
        (merged as Record<string, unknown>).scripts = [
          ...((merged.scripts as string[]) ?? []),
          ...r.scripts,
        ];
      }
    }
    return merged;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createMockApp(): ElectronLifecycleModuleDeps["app"] {
  return {
    whenReady: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    setPath: vi.fn(),
  };
}

function createDeps(overrides?: Partial<ElectronLifecycleModuleDeps>): ElectronLifecycleModuleDeps {
  return {
    app: createMockApp(),
    logger: SILENT_LOGGER,
    buildInfo: { isPackaged: true },
    pathProvider: { dataPath: (subpath: string) => new Path(`/data/${subpath}`) },
    asyncWatcher: { check: vi.fn() },
    powerMonitor: { on: vi.fn() },
    dispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
    configService: createMockConfig(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ElectronLifecycleModule Integration", () => {
  it("calls whenReady during init hook and provides app-ready capability", async () => {
    const mockApp = createMockApp();

    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(
      createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init")
    );

    const module = createElectronLifecycleModule(
      createDeps({
        app: mockApp,
      })
    );
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(mockApp.whenReady).toHaveBeenCalledOnce();
  });

  it("propagates whenReady rejection", async () => {
    const mockApp = createMockApp();
    mockApp.whenReady = vi.fn().mockRejectedValue(new Error("app failed to initialize"));

    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(
      createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init")
    );

    const module = createElectronLifecycleModule(
      createDeps({
        app: mockApp,
      })
    );
    dispatcher.registerModule(module);

    await expect(
      dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)
    ).rejects.toThrow("app failed to initialize");
  });

  it("calls app.quit() when dispatching app:shutdown", async () => {
    const mockApp = createMockApp();

    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(new AppShutdownOperation());

    const module = createElectronLifecycleModule(
      createDeps({
        app: mockApp,
      })
    );
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    expect(mockApp.quit).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // app-start/before-ready
  // ---------------------------------------------------------------------------
  describe("app-start/before-ready", () => {
    it("sets process.noAsar when not packaged", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          buildInfo: { isPackaged: false },
        })
      );

      dispatcher.registerModule(module);

      const originalNoAsar = process.noAsar;
      try {
        await dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent);

        expect(process.noAsar).toBe(true);
      } finally {
        process.noAsar = originalNoAsar;
      }
    });

    it("redirects electron data paths when pathProvider is available", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const mockPathProvider = {
        dataPath: (subpath: string) => new Path(`/data/${subpath}`),
      };

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          pathProvider: mockPathProvider,
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockApp.setPath).toHaveBeenCalledWith(
        "userData",
        new Path("/data/electron/userData").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "sessionData",
        new Path("/data/electron/sessionData").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "logs",
        new Path("/data/electron/logs").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "crashDumps",
        new Path("/data/electron/crashDumps").toNative()
      );
    });

    it("does not set process.noAsar when packaged", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          buildInfo: { isPackaged: true },
        })
      );

      dispatcher.registerModule(module);

      const originalNoAsar = process.noAsar;
      try {
        process.noAsar = false;
        await dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent);

        expect(process.noAsar).toBe(false);
      } finally {
        process.noAsar = originalNoAsar;
      }
    });

    it("applies electron flags from configService", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          configService: createMockConfig({
            defaults: { "electron.flags": "--disable-gpu --use-gl=swiftshader" },
          }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("use-gl", "swiftshader");
    });

    it("applies --no-proxy-server by default to suppress WPAD probes", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          configService: createMockConfig({ defaults: { "electron.flags": null } }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("no-proxy-server");
    });

    it("applies curated default --disable-features when electron.disabled-features is unset", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const expected = DEFAULT_DISABLED_FEATURES.join(",");
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", expected);
    });

    it("user-supplied electron.disabled-features fully replaces defaults", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          configService: createMockConfig({
            defaults: { "electron.disabled-features": "FeatureA, FeatureB" },
          }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
        "disable-features",
        "FeatureA,FeatureB"
      );
      // Defaults are NOT applied
      const defaultExpected = DEFAULT_DISABLED_FEATURES.join(",");
      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalledWith(
        "disable-features",
        defaultExpected
      );
    });

    it("empty string for electron.disabled-features disables nothing (no --disable-features switch)", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          configService: createMockConfig({ defaults: { "electron.disabled-features": "" } }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const disableFeaturesCalls = (
        mockApp.commandLine.appendSwitch as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[0] === "disable-features");
      expect(disableFeaturesCalls).toEqual([]);
    });

    it("explicit null for electron.disabled-features still applies defaults", async () => {
      const mockApp = createMockApp();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          configService: createMockConfig({ defaults: { "electron.disabled-features": null } }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const expected = DEFAULT_DISABLED_FEATURES.join(",");
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", expected);
    });

    it("logs the disabled features list at info level", async () => {
      const mockApp = createMockApp();
      const logger = createMockLogger();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          logger,
          configService: createMockConfig({
            defaults: { "electron.disabled-features": "Foo,Bar" },
          }),
        })
      );

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(logger.info).toHaveBeenCalledWith(
        "Disabled Chromium features",
        expect.objectContaining({ count: 2, features: "Foo,Bar" })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // app-start/activate — powerMonitor resume dispatches app:resume
  // ---------------------------------------------------------------------------
  describe("app-start/activate — powerMonitor resume", () => {
    it("dispatches app:resume on powerMonitor resume event", async () => {
      const mockApp = createMockApp();
      const resumeCallbacks: (() => void)[] = [];
      const mockPowerMonitor = {
        on: vi.fn((event: string, callback: () => void) => {
          if (event === "resume") resumeCallbacks.push(callback);
        }),
      };
      const mockDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };

      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start")
      );

      const module = createElectronLifecycleModule(
        createDeps({
          app: mockApp,
          powerMonitor: mockPowerMonitor,
          dispatcher: mockDispatcher,
        })
      );
      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Simulate resume
      expect(resumeCallbacks.length).toBe(1);
      resumeCallbacks[0]!();

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({ type: "app:resume", payload: {} });
    });
  });
});
