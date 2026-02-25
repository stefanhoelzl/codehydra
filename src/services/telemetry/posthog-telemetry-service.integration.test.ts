/**
 * Integration tests for PostHogTelemetryService.
 *
 * Tests use behavioral mocks for PostHogClient. The service no longer
 * depends on ConfigService -- configuration is driven externally via
 * the configure() method.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PostHogTelemetryService } from "./posthog-telemetry-service";
import type { TelemetryServiceDeps } from "./types";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { createBehavioralLogger, type BehavioralLogger } from "../logging/logging.test-utils";
import type { BuildInfo } from "../platform/build-info";
import type { PlatformInfo } from "../platform/platform-info";
import {
  createMockPostHogClientFactory,
  type MockPostHogClient,
} from "./posthog-client.state-mock";

describe("PostHogTelemetryService", () => {
  let buildInfo: BuildInfo;
  let platformInfo: PlatformInfo;
  let logger: BehavioralLogger;

  // Mock PostHog client factory
  let postHogFactory: ReturnType<typeof createMockPostHogClientFactory>;

  beforeEach(() => {
    buildInfo = createMockBuildInfo({ version: "1.0.0", isDevelopment: false });
    platformInfo = createMockPlatformInfo();

    // Create behavioral logger for telemetry service
    logger = createBehavioralLogger();

    // Create fresh PostHog mock factory
    postHogFactory = createMockPostHogClientFactory();
  });

  function createDeps(overrides?: Partial<TelemetryServiceDeps>): TelemetryServiceDeps {
    return {
      buildInfo,
      platformInfo,
      logger,
      apiKey: "test-api-key",
      host: "https://test.posthog.com",
      postHogClientFactory: postHogFactory.factory,
      ...overrides,
    };
  }

  function getMock(): MockPostHogClient {
    const mock = postHogFactory.getMock();
    if (!mock) {
      throw new Error("PostHog client not created yet");
    }
    return mock;
  }

  describe("capture", () => {
    it("captures app_launched when enabled", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", {
        platform: "linux",
        arch: "x64",
        isDevelopment: false,
      });

      const mock = getMock();
      expect(mock).toHaveCaptured("app_launched");
      expect(mock).toHaveCaptured("app_launched", { platform: "linux" });
      expect(mock).toHaveCaptured("app_launched", { version: "1.0.0" });
    });

    it("no-op when telemetry disabled via configure", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: false });

      service.capture("app_launched", { platform: "linux" });

      // No mock created because telemetry is disabled
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when API key is missing", () => {
      const service = new PostHogTelemetryService(createDeps({ apiKey: undefined }));
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", { platform: "linux" });

      // No mock created because no API key
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when API key is empty string", () => {
      const service = new PostHogTelemetryService(createDeps({ apiKey: "" }));
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", { platform: "linux" });

      // No mock created because API key is empty
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when configure has not been called", () => {
      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", { platform: "linux" });

      // No mock created because configure() was never called
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when distinctId is not set", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true });

      service.capture("app_launched", { platform: "linux" });

      // Client created (enabled with API key) but no event captured (no distinctId)
      const mock = getMock();
      expect(mock.$.capturedEvents).toHaveLength(0);
    });

    it("logs events at INFO level", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", { platform: "linux" });

      const infoMessages = logger.getMessagesByLevel("info");
      expect(infoMessages.length).toBeGreaterThan(0);
      expect(infoMessages.some((m) => m.message === "Telemetry event")).toBe(true);
      expect(infoMessages.some((m) => m.context?.event === "app_launched")).toBe(true);
    });
  });

  describe("captureError", () => {
    it("captures error events", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      const error = new Error("Test error message");
      service.captureError(error);

      const mock = getMock();
      expect(mock).toHaveCapturedError();
      expect(mock).toHaveCaptured("error", { message: "Test error message" });
    });

    it("sanitizes user paths from error stacks", () => {
      // Use platform-specific home directory
      const homeDir = platformInfo.homeDir;
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      // Create error with home directory in stack
      const error = new Error("Test error");
      error.stack = `Error: Test error
    at Object.<anonymous> (${homeDir}/projects/myapp/src/index.ts:10:5)
    at Module._compile (node:internal/modules/cjs/loader:1369:14)
    at ${homeDir}/.config/myapp/plugin.js:5:10`;

      service.captureError(error);

      const mock = getMock();
      const errorEvent = mock.$.capturedEvents.find((e) => e.event === "error");
      expect(errorEvent).toBeDefined();

      const stack = errorEvent?.properties?.stack as string;
      expect(stack).not.toContain(homeDir);
      expect(stack).toContain("<home>");
    });
  });

  describe("shutdown", () => {
    it("flushes pending events on shutdown", async () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", {});

      await service.shutdown();

      const mock = getMock();
      expect(mock).toHaveBeenShutdown();
    });
  });

  describe("distinctId", () => {
    it("uses provided distinctId from configure()", () => {
      const testDistinctId = "test-uuid-12345";
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: testDistinctId });

      service.capture("app_launched", {});

      const mock = getMock();
      const event = mock.$.capturedEvents[0];
      expect(event?.distinctId).toBe(testDistinctId);
    });

    it("generateDistinctId returns a UUID when enabled", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true });

      const id = service.generateDistinctId();

      expect(id).toBeDefined();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("generateDistinctId sets the distinctId for subsequent captures", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true });

      const id = service.generateDistinctId();
      service.capture("app_launched", {});

      const mock = getMock();
      const event = mock.$.capturedEvents[0];
      expect(event?.distinctId).toBe(id);
    });

    it("generateDistinctId returns undefined when disabled", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: false });

      const id = service.generateDistinctId();

      expect(id).toBeUndefined();
    });
  });

  describe("configure", () => {
    it("enables telemetry when called with enabled: true and distinctId", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      service.capture("app_launched", {});

      const mock = getMock();
      expect(mock).toHaveCaptured("app_launched");
    });

    it("can be reconfigured to disable telemetry", () => {
      const service = new PostHogTelemetryService(createDeps());
      service.configure({ enabled: true, distinctId: "test-id" });

      // First capture should work
      service.capture("app_launched", {});
      const mock = getMock();
      expect(mock.$.capturedEvents).toHaveLength(1);

      // Disable telemetry
      service.configure({ enabled: false });

      // Second capture should be a no-op
      service.capture("app_launched", {});
      expect(mock.$.capturedEvents).toHaveLength(1);
    });
  });
});
