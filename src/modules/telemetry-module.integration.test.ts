// @vitest-environment node
/**
 * Integration tests for TelemetryModule through the Dispatcher.
 *
 * Verifies passive-event capture, person identification, distinct-id lifecycle,
 * and shutdown — all driven through the shared PostHogBoundary (mocked). Crash
 * and bug-report handling live in error-report-module and are tested there.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
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
import { INTENT_APP_RESUME, AppResumeOperation, type AppResumeIntent } from "../intents/app-resume";
import { createTelemetryModule } from "./telemetry-module";
import { createMockPlatformInfo } from "../boundaries/platform/platform-info.test-utils";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import {
  createMockPostHogBoundary,
  type MockPostHogBoundary,
} from "../boundaries/platform/posthog.state-mock";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { createMockConfig, createMockAccessor } from "../boundaries/platform/config.test-utils";
import { createMockState, type MockStateService } from "../boundaries/platform/state.test-utils";
import { createStateMigrationRegistry } from "./state-module";
import type { Operation, OperationContext } from "../intents/lib/operation";

// =============================================================================
// Helpers
// =============================================================================

/** Minimal workspace:open operation that emits workspace:created. */
class MinimalOpenWorkspaceOperation implements Operation<OpenWorkspaceIntent, void> {
  readonly id = "open-workspace";
  constructor(private readonly eventPayload: WorkspaceCreatedPayload) {}
  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<void> {
    ctx.emit({ type: "workspace:created", payload: this.eventPayload });
  }
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

interface TestSetup {
  dispatcher: Dispatcher;
  boundary: MockPostHogBoundary;
  state: MockStateService;
}

function createTestSetup(overrides?: {
  telemetryEnabled?: boolean;
  distinctId?: string | null;
  agent?: ConfigAgentType;
  configOverrides?: Record<string, unknown>;
  workspacePayload?: WorkspaceCreatedPayload;
}): TestSetup {
  const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
  const buildInfo = { version: "1.0.0", isDevelopment: true, isPackaged: false, appPath: "/app" };
  const logger = createBehavioralLogger();
  const boundary = createMockPostHogBoundary();

  const mockConfig = createMockConfig({
    ...(overrides?.configOverrides !== undefined && { overrides: overrides.configOverrides }),
  });
  const state = createMockState({
    values: { "telemetry.distinct-id": overrides?.distinctId ?? null },
  });

  const dispatcher = createMockDispatcher();

  // `undefined` agent is the "not configured" signal the module checks for.
  const agentConfig = createMockAccessor<ConfigAgentType>(
    "agent",
    overrides?.agent as ConfigAgentType
  );
  const telemetryEnabled = createMockAccessor<boolean>(
    "telemetry.enabled",
    overrides?.telemetryEnabled ?? false
  );

  const module = createTelemetryModule({
    platformInfo,
    buildInfo,
    configService: mockConfig,
    stateService: state,
    stateMigrations: createStateMigrationRegistry(),
    agentConfig,
    telemetryEnabled,
    boundary,
    logger,
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
  dispatcher.registerModule(module);

  return { dispatcher, boundary, state };
}

const startIntent = (): AppStartIntent => ({
  type: INTENT_APP_START,
  payload: {} as AppStartIntent["payload"],
});
const shutdownIntent = (): AppShutdownIntent => ({
  type: INTENT_APP_SHUTDOWN,
  payload: {} as AppShutdownIntent["payload"],
});
const openWorkspaceIntent = (): OpenWorkspaceIntent =>
  ({
    type: INTENT_OPEN_WORKSPACE,
    payload: { workspaceName: "ws-1", projectPath: "/proj" },
  }) as OpenWorkspaceIntent;
const appResumeIntent = (): AppResumeIntent => ({
  type: INTENT_APP_RESUME,
  payload: {} as AppResumeIntent["payload"],
});

// =============================================================================
// Tests
// =============================================================================

describe("TelemetryModule Integration", () => {
  describe("app:start", () => {
    it("captures app_launched with common props when enabled and agent configured", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());

      expect(boundary).toHaveCaptured("app_launched", {
        version: "1.0.0",
        platform: "darwin",
        arch: "arm64",
        agent: "claude",
      });
    });

    it("does not capture app_launched when telemetry is disabled", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: false,
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());

      expect(boundary.$.capturedEvents.filter((e) => e.event === "app_launched")).toHaveLength(0);
    });

    it("does not capture app_launched when agent is not configured", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
      });

      await dispatcher.dispatch(startIntent());

      expect(boundary.$.capturedEvents.filter((e) => e.event === "app_launched")).toHaveLength(0);
    });

    it("generates and persists a distinct id when enabled and none stored", async () => {
      const { dispatcher, boundary, state } = createTestSetup({
        telemetryEnabled: true,
        distinctId: null,
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());

      const persisted = state.getEffective()["telemetry.distinct-id"];
      expect(typeof persisted).toBe("string");
      expect(persisted).not.toBe("");

      const launched = boundary.$.capturedEvents.find((e) => e.event === "app_launched");
      expect(launched?.distinctId).toBe(persisted);
    });

    it("uses the stored distinct id without regenerating", async () => {
      const { dispatcher, boundary, state } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "stored-id",
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());

      expect(state.getEffective()["telemetry.distinct-id"]).toBe("stored-id");
      const launched = boundary.$.capturedEvents.find((e) => e.event === "app_launched");
      expect(launched?.distinctId).toBe("stored-id");
    });

    it("identifies the person with redacted config overrides when enabled", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
        configOverrides: { agent: "claude", "log.level": "debug" },
      });

      await dispatcher.dispatch(startIntent());

      expect(boundary.$.identifyCalls).toHaveLength(1);
      expect(boundary.$.identifyCalls[0]).toMatchObject({
        distinctId: "test-id",
        properties: { config: { agent: "claude", "log.level": "debug" } },
      });
    });

    it("does not identify when telemetry is disabled", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: false,
        distinctId: "test-id",
      });

      await dispatcher.dispatch(startIntent());

      expect(boundary.$.identifyCalls).toHaveLength(0);
    });
  });

  describe("workspace:created", () => {
    it("captures workspace_created for new workspaces", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(boundary).toHaveCaptured("workspace_created", { platform: "darwin" });
    });

    it("does not capture workspace_created for reopened workspaces", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
        workspacePayload: REOPENED_WORKSPACE_PAYLOAD,
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(boundary.$.capturedEvents.filter((e) => e.event === "workspace_created")).toHaveLength(
        0
      );
    });

    it("does not capture workspace_created when telemetry is disabled", async () => {
      const { dispatcher, boundary } = createTestSetup({ telemetryEnabled: false });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(openWorkspaceIntent());

      expect(boundary.$.capturedEvents.filter((e) => e.event === "workspace_created")).toHaveLength(
        0
      );
    });
  });

  describe("app:resumed", () => {
    it("captures app_resume on wake when enabled", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(appResumeIntent());

      expect(boundary).toHaveCaptured("app_resume");
    });

    it("does not capture app_resume when telemetry is disabled", async () => {
      const { dispatcher, boundary } = createTestSetup({ telemetryEnabled: false });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(appResumeIntent());

      expect(boundary.$.capturedEvents.filter((e) => e.event === "app_resume")).toHaveLength(0);
    });
  });

  describe("app:shutdown", () => {
    it("shuts down the boundary", async () => {
      const { dispatcher, boundary } = createTestSetup({
        telemetryEnabled: true,
        distinctId: "test-id",
        agent: "claude",
      });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(shutdownIntent());

      expect(boundary).toHaveBeenShutdown();
    });
  });
});
