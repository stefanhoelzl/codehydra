// @vitest-environment node
/**
 * Integration tests for PosthogModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> PosthogModule handler
 *
 * The posthog module now reads configuration from Config
 * during the app:start hook. Tests set config values in the mock
 * before dispatching.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../intents/app-shutdown";
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type WorkspaceCreatedPayload,
} from "../intents/open-workspace";
import { INTENT_APP_RESUME, type AppResumeIntent } from "../intents/app-resume";
import { AppResumeOperation } from "../intents/app-resume";
import {
  INTENT_SUBMIT_BUG_REPORT,
  SubmitBugReportOperation,
  type SubmitBugReportIntent,
} from "../intents/submit-bug-report";
import { createPosthogModule } from "./posthog-module";
import { createMockPlatformInfo } from "../boundaries/platform/platform-info.test-utils";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import {
  createMockPostHogClientFactory,
  type MockPostHogClient,
} from "./posthog-client.state-mock";
import type { Config, ConfigAgentType } from "../boundaries/platform/config";
import { createMockConfig, createMockAccessor } from "../boundaries/platform/config.test-utils";
import { createMockState } from "../boundaries/platform/state.test-utils";
import { createStateMigrationRegistry } from "./state-module";
import type { Operation, OperationContext } from "../intents/lib/operation";

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
  mockConfig: Config;
  getMock(): MockPostHogClient | null;
}

function createTestSetup(overrides?: {
  apiKey?: string | undefined;
  workspacePayload?: WorkspaceCreatedPayload;
  configValues?: Record<string, unknown>;
  configOverrides?: Record<string, unknown>;
}): TestSetup {
  const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
  const buildInfo = { version: "1.0.0", isDevelopment: true, isPackaged: false, appPath: "/app" };
  const logger = createBehavioralLogger();
  const { factory, getMock } = createMockPostHogClientFactory();
  const mockConfig = createMockConfig({
    defaults: {
      "telemetry.enabled": false,
      ...overrides?.configValues,
    },
    ...(overrides?.configOverrides !== undefined && { overrides: overrides.configOverrides }),
  });

  // telemetry.distinct-id now lives in state.json (StateService), not config.
  const mockState = createMockState({
    values: { "telemetry.distinct-id": overrides?.configValues?.["telemetry.distinct-id"] ?? null },
  });

  const dispatcher = createMockDispatcher();

  // The module distinguishes a configured agent from "not configured" via
  // `=== undefined`. When a test supplies no agent, the accessor reads as
  // undefined (the unset signal); otherwise it reflects the configured value.
  const agentValue = overrides?.configValues?.agent as ConfigAgentType;
  const agentConfig = createMockAccessor<ConfigAgentType>("agent", agentValue);

  const posthogModule = createPosthogModule({
    platformInfo,
    buildInfo,
    configService: mockConfig,
    stateService: mockState,
    stateMigrations: createStateMigrationRegistry(),
    agentConfig,
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
  dispatcher.registerOperation(
    INTENT_OPEN_WORKSPACE,
    new MinimalOpenWorkspaceOperation(overrides?.workspacePayload ?? NEW_WORKSPACE_PAYLOAD)
  );
  dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());
  dispatcher.registerOperation(INTENT_SUBMIT_BUG_REPORT, new SubmitBugReportOperation());

  dispatcher.registerModule(posthogModule);

  return { dispatcher, mockConfig, getMock };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

function shutdownIntent(): AppShutdownIntent {
  return { type: INTENT_APP_SHUTDOWN, payload: {} as AppShutdownIntent["payload"] };
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

function submitBugReportIntent(
  description: string,
  logs: string,
  electronLogs = ""
): SubmitBugReportIntent {
  return { type: INTENT_SUBMIT_BUG_REPORT, payload: { description, logs, electronLogs } };
}

// =============================================================================
// Tests
// =============================================================================

describe("PosthogModule Integration", () => {
  describe("app:start hook", () => {
    it("creates PostHog client and captures app_launched when telemetry enabled", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-distinct-id",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      expect(mock).not.toBeNull();
      expect(mock).toHaveCaptured("app_launched", {
        platform: "darwin",
        arch: "arm64",
        isDevelopment: true,
        agent: "opencode",
      });
    });

    it("does not create PostHog client when telemetry.enabled is false", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: { "telemetry.enabled": false, "telemetry.distinct-id": "id-1" },
      });

      await dispatcher.dispatch(startIntent());

      expect(getMock()).toBeNull();
    });

    it("includes version in captured events", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "id-1",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_launched", { version: "1.0.0" });
    });

    it("does not capture app_launched when agent is not configured", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "id-1",
        },
      });

      await dispatcher.dispatch(startIntent());

      // Client created but no app_launched because agent is undefined
      const mock = getMock()!;
      expect(mock.$.capturedEvents.filter((e) => e.event === "app_launched")).toHaveLength(0);
    });

    it("does not capture app_launched when API key is missing", async () => {
      const { dispatcher, getMock } = createTestSetup({
        apiKey: undefined,
        configValues: {
          agent: "opencode",
          "telemetry.enabled": true,
          "telemetry.distinct-id": "id-1",
        },
      });

      await dispatcher.dispatch(startIntent());

      expect(getMock()).toBeNull();
    });

    it("generates distinctId during start hook when telemetry enabled and no id", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: { "telemetry.enabled": true, agent: "claude" },
      });

      // Start hook triggers ID generation + configService.set
      await dispatcher.dispatch(startIntent());

      // Should have captured app_launched (agent was configured)
      const mock = getMock()!;
      expect(mock).toHaveCaptured("app_launched", { agent: "claude" });
    });

    it("stored distinct-id from config takes precedence over generation", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "stored-id-from-config",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      // Event should use the stored distinct ID
      const event = mock.$.capturedEvents.find((e) => e.event === "app_launched");
      expect(event?.distinctId).toBe("stored-id-from-config");
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
        const { dispatcher } = createTestSetup({
          configValues: { "telemetry.enabled": true },
        });

        await dispatcher.dispatch(startIntent());

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
        const { dispatcher } = createTestSetup({
          configValues: { "telemetry.enabled": false },
        });

        await dispatcher.dispatch(startIntent());

        expect(registeredHandlers).toHaveLength(0);
      } finally {
        process.on = originalOn;
      }
    });

    it("registers error handlers only once", async () => {
      type Handler = (...args: unknown[]) => void;
      const registeredHandlers: { event: string; handler: Handler }[] = [];
      const originalOn = process.on;
      process.on = ((event: string, handler: Handler) => {
        registeredHandlers.push({ event, handler });
        return process;
      }) as typeof process.on;

      try {
        const { dispatcher } = createTestSetup({
          configValues: { "telemetry.enabled": true },
        });

        // Start hook registers error handlers once
        await dispatcher.dispatch(startIntent());

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
        const { dispatcher, getMock } = createTestSetup({
          configValues: { "telemetry.enabled": true, "telemetry.distinct-id": "test-id" },
        });

        await dispatcher.dispatch(startIntent());

        const monitorHandler = registeredHandlers.find(
          (h) => h.event === "uncaughtExceptionMonitor"
        );

        const testError = new Error("test uncaught");
        monitorHandler!.handler(testError);

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("$exception", {
          $exception_list: [{ type: "Error", value: "test uncaught" }],
        });
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
        const { dispatcher } = createTestSetup({
          configValues: { "telemetry.enabled": true },
        });

        await dispatcher.dispatch(startIntent());

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
        const { dispatcher, getMock } = createTestSetup({
          configValues: { "telemetry.enabled": true, "telemetry.distinct-id": "test-id" },
        });

        await dispatcher.dispatch(startIntent());

        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");

        const testError = new Error("test rejection");
        rejectionHandler!.handler(testError);

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("$exception", {
          $exception_list: [{ type: "Error", value: "test rejection" }],
        });
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
        const { dispatcher, getMock } = createTestSetup({
          configValues: { "telemetry.enabled": true, "telemetry.distinct-id": "test-id" },
        });

        await dispatcher.dispatch(startIntent());

        const rejectionHandler = registeredHandlers.find((h) => h.event === "unhandledRejection");

        rejectionHandler!.handler("string rejection reason");

        const mock = getMock()!;
        expect(mock).toHaveCapturedError();
        expect(mock).toHaveCaptured("$exception", {
          $exception_list: [{ type: "Error", value: "string rejection reason" }],
        });
      } finally {
        process.on = originalOn;
      }
    });

    it("no-op when API key is missing", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: undefined });

      await dispatcher.dispatch(startIntent());

      // No client created because no API key
      expect(getMock()).toBeNull();
    });

    it("no-op when API key is empty string", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: "" });

      await dispatcher.dispatch(startIntent());

      // No client created because API key is empty
      expect(getMock()).toBeNull();
    });

    it("identifies person with config overrides via $set", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "opencode",
        },
        configOverrides: { agent: "opencode", "log.level": "debug" },
      });

      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      expect(mock.$.identifyCalls).toHaveLength(1);
      expect(mock.$.identifyCalls[0]).toMatchObject({
        distinctId: "test-id",
        properties: { config: { agent: "opencode", "log.level": "debug" } },
      });
    });

    it("does not identify when telemetry is disabled", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: { "telemetry.enabled": false },
        configOverrides: { agent: "claude" },
      });

      await dispatcher.dispatch(startIntent());

      expect(getMock()).toBeNull();
    });
  });

  describe("app:shutdown hook", () => {
    it("calls PostHog client shutdown", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(shutdownIntent());

      const mock = getMock()!;
      expect(mock).toHaveBeenShutdown();
    });

    it("no API key -- no errors on shutdown", async () => {
      const { dispatcher } = createTestSetup({ apiKey: undefined });

      await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
    });

    it("shutdown() throws -- collect catches error, dispatch still resolves", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "opencode",
        },
      });

      // Enable telemetry so client is created, then make shutdown throw
      await dispatcher.dispatch(startIntent());
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
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());
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
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "opencode",
        },
      });

      await dispatcher.dispatch(startIntent());
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
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
      });

      await dispatcher.dispatch(startIntent());
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
    it("no-op when not configured (telemetry disabled)", async () => {
      const { dispatcher, getMock } = createTestSetup();

      // Dispatch without enabling telemetry
      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(getMock()).toBeNull();
    });

    it("no-op when distinctId is not set", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: { "telemetry.enabled": true },
      });

      // Start will generate distinctId, so this test checks the internal path:
      // Client gets created but won't capture until distinctId is set.
      // In the new module, start generates the ID automatically when enabled.
      await dispatcher.dispatch(startIntent());

      const mock = getMock()!;
      // Should have generated a distinctId and thus captured resume events
      // (since start generates one when missing)
      await dispatcher.dispatch(appResumeIntent());
      expect(mock.$.capturedEvents.filter((e) => e.event === "app_resume")).toHaveLength(1);
    });
  });

  describe("bug-report:submitted event", () => {
    it("captures $exception with BugReport type and logs", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(
        submitBugReportIntent("App freezes on startup", "log line 1\nlog line 2")
      );

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      expect(captured).toBeDefined();
      const props = captured!.properties as Record<string, unknown>;
      expect(props["$exception_list"]).toEqual([
        expect.objectContaining({ type: "BugReport", value: "App freezes on startup" }),
      ]);
      expect(props["logs_format"]).toBe("gzip+base64");
      expect(props["logs_raw_bytes"]).toBe("log line 1\nlog line 2".length);
      const decompressed = (await import("node:zlib"))
        .gunzipSync(Buffer.from(props["logs"] as string, "base64"))
        .toString();
      expect(decompressed).toBe("log line 1\nlog line 2");
    });

    it("trims each log field independently to the 450 KB per-field cap", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
      });

      // Truly random bytes don't compress, so each blob blows past the
      // 450 KB per-field cap and forces the trim loop to drop bytes.
      const { randomBytes } = await import("node:crypto");
      const appRaw = randomBytes(3 * 1024 * 1024).toString("binary");
      const electronRaw = randomBytes(3 * 1024 * 1024).toString("binary");

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("big report", appRaw, electronRaw));

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      expect(captured).toBeDefined();
      const props = captured!.properties as Record<string, unknown>;

      expect((props["logs"] as string).length).toBeLessThanOrEqual(450_000);
      expect(props["logs_raw_bytes_dropped"]).toBeGreaterThan(0);
      expect(
        (props["logs_raw_bytes"] as number) + (props["logs_raw_bytes_dropped"] as number)
      ).toBe(appRaw.length);

      expect((props["electron_logs"] as string).length).toBeLessThanOrEqual(450_000);
      expect(props["electron_logs_format"]).toBe("gzip+base64");
      expect(props["electron_logs_raw_bytes_dropped"]).toBeGreaterThan(0);
      expect(
        (props["electron_logs_raw_bytes"] as number) +
          (props["electron_logs_raw_bytes_dropped"] as number)
      ).toBe(electronRaw.length);
    });

    it("includes electron_logs alongside app logs when both are present", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(
        submitBugReportIntent("two streams", "APP-LOG-CONTENT", "CHROMIUM-LOG-CONTENT")
      );

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      const props = captured!.properties as Record<string, unknown>;
      const { gunzipSync } = await import("node:zlib");
      const decodedApp = gunzipSync(Buffer.from(props["logs"] as string, "base64")).toString();
      const decodedElectron = gunzipSync(
        Buffer.from(props["electron_logs"] as string, "base64")
      ).toString();
      expect(decodedApp).toBe("APP-LOG-CONTENT");
      expect(decodedElectron).toBe("CHROMIUM-LOG-CONTENT");
    });

    it("encodes electron_logs format as 'none' when empty", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("no electron", "APP", ""));

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      const props = captured!.properties as Record<string, unknown>;
      expect(props["electron_logs"]).toBe("");
      expect(props["electron_logs_format"]).toBe("none");
      expect(props["electron_logs_raw_bytes"]).toBe(0);
    });

    it("includes config snapshot on the bug_report event", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": true,
          "telemetry.distinct-id": "test-id",
          agent: "claude",
        },
        configOverrides: { agent: "claude", "log.level": "debug" },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("issue", "logs"));

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      const props = captured!.properties as Record<string, unknown>;
      expect(props["config"]).toEqual({ agent: "claude", "log.level": "debug" });
    });

    it("includes config snapshot on bug_report even when telemetry is disabled", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: { "telemetry.enabled": false, "telemetry.distinct-id": null },
        configOverrides: { "log.level": "debug" },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("oops", "logs"));

      const mock = getMock()!;
      const captured = mock.$.capturedEvents.find((e) => e.event === "$exception");
      const props = captured!.properties as Record<string, unknown>;
      expect(props["config"]).toEqual({ "log.level": "debug" });
    });

    it("sends bug report even when telemetry is disabled", async () => {
      const { dispatcher, getMock } = createTestSetup({
        configValues: {
          "telemetry.enabled": false,
          "telemetry.distinct-id": null,
        },
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("Something broke", "logs here"));

      const mock = getMock()!;
      expect(mock).toHaveCaptured("$exception", {
        $exception_list: [{ type: "BugReport", value: "Something broke" }],
      });
    });

    it("no-op when API key is missing", async () => {
      const { dispatcher, getMock } = createTestSetup({ apiKey: undefined });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(submitBugReportIntent("desc", "logs"));

      expect(getMock()).toBeNull();
    });
  });
});
