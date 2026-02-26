// @vitest-environment node
/**
 * Integration tests for TelemetryModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> TelemetryModule handler
 *
 * Uses a MinimalStartOperation (only runs "start" hook point) to avoid
 * the full AppStartOperation pipeline. AppShutdownOperation is simple
 * enough to use directly.
 *
 * The telemetry module now receives configuration via config:updated events
 * instead of loading config directly. Tests simulate this by emitting
 * config:updated events through the dispatcher before exercising hooks.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
  type StartHookResult,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../operations/app-shutdown";
import {
  INTENT_CONFIG_SET_VALUES,
  type ConfigSetValuesIntent,
} from "../operations/config-set-values";
import { createTelemetryModule } from "./telemetry-module";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import type { TelemetryService, TelemetryConfigureOptions } from "../../services/telemetry/types";

// =============================================================================
// Minimal Start Operation
// =============================================================================

/**
 * Minimal start operation that only runs the "start" hook point.
 * Avoids the full AppStartOperation pipeline (check-config, check-deps, etc.)
 * while still exercising the telemetry module's start hook through the dispatcher.
 */
class MinimalStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect<StartHookResult>("start", hookCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }
  }
}

/**
 * Minimal config set-values operation that runs the "set" hook and emits
 * the config:updated event. Uses a simplified hook that just passes through
 * values as changed.
 */
class MinimalConfigSetValuesOperation implements Operation<ConfigSetValuesIntent, void> {
  readonly id = "config-set-values";

