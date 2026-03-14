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

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
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
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type WorkspaceCreatedPayload,
} from "../operations/open-workspace";
import { INTENT_APP_RESUME, type AppResumeIntent } from "../operations/app-resume";
import { AppResumeOperation } from "../operations/app-resume";
import { createTelemetryModule } from "./telemetry-module";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import type { TelemetryService, TelemetryConfigureOptions } from "../../services/telemetry/types";

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

/**
 * Minimal workspace:open operation that emits workspace:created with a given payload.
 * Skips the full hook pipeline (create/setup/finalize) — just emits the event.
 */
class MinimalOpenWorkspaceOperation implements Operation<OpenWorkspaceIntent, void> {
  readonly id = "open-workspace";

  constructor(private readonly eventPayload: WorkspaceCreatedPayload) {}

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<void> {
    ctx.emit({ type: "workspace:created", payload: this.eventPayload });
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

const NEW_WORKSPACE_PAYLOAD: WorkspaceCreatedPayload = {
  projectId: "project-1" as WorkspaceCreatedPayload["projectId"],
  workspaceName: "ws-1" as WorkspaceCreatedPayload["workspaceName"],
  workspacePath: "/ws",
  projectPath: "/proj",
  branch: "ws-1",
  metadata: {},
  workspaceUrl: "http://127.0.0.1:8080",
};

const REOPENED_WORKSPACE_PAYLOAD: WorkspaceCreatedPayload = {
  ...NEW_WORKSPACE_PAYLOAD,
  reopened: true,
};

function createTestSetup(overrides?: {
  telemetryService?: TelemetryService | null;
  workspacePayload?: WorkspaceCreatedPayload;
}): TestSetup {
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

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new MinimalConfigSetValuesOperation());
  dispatcher.registerOperation(
    INTENT_OPEN_WORKSPACE,
    new MinimalOpenWorkspaceOperation(overrides?.workspacePayload ?? NEW_WORKSPACE_PAYLOAD)
  );
  dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());

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

function openWorkspaceIntent(): OpenWorkspaceIntent {
  return {
    type: INTENT_OPEN_WORKSPACE,
    payload: { workspaceName: "ws-1", projectPath: "/proj" },
  } as OpenWorkspaceIntent;
}

function appResumeIntent(): AppResumeIntent {
  return { type: INTENT_APP_RESUME, payload: {} as AppResumeIntent["payload"] };
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
          "telemetry.distinct-id": "user-abc",
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
        configSetValuesIntent({ "telemetry.enabled": true, "telemetry.distinct-id": "id-1" })
      );

