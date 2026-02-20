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
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, ConfigureResult } from "../operations/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import {
  createElectronLifecycleModule,
  type ElectronLifecycleModuleDeps,
} from "./electron-lifecycle-module";

// =============================================================================
// Minimal Test Operations
// =============================================================================

/** Runs "await-ready" hook point only. */
class MinimalAwaitReadyOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<void>("await-ready", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

/** Runs "configure" hook point only. */
class MinimalConfigureOperation implements Operation<Intent, ConfigureResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ConfigureResult> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("configure", {
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

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

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

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

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
  // app-start/configure
  // ---------------------------------------------------------------------------
  describe("app-start/configure", () => {
    it("sets process.noAsar when not packaged", async () => {
      const mockApp = createMockApp();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalConfigureOperation());

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

    it("applies electron flags from environment", async () => {
      const mockApp = createMockApp();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalConfigureOperation());

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
      });

      dispatcher.registerModule(module);

      const originalFlags = process.env.CODEHYDRA_ELECTRON_FLAGS;
      try {
        process.env.CODEHYDRA_ELECTRON_FLAGS = "--disable-gpu --use-gl=swiftshader";
        await dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent);

        expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
        expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("use-gl", "swiftshader");
      } finally {
        if (originalFlags === undefined) {
          delete process.env.CODEHYDRA_ELECTRON_FLAGS;
        } else {
          process.env.CODEHYDRA_ELECTRON_FLAGS = originalFlags;
        }
      }
    });

    it("redirects electron data paths when pathProvider is available", async () => {
      const mockApp = createMockApp();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalConfigureOperation());

      const module = createElectronLifecycleModule({
        app: mockApp,
        logger: SILENT_LOGGER,
        pathProvider: { electronDataDir: { toNative: () => "/data/electron" } },
      });

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const electronDir = new Path("/data/electron");
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "userData",
        new Path(electronDir, "userData").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "sessionData",
        new Path(electronDir, "sessionData").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "logs",
        new Path(electronDir, "logs").toNative()
      );
      expect(mockApp.setPath).toHaveBeenCalledWith(
        "crashDumps",
        new Path(electronDir, "crashDumps").toNative()
      );
    });

    it("does not set process.noAsar when packaged", async () => {
      const mockApp = createMockApp();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalConfigureOperation());

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

      dispatcher.registerOperation(INTENT_APP_START, new MinimalConfigureOperation());

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
});
