// @vitest-environment node
/**
 * Integration tests for ElectronLifecycleModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { Path } from "../../services/platform/path";
import { SILENT_LOGGER } from "../../services/logging";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, ConfigureResult } from "../operations/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import {
  createElectronLifecycleModule,
  type ElectronLifecycleModuleDeps,
} from "./electron-lifecycle-module";

// =============================================================================
// Minimal Test Operations
// =============================================================================

/** Runs "before-ready" hook point only. */
class MinimalBeforeReadyOperation implements Operation<Intent, ConfigureResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ConfigureResult> {
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

// =============================================================================
// Tests
// =============================================================================

describe("ElectronLifecycleModule Integration", () => {
  it("calls whenReady during await-ready hook", async () => {
    const mockApp = createMockApp();

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(
      INTENT_APP_START,
      createMinimalOperation(APP_START_OPERATION_ID, "await-ready")
    );

    const module = createElectronLifecycleModule({ app: mockApp, logger: SILENT_LOGGER });
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

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(
      INTENT_APP_START,
      createMinimalOperation(APP_START_OPERATION_ID, "await-ready")
    );

    const module = createElectronLifecycleModule({ app: mockApp, logger: SILENT_LOGGER });
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

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const module = createElectronLifecycleModule({ app: mockApp, logger: SILENT_LOGGER });
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
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        buildInfo: { isPackaged: false },
      });

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
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const mockPathProvider = {
        dataPath: (subpath: string) => new Path(`/data/${subpath}`),
      };

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        pathProvider: mockPathProvider,
      });

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
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        buildInfo: { isPackaged: true },
      });

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

    it("skips when buildInfo and pathProvider are not provided", async () => {
      const mockApp = createMockApp();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
      });

      dispatcher.registerModule(module);

      // Should not throw when optional deps are omitted
      await expect(
        dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent)
      ).resolves.not.toThrow();
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

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start")
      );

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        powerMonitor: mockPowerMonitor,
        dispatcher: mockDispatcher,
      });
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

    it("does not crash when powerMonitor is null", async () => {
      const mockApp = createMockApp();

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start")
      );

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        powerMonitor: null,
        dispatcher: { dispatch: vi.fn() },
      });
      dispatcher.registerModule(module);

      // Should not throw
      await expect(
        dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent)
      ).resolves.not.toThrow();
    });

    it("does not register listener when dispatcher is not provided", async () => {
      const mockApp = createMockApp();
      const mockPowerMonitor = { on: vi.fn() };

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start")
      );

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        powerMonitor: mockPowerMonitor,
      });
      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockPowerMonitor.on).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // config:updated event
  // ---------------------------------------------------------------------------
  describe("config:updated event", () => {
    it("applies electron flags from config:updated event", () => {
      const mockApp = createMockApp();

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
      });

      const event: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: { "electron.flags": "--disable-gpu --use-gl=swiftshader" } },
      };

      module.events![EVENT_CONFIG_UPDATED]!(event);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("use-gl", "swiftshader");
    });

    it("does not apply flags when electron.flags is not in payload", () => {
      const mockApp = createMockApp();

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
      });

      const event: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: { "log.level": "debug" } },
      };

      module.events![EVENT_CONFIG_UPDATED]!(event);

      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it("handles empty electron.flags value", () => {
      const mockApp = createMockApp();

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
      });

      const event: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: { "electron.flags": "" } },
      };

      module.events![EVENT_CONFIG_UPDATED]!(event);

      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalled();
    });
  });
});