      expect(configureCalls).toEqual([{ enabled: true, distinctId: "id-1", agent: "claude" }]);
    });

    it("registers error handlers when telemetry.enabled is true", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        const monitorHandler = registeredHandlers.find(
          (h) => h.event === "uncaughtExceptionMonitor"
        );
        expect(monitorHandler).toBeDefined();
      } finally {
        process.on = originalOn;
      }
    });

    it("does not register error handlers when telemetry.enabled is false", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": false }));

        expect(registeredHandlers).toHaveLength(0);
      } finally {
        process.on = originalOn;
      }
    });

    it("registers error handlers only once across multiple config:updated events", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher } = createTestSetup();

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));
        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        // Should have exactly 1 handler (uncaughtExceptionMonitor)
        expect(registeredHandlers).toHaveLength(1);
      } finally {
        process.on = originalOn;
      }
    });

    it("error handler calls captureError without re-throwing", async () => {
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
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher } = createTestSetup({ telemetryService: service });

        await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

        const monitorHandler = registeredHandlers.find(
          (h) => h.event === "uncaughtExceptionMonitor"
        );

        // Monitor handler should call captureError without re-throwing
        const testError = new Error("test uncaught");
        monitorHandler!.handler(testError);
        expect(capturedErrors).toContain(testError);
      } finally {
        process.on = originalOn;
      }
    });

    it("does not generate distinctId during config:updated (deferred to start hook)", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      // Telemetry enabled but no distinctId — ID generation is deferred to start hook
      await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

      // Only one configure call from config:updated (no nested dispatch for ID generation)
      expect(configureCalls).toHaveLength(1);
      expect(configureCalls[0]).toEqual({
        enabled: true,
        distinctId: undefined,
        agent: undefined,
      });
    });

    it("does not generate distinctId when one already exists", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      await dispatcher.dispatch(
        configSetValuesIntent({
          "telemetry.enabled": true,
          "telemetry.distinct-id": "existing-id",
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
          "telemetry.distinct-id": "user-123",
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
      await dispatcher.dispatch(startIntent());
    });

    it("generates distinctId during start hook when telemetry enabled and no id", async () => {
      const { dispatcher, tracking, configureCalls } = createTestSetup();

      // Simulate config:updated with telemetry enabled but no distinctId
      await dispatcher.dispatch(
        configSetValuesIntent({ "telemetry.enabled": true, agent: "claude" })
      );

      // Only the initial configure call — no ID generation yet
      expect(configureCalls).toHaveLength(1);
      expect(configureCalls[0]!.distinctId).toBeUndefined();

      // Start hook triggers ID generation
      await dispatcher.dispatch(startIntent());

      // Start hook calls configure directly (2nd), then dispatches config:set-values
      // which triggers config:updated → configure again (3rd)
      expect(configureCalls).toHaveLength(3);
      expect(configureCalls[1]).toEqual({
        enabled: true,
        distinctId: tracking.generateDistinctIdResult,
        agent: "claude",
      });
    });

    it("stored distinct-id from init takes precedence over generation", async () => {
      const { dispatcher, configureCalls } = createTestSetup();

      // Simulate init loading stored ID via config:updated
      await dispatcher.dispatch(
        configSetValuesIntent({
          "telemetry.enabled": true,
          "telemetry.distinct-id": "stored-id-from-config",
          agent: "opencode",
        })
      );

      await dispatcher.dispatch(startIntent());

      // No additional configure call from start hook — ID already exists
      expect(configureCalls).toHaveLength(1);
      expect(configureCalls[0]!.distinctId).toBe("stored-id-from-config");
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

  describe("workspace:created event", () => {
    const expectedProperties = {
      platform: "darwin",
      arch: "arm64",
      isDevelopment: true,
      agent: "opencode",
    };

    it("captures workspace_created for new workspaces", async () => {
      const { dispatcher, captures } = createTestSetup();

      await dispatcher.dispatch(configSetValuesIntent({ agent: "opencode" }));
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(captures).toEqual([{ event: "workspace_created", properties: expectedProperties }]);
    });

    it("does not capture workspace_created for reopened workspaces", async () => {
      const { dispatcher, captures } = createTestSetup({
        workspacePayload: REOPENED_WORKSPACE_PAYLOAD,
      });

      await dispatcher.dispatch(configSetValuesIntent({ agent: "opencode" }));
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(captures).toHaveLength(0);
    });

    it("does not throw when telemetryService is null", async () => {
      const { dispatcher } = createTestSetup({ telemetryService: null });

      await expect(dispatcher.dispatch(openWorkspaceIntent())).resolves.toBeUndefined();
    });
  });

  describe("app:resumed event", () => {
    it("captures app_resume on system wake", async () => {
      const { dispatcher, captures } = createTestSetup();

      await dispatcher.dispatch(configSetValuesIntent({ agent: "claude" }));
      await dispatcher.dispatch(appResumeIntent());

      expect(captures).toEqual([
        {
          event: "app_resume",
          properties: {
            platform: "darwin",
            arch: "arm64",
            isDevelopment: true,
            agent: "claude",
          },
        },
      ]);
    });

    it("does not throw when telemetryService is null", async () => {
      const { dispatcher } = createTestSetup({ telemetryService: null });

      await expect(dispatcher.dispatch(appResumeIntent())).resolves.toBeUndefined();
    });
  });
});
