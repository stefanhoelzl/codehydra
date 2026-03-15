// @vitest-environment node
/**
 * Integration tests for PosthogModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> PosthogModule handler
 *
 * Uses a MinimalStartOperation (only runs "start" hook point) to avoid
 * the full AppStartOperation pipeline. AppShutdownOperation is simple
 * enough to use directly.
 *
 * The posthog module receives configuration via config:updated events.
 * Tests simulate this by emitting config:updated events through the
 * dispatcher before exercising hooks.
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
import { createPosthogModule } from "./posthog-module";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
import {
  createMockPostHogClientFactory,
  type MockPostHogClient,
} from "./posthog-client.state-mock";

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

interface TestSetup {
  dispatcher: Dispatcher;
  getMock(): MockPostHogClient | null;
}

function createTestSetup(overrides?: {
  apiKey?: string | undefined;
  workspacePayload?: WorkspaceCreatedPayload;
}): TestSetup {
  const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
  const buildInfo = { version: "1.0.0", isDevelopment: true, isPackaged: false, appPath: "/app" };
  const logger = createBehavioralLogger();
  const { factory, getMock } = createMockPostHogClientFactory();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const posthogModule = createPosthogModule({
    platformInfo,
    buildInfo,
    dispatcher,
    logger,
    apiKey: overrides && "apiKey" in overrides ? overrides.apiKey : "test-api-key",
    host: "https://test.posthog.com",
    postHogClientFactory: factory,
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

  dispatcher.registerModule(posthogModule);

  return { dispatcher, getMock };
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

/** Enable telemetry with a distinct ID so captures work */
async function enableTelemetry(
  dispatcher: Dispatcher,
  overrides?: { agent?: string; distinctId?: string }
): Promise<void> {
  await dispatcher.dispatch(
    configSetValuesIntent({
      "telemetry.enabled": true,
      "telemetry.distinct-id": overrides?.distinctId ?? "test-distinct-id",
      agent: overrides?.agent ?? "opencode",
    })
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("PosthogModule Integration", () => {
  describe("config:updated event handling", () => {
    it("creates PostHog client when telemetry values arrive with enabled=true", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher);

      // Client should have been created
      expect(getMock()).not.toBeNull();
    });

    it("does not create PostHog client when telemetry.enabled is false", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await dispatcher.dispatch(
        configSetValuesIntent({ "telemetry.enabled": false, "telemetry.distinct-id": "id-1" })
      );

      expect(getMock()).toBeNull();
    });

    it("tracks agent and includes it in captures", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // First event: only agent — no client yet (telemetry.enabled not received)
      await dispatcher.dispatch(configSetValuesIntent({ agent: "claude" }));
      expect(getMock()).toBeNull();

      // Second event: telemetry values arrive — client created
      await dispatcher.dispatch(
        configSetValuesIntent({ "telemetry.enabled": true, "telemetry.distinct-id": "id-1" })
      );

      // Trigger a capture to verify agent is tracked
      await dispatcher.dispatch(appResumeIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_resume", { agent: "claude" });
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

        // Should have exactly 2 handlers (uncaughtExceptionMonitor + unhandledRejection)
        expect(registeredHandlers).toHaveLength(2);
      } finally {
        process.on = originalOn;
      }
    });

    it("error handler captures error to PostHog without re-throwing", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher, getMock } = createTestSetup();

        await enableTelemetry(dispatcher);

        const monitorHandler = registeredHandlers.find(
          (h) => h.event === "uncaughtExceptionMonitor"
        );

        // Monitor handler should capture error without re-throwing
        const testError = new Error("test uncaught");
        monitorHandler!.handler(testError);

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("error", { message: "test uncaught" });
      } finally {
        process.on = originalOn;
      }
    });

    it("registers unhandledRejection handler when telemetry is enabled", async () => {
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

        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");
        expect(rejectionHandler).toBeDefined();
      } finally {
        process.on = originalOn;
      }
    });

    it("unhandledRejection handler captures error to PostHog", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher, getMock } = createTestSetup();

        await enableTelemetry(dispatcher);

        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");

        const testError = new Error("test rejection");
        rejectionHandler!.handler(testError);

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("error", { message: "test rejection" });
      } finally {
        process.on = originalOn;
      }
    });

    it("unhandledRejection handler wraps non-Error reasons", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher, getMock } = createTestSetup();

        await enableTelemetry(dispatcher);

        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");

        rejectionHandler!.handler("string rejection reason");

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("error", { message: "string rejection reason" });
      } finally {
        process.on = originalOn;
      }
    });

    it("no-op when API key is missing", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: undefined });

      await enableTelemetry(dispatcher);

      // No client created because no API key
      expect(getMock()).toBeNull();
    });

    it("no-op when API key is empty string", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: "" });

      await enableTelemetry(dispatcher);

      // No client created because API key is empty
      expect(getMock()).toBeNull();
    });
  });

  describe("app:start hook", () => {
    it("captures app_launched with platform info when agent is configured", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher, { agent: "opencode" });
      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_launched", {
        platform: "darwin",
        arch: "arm64",
        isDevelopment: true,
        agent: "opencode",
      });
    });

    it("includes version in captured events", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher, { agent: "opencode" });
      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_launched", { version: "1.0.0" });
    });

    it("does not capture app_launched when no config:updated with agent received", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await dispatcher.dispatch(startIntent());

      // No client created (no config:updated), so nothing captured
      expect(getMock()).toBeNull();
    });

    it("does not capture app_launched when API key is missing", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: undefined });

      await dispatcher.dispatch(
        configSetValuesIntent({
          agent: "opencode",
          "telemetry.enabled": true,
          "telemetry.distinct-id": "id-1",
        })
      );
      await dispatcher.dispatch(startIntent());

      expect(getMock()).toBeNull();
    });

    it("generates distinctId during start hook when telemetry enabled and no id", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // Telemetry enabled but no distinctId
      await dispatcher.dispatch(
        configSetValuesIntent({ "telemetry.enabled": true, agent: "claude" })
      );

      // Start hook triggers ID generation + config:set-values dispatch
      await dispatcher.dispatch(startIntent());

      // Should have captured app_launched (agent was configured)
      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_launched", { agent: "claude" });
    });

    it("stored distinct-id from init takes precedence over generation", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await dispatcher.dispatch(
        configSetValuesIntent({
          "telemetry.enabled": true,
          "telemetry.distinct-id": "stored-id-from-config",
          agent: "opencode",
        })
      );

      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      // Event should use the stored distinct ID
      const event = mock.$.capturedEvents.find((e) => e.event === "app_launched");
      expect(event?.distinctId).toBe("stored-id-from-config");
    });
  });

  describe("app:shutdown hook", () => {
    it("calls PostHog client shutdown", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher);
      await dispatcher.dispatch(shutdownIntent());

      const mock = getMock()!;
      expect(mock).toHaveBeenShutdown();
    });

    it("no API key -- no errors on shutdown", async () => {
      const { dispatcher } = createTestSetup({ apiKey: undefined });

      await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
    });

    it("shutdown() throws -- collect catches error, dispatch still resolves", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // Enable telemetry so client is created, then make shutdown throw
      await enableTelemetry(dispatcher);
      const mock = getMock()!;
      // Override shutdown to throw
      mock.shutdown = async () => {
        throw new Error("PostHog flush failed");
      };

      // Handler throws, but collect() catches it and shutdown is best-effort
      await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
    });
  });

  describe("workspace:created event", () => {
    it("captures workspace_created for new workspaces", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher, { agent: "opencode" });
      await dispatcher.dispatch(openWorkspaceIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("workspace_created", {
        platform: "darwin",
        arch: "arm64",
        isDevelopment: true,
        agent: "opencode",
      });
    });

    it("does not capture workspace_created for reopened workspaces", async () => {
      const { dispatcher, getMock } = createTestSetup({
        workspacePayload: REOPENED_WORKSPACE_PAYLOAD,
      });

      await enableTelemetry(dispatcher, { agent: "opencode" });
      await dispatcher.dispatch(openWorkspaceIntent());

      const mock = getMock()!;
      expect(mock.$.capturedEvents.filter((e) => e.event === "workspace_created")).toHaveLength(0);
    });

    it("no-op when API key is missing", async () => {
      const { dispatcher } = createTestSetup({ apiKey: undefined });

      await expect(dispatcher.dispatch(openWorkspaceIntent())).resolves.toBeUndefined();
    });
  });

  describe("app:resumed event", () => {
    it("captures app_resume on system wake", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher, { agent: "claude" });
      await dispatcher.dispatch(appResumeIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_resume", {
        platform: "darwin",
        arch: "arm64",
        isDevelopment: true,
        agent: "claude",
      });
    });

    it("no-op when API key is missing", async () => {
      const { dispatcher } = createTestSetup({ apiKey: undefined });

      await expect(dispatcher.dispatch(appResumeIntent())).resolves.toBeUndefined();
    });
  });

  describe("capture behavior", () => {
    it("no-op when not configured", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // Dispatch workspace event without configuring telemetry first
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(getMock()).toBeNull();
    });

    it("no-op when disabled after being enabled", async () => {
      const { dispatcher, getMock } = createTestSetup();

      await enableTelemetry(dispatcher);

      // First capture should work
      await dispatcher.dispatch(appResumeIntent());
      const mock = getMock()!;
      expect(mock.$.capturedEvents).toHaveLength(1);

      // Disable telemetry
      await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": false }));

      // Second capture should be a no-op
      await dispatcher.dispatch(appResumeIntent());
      expect(mock.$.capturedEvents).toHaveLength(1);
    });

    it("no-op when distinctId is not set", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // Enable without distinctId
      await dispatcher.dispatch(configSetValuesIntent({ "telemetry.enabled": true }));

      // Client created (enabled with API key) but no event captured (no distinctId)
      const mock = getMock()!;
      await dispatcher.dispatch(appResumeIntent());
      expect(mock.$.capturedEvents).toHaveLength(0);
    });
  });

  describe("error stack sanitization", () => {
    it("sanitizes user paths from error stacks", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher, getMock } = createTestSetup();
        const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
        const homeDir = platformInfo.homeDir;

        await enableTelemetry(dispatcher);

        const monitorHandler = registeredHandlers.find(
          (h) => h.event === "uncaughtExceptionMonitor"
        );

        // Create error with home directory in stack
        const error = new Error("Test error");
        error.stack = `Error: Test error
    at Object.<anonymous> (${homeDir}/projects/myapp/src/index.ts:10:5)
    at Module._compile (node:internal/modules/cjs/loader:1369:14)
    at ${homeDir}/.config/myapp/plugin.js:5:10`;

        monitorHandler!.handler(error);

        const mock = getMock()!;
        const errorEvent = mock.$.capturedEvents.find((e) => e.event === "error");
        expect(errorEvent).toBeDefined();

        const stack = errorEvent?.properties?.stack as string;
        expect(stack).not.toContain(homeDir);
        expect(stack).toContain("<home>");
      } finally {
        process.on = originalOn;
      }
    });
  });
});
