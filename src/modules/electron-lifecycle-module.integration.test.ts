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
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  configureResultSchema,
} from "../intents/app-start";
import type { AppStartIntent, ConfigureResult } from "../intents/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import {
  createElectronLifecycleModule,
  DEFAULT_DISABLED_FEATURES,
  type ElectronLifecycleModuleDeps,
} from "./electron-lifecycle-module";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { createAppBoundaryMock } from "../boundaries/shell/app.state-mock";

// =============================================================================
// Minimal Test Operations
// =============================================================================

const beforeReadySchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<ConfigureResult>(),
  hooks: { "before-ready": { result: configureResultSchema } },
} satisfies OperationSchemas;

/** Runs "before-ready" hook point only. */
class MinimalBeforeReadyOperation implements Operation<typeof beforeReadySchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = beforeReadySchemas;
  async execute(
    ctx: OperationContext<IntentOf<typeof beforeReadySchemas>, typeof beforeReadySchemas>
  ): Promise<ConfigureResult> {
    const { results, errors } = await ctx.hooks.collect("before-ready", {
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
    appLayer: createAppBoundaryMock(),
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

    await dispatcher.dispatch<AppStartIntent>({
      type: INTENT_APP_START,
      payload: {},
    });

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
      dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      })
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

    await dispatcher.dispatch<AppShutdownIntent>({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    });

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
        await dispatcher.dispatch<AppStartIntent>({
          type: INTENT_APP_START,
          payload: {},
        });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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
        await dispatcher.dispatch<AppStartIntent>({
          type: INTENT_APP_START,
          payload: {},
        });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("no-proxy-server");
    });

    it("claims the single-instance lock only after userData has been redirected", async () => {
      // Electron keys the lock on `userData`. Claiming it before the redirect
      // would key it on the system default, so every data root — dev
      // worktrees, e2e runs under _CH_ROOT_DIR — would contend with the
      // installed app instead of getting its own lock.
      const order: string[] = [];
      const mockApp = createMockApp();
      vi.mocked(mockApp.setPath).mockImplementation((name: string) => {
        order.push(`setPath:${name}`);
      });
      const appLayer = createAppBoundaryMock();
      const claim = appLayer.ensureSingleInstance.bind(appLayer);
      appLayer.ensureSingleInstance = () => {
        order.push("lock");
        return claim();
      };

      const dispatcher = createMockDispatcher();
      dispatcher.registerOperation(new MinimalBeforeReadyOperation());
      dispatcher.registerModule(
        createElectronLifecycleModule(createDeps({ app: mockApp, appLayer }))
      );

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(order.indexOf("lock")).toBeGreaterThan(order.indexOf("setPath:userData"));
    });

    it("abandons before-ready when another instance already holds the lock", async () => {
      // The real boundary has already exited the process by the time
      // ensureSingleInstance() reports false. Everything after the claim must
      // be skipped, or a second launch would keep configuring an app that is
      // on its way out — and touch state the running instance owns.
      const mockApp = createMockApp();
      const appLayer = createAppBoundaryMock({ primaryInstance: false });

      const dispatcher = createMockDispatcher();
      dispatcher.registerOperation(new MinimalBeforeReadyOperation());
      dispatcher.registerModule(
        createElectronLifecycleModule(createDeps({ app: mockApp, appLayer }))
      );

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(appLayer).toHaveExitedWithCode(0);
      expect(appLayer).toHaveAppUserModelId(null);
      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it("carries on through before-ready when it is the primary instance", async () => {
      const mockApp = createMockApp();
      const appLayer = createAppBoundaryMock();

      const dispatcher = createMockDispatcher();
      dispatcher.registerOperation(new MinimalBeforeReadyOperation());
      dispatcher.registerModule(
        createElectronLifecycleModule(createDeps({ app: mockApp, appLayer }))
      );

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(appLayer).toHaveExitedWithCode(null);
      expect(appLayer).toHaveAppUserModelId("com.codehydra.app");
    });

    it("sets the Windows app user model id to match electron-builder's appId", async () => {
      // Windows keys toasts to the launching shortcut's AUMID. If Electron's
      // runtime id disagrees with the one NSIS stamped, notifications can
      // surface under the wrong name or vanish from Action Center.
      const appLayer = createAppBoundaryMock();
      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(new MinimalBeforeReadyOperation());
      dispatcher.registerModule(createElectronLifecycleModule(createDeps({ appLayer })));

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(appLayer).toHaveAppUserModelId("com.codehydra.app");
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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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
    /**
     * Wire up the module with a captured "resume" callback, run app:start so the
     * heartbeat is armed, and hand back the pieces the assertions need.
     */
    async function setupResume(): Promise<{
      fireResume: () => void;
      mockDispatcher: { dispatch: ReturnType<typeof vi.fn> };
    }> {
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
      dispatcher.registerModule(
        createElectronLifecycleModule(
          createDeps({
            app: createMockApp(),
            powerMonitor: mockPowerMonitor,
            dispatcher: mockDispatcher,
          })
        )
      );

      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });

      expect(resumeCallbacks.length).toBe(1);
      return { fireResume: () => resumeCallbacks[0]!(), mockDispatcher };
    }

    function dispatchedSleptMs(mockDispatcher: {
      dispatch: ReturnType<typeof vi.fn>;
    }): number | undefined {
      const intent = mockDispatcher.dispatch.mock.calls[0]![0] as {
        type: string;
        payload: { sleptMs?: number };
      };
      expect(intent.type).toBe("app:resume");
      return intent.payload.sleptMs;
    }

    it("dispatches app:resume on powerMonitor resume event", async () => {
      const { fireResume, mockDispatcher } = await setupResume();

      fireResume();

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchedSleptMs(mockDispatcher)).toBeTypeOf("number");
    });

    it("reports the wall-clock gap the machine spent suspended", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-30T20:22:54Z"));
        const { fireResume, mockDispatcher } = await setupResume();

        // The 12h53m gap from the reported incident.
        vi.setSystemTime(new Date("2026-07-31T09:15:43Z"));
        fireResume();

        // Measured from the last heartbeat stamp, so it may over-state the
        // suspend by up to one interval — never under-state it.
        const sleptMs = dispatchedSleptMs(mockDispatcher)!;
        expect(sleptMs).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
        expect(sleptMs).toBeLessThan(13 * 60 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let heartbeat ticks that come due on wake erase the gap", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-30T20:22:54Z"));
        const { fireResume, mockDispatcher } = await setupResume();

        // Jump the clock as a suspend does, then let the timers that came due
        // during it run — as they do on wake, before "resume" is delivered.
        vi.setSystemTime(new Date("2026-07-31T09:15:43Z"));
        await vi.advanceTimersByTimeAsync(60_000);

        fireResume();

        expect(dispatchedSleptMs(mockDispatcher)!).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a negligible gap when the machine did not actually sleep", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-30T20:22:54Z"));
        const { fireResume, mockDispatcher } = await setupResume();

        // A spurious resume with no preceding suspend must not look like one.
        fireResume();

        expect(dispatchedSleptMs(mockDispatcher)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