  async execute(ctx: OperationContext<ConfigSetValuesIntent>): Promise<void> {
    // Skip the actual "set" hook — just emit config:updated with the values
    ctx.emit({
      type: "config:updated",
      payload: { values: ctx.intent.payload.values },
    });
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

interface CaptureCall {
  event: string;
  properties: Record<string, unknown> | undefined;
}

interface ConfigureCall {
  enabled: boolean;
  distinctId: string | undefined;
  agent: string | undefined;
}

function createTrackingTelemetryService(): {
  service: TelemetryService;
  captures: CaptureCall[];
  configureCalls: ConfigureCall[];
  generateDistinctIdResult: string | undefined;
  shutdownCalled: boolean;
} {
  const captures: CaptureCall[] = [];
  const configureCalls: ConfigureCall[] = [];
  let shutdownCalled = false;
  let generateDistinctIdResult: string | undefined = "generated-id-123";

  const service: TelemetryService = {
    configure(options: TelemetryConfigureOptions) {
      configureCalls.push({
        enabled: options.enabled,
        distinctId: options.distinctId,
        agent: options.agent,
      });
    },
    generateDistinctId(): string | undefined {
      return generateDistinctIdResult;
    },
    capture(event: string, properties?: Record<string, unknown>) {
      captures.push({ event, properties });
    },
    captureError() {},
    async shutdown() {
      shutdownCalled = true;
    },
  };

  return {
    service,
    captures,
    configureCalls,
    get generateDistinctIdResult() {
      return generateDistinctIdResult;
    },
    set generateDistinctIdResult(value: string | undefined) {
      generateDistinctIdResult = value;
    },
    get shutdownCalled() {
      return shutdownCalled;
    },
  };
}

interface TestSetup {
  dispatcher: Dispatcher;
  captures: CaptureCall[];
  configureCalls: ConfigureCall[];
  tracking: ReturnType<typeof createTrackingTelemetryService>;
  shutdownCalled: boolean;
}

function createTestSetup(overrides?: { telemetryService?: TelemetryService | null }): TestSetup {
  const tracking = createTrackingTelemetryService();
  const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
  const buildInfo = { version: "1.0.0", isDevelopment: true, isPackaged: false, appPath: "/app" };

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const telemetryModule = createTelemetryModule({
    telemetryService:
      overrides?.telemetryService !== undefined ? overrides.telemetryService : tracking.service,
    platformInfo,
    buildInfo,
    dispatcher,
  });

  dispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new MinimalConfigSetValuesOperation());

  dispatcher.registerModule(telemetryModule);

  return {
    dispatcher,
    captures: tracking.captures,
    configureCalls: tracking.configureCalls,
    tracking,
    get shutdownCalled() {
      return tracking.shutdownCalled;
    },
  };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

function shutdownIntent(): AppShutdownIntent {
  return { type: INTENT_APP_SHUTDOWN, payload: {} as AppShutdownIntent["payload"] };
}

function configSetValuesIntent(values: Record<string, unknown>): ConfigSetValuesIntent {
  return {
    type: INTENT_CONFIG_SET_VALUES,
    payload: { values },
  } as ConfigSetValuesIntent;
}

// =============================================================================
// Tests
// =============================================================================

describe("TelemetryModule Integration", () => {
  describe("config:updated event handling", () => {
    it("calls telemetryService.configure() when telemetry values arrive", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      await dispatcher.dispatch(
        configSetValuesIntent({
          "telemetry.enabled": true,
          "telemetry.distinctId": "user-abc",
          agent: "opencode",
        })
      );

      expect(configureCalls).toEqual([
        {
          enabled: true,
          distinctId: "user-abc",
          agent: "opencode",
        },
      ]);
    });

    it("tracks agent separately from telemetry values", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      // First event: only agent
      await dispatcher.dispatch(configSetValuesIntent({ agent: "claude" }));

      // No configure call yet — telemetry.enabled not received
      expect(configureCalls).toHaveLength(0);

      // Second event: telemetry values arrive
      await dispatcher.dispatch(
        configSetValuesIntent({ "telemetry.enabled": true, "telemetry.distinctId": "id-1" })
      );

      expect(configureCalls).toEqual([{ enabled: true, distinctId: "id-1", agent: "claude" }]);
    });

    it("registers error handlers when telemetry.enabled is true", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalPrependListener = process.prependListener;
      process.prependListener = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.prependListener;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        const exceptionHandler = registeredHandlers.find((h) => h.event === "uncaughtException");
        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");
        expect(exceptionHandler).toBeDefined();
        expect(rejectionHandler).toBeDefined();
      } finally {
        process.prependListener = originalPrependListener;
      }
    });

    it("does not register error handlers when telemetry.enabled is false", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalPrependListener = process.prependListener;
      process.prependListener = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.prependListener;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": false }));

        expect(registeredHandlers).toHaveLength(0);
      } finally {
        process.prependListener = originalPrependListener;
      }
    });

    it("registers error handlers only once across multiple config:updated events", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalPrependListener = process.prependListener;
      process.prependListener = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.prependListener;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));
        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        // Should have exactly 2 handlers (one uncaughtException, one unhandledRejection)
        expect(registeredHandlers).toHaveLength(2);
      } finally {
        process.prependListener = originalPrependListener;
      }
    });

    it("error handlers call captureError and re-throw", async () => {
      const capturedErrors: Error[] = [];
      const service: TelemetryService = {
        configure() {},
        generateDistinctId() {
          return "id";
        },
        capture() {},
        captureError(error: Error) {
          capturedErrors.push(error);
        },
        async shutdown() {},
      };

      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalPrependListener = process.prependListener;
      process.prependListener = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.prependListener;

      try {
        const { dispatcher } = createTestSetup({ telemetryService: service });

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        const exceptionHandler = registeredHandlers.find((h) => h.event === "uncaughtException");
        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");

        // uncaughtException handler should call captureError and re-throw
        const testError = new Error("test uncaught");
        expect(() => exceptionHandler!.handler(testError)).toThrow(testError);
        expect(capturedErrors).toContain(testError);

        // unhandledRejection handler should wrap non-Error and re-throw
        expect(() => rejectionHandler!.handler("test rejection")).toThrow();
        expect(capturedErrors).toHaveLength(2);
      } finally {
        process.prependListener = originalPrependListener;
      }
    });

    it("generates distinctId and dispatches config:set-values when no id yet", async () => {
      const { dispatcher, tracking, configureCalls } = createTestSetup();

      // Telemetry enabled but no distinctId
      await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

      // First configure call from the initial event
      expect(configureCalls).toHaveLength(2);
      // First: from the initial config:updated
      expect(configureCalls[0]).toEqual({
        enabled: true,
        distinctId: undefined,
        agent: undefined,
      });
      // Second: from the nested config:set-values dispatch that set the generated id
      expect(configureCalls[1]).toEqual({
        enabled: true,
        distinctId: tracking.generateDistinctIdResult,
        agent: undefined,
      });
    });

    it("does not generate distinctId when one already exists", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      await dispatcher.dispatch(
        configSetValuesIntent({
          "telemetry.enabled": true,
          "telemetry.distinctId": "existing-id",
        })
      );

      // Only one configure call (no nested dispatch)
      expect(configureCalls).toHaveLength(1);
      expect(configureCalls[0]).toEqual({
        enabled: true,
        distinctId: "existing-id",
        agent: undefined,
      });
    });

    it("does not configure when telemetryService is null", async () => {
      const { dispatcher } = createTestSetup({ telemetryService: null });

      // Should not throw when config:updated arrives with null service
      await expect(
        dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }))
      ).resolves.toBeUndefined();
    });
  });

  describe("app:start hook", () => {
    it("captures telemetry with platform info when agent is configured", async () => {
      const { dispatcher, captures } = createTestSetup();

      // Simulate config:updated event with agent before start
      await dispatcher.dispatch(
        configSetValuesIntent({
          agent: "opencode",
          "telemetry.enabled": true,
          "telemetry.distinctId": "user-123",
        })
      );

      await dispatcher.dispatch(startIntent());

      expect(captures).toEqual([
        {
          event: "app_launched",
          properties: {
            platform: "darwin",
            arch: "arm64",
            isDevelopment: true,
            agent: "opencode",
          },
        },
      ]);
    });

    it("does not capture app_launched when no config:updated with agent received", async () => {
      const { dispatcher, captures } = createTestSetup();

      await dispatcher.dispatch(startIntent());

      expect(captures).toHaveLength(0);
    });

    it("does not capture app_launched when telemetryService is null", async () => {
      const { dispatcher } = createTestSetup({ telemetryService: null });

      await dispatcher.dispatch(configSetValuesIntent({ agent: "opencode" }));
      await expect(dispatcher.dispatch(startIntent())).resolves.toBeUndefined();
    });
  });

  describe("app:shutdown hook", () => {
    it("calls telemetryService.shutdown()", async () => {
      const setup = createTestSetup();

      await setup.dispatcher.dispatch(shutdownIntent());

      expect(setup.shutdownCalled).toBe(true);
    });

    it("telemetryService is null -- no errors on shutdown", async () => {
      const { dispatcher } = createTestSetup({ telemetryService: null });

      await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
    });

    it("shutdown() throws -- collect catches error, dispatch still resolves", async () => {
      const failingService: TelemetryService = {
        configure() {},
        generateDistinctId() {
          return undefined;
        },
        capture() {},
        captureError() {},
        async shutdown() {
          throw new Error("PostHog flush failed");
        },
      };
      const { dispatcher } = createTestSetup({
        telemetryService: failingService,
      });

      // Handler throws, but collect() catches it and shutdown is best-effort
      await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
    });
  });
});
