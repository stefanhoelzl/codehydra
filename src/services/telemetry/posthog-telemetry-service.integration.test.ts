/**
 * Integration tests for PostHogTelemetryService.
 *
 * Tests use behavioral mocks for PostHogClient and real ConfigService
 * with FileSystemLayer mock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PostHogTelemetryService } from "./posthog-telemetry-service";
import { ConfigService } from "../config/config-service";
import type { TelemetryServiceDeps } from "./types";
import type { AppConfig } from "../config/types";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import {
  createFileSystemMock,
  file,
  directory,
  type MockFileSystemLayer,
} from "../platform/filesystem.state-mock";
import { createBehavioralLogger, type BehavioralLogger } from "../logging/logging.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { BuildInfo } from "../platform/build-info";
import type { PlatformInfo } from "../platform/platform-info";
import {
  createMockPostHogClientFactory,
  type MockPostHogClient,
} from "./posthog-client.state-mock";

describe("PostHogTelemetryService", () => {
  let fileSystem: MockFileSystemLayer;
  let pathProvider: PathProvider;
  let buildInfo: BuildInfo;
  let platformInfo: PlatformInfo;
  let configService: ConfigService;
  let logger: BehavioralLogger;

  // Mock PostHog client factory
  let postHogFactory: ReturnType<typeof createMockPostHogClientFactory>;

  beforeEach(() => {
    // Reset mocks
    pathProvider = createMockPathProvider();
    buildInfo = createMockBuildInfo({ version: "1.0.0", isDevelopment: false });
    platformInfo = createMockPlatformInfo();

    // Create filesystem with parent directory for config file
    fileSystem = createFileSystemMock({
      entries: {
        [pathProvider.dataRootDir.toString()]: directory(),
      },
    });

    // Create real ConfigService with mock filesystem
    configService = new ConfigService({
      fileSystem,
      pathProvider,
      logger: createBehavioralLogger(),
    });

    // Create behavioral logger for telemetry service
    logger = createBehavioralLogger();

    // Create fresh PostHog mock factory
    postHogFactory = createMockPostHogClientFactory();
  });

  function createDeps(overrides?: Partial<TelemetryServiceDeps>): TelemetryServiceDeps {
    return {
      buildInfo,
      platformInfo,
      configService,
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
    it("captures app_launched when enabled", async () => {
      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", {
        platform: "linux",
        arch: "x64",
        isDevelopment: false,
      });

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const mock = getMock();
      expect(mock).toHaveCaptured("app_launched");
      expect(mock).toHaveCaptured("app_launched", { platform: "linux" });
      expect(mock).toHaveCaptured("app_launched", { version: "1.0.0" });
    });

    it("no-op when telemetry disabled in config", async () => {
      // Pre-create config with telemetry disabled
      const config: AppConfig = {
        agent: null,
        versions: { claude: null, opencode: null, codeServer: "4.107.0" },
        telemetry: { enabled: false },
      };
      fileSystem.$.setEntry(pathProvider.configPath.toString(), file(JSON.stringify(config)));

      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", { platform: "linux" });

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No mock created because telemetry is disabled
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when API key is missing", async () => {
      const service = new PostHogTelemetryService(createDeps({ apiKey: undefined }));

      service.capture("app_launched", { platform: "linux" });

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No mock created because no API key
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("no-op when API key is empty string", async () => {
      const service = new PostHogTelemetryService(createDeps({ apiKey: "" }));

      service.capture("app_launched", { platform: "linux" });

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No mock created because API key is empty
      expect(postHogFactory.getMock()).toBeNull();
    });

    it("logs events at INFO level", async () => {
      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", { platform: "linux" });

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const infoMessages = logger.getMessagesByLevel("info");
      expect(infoMessages.length).toBeGreaterThan(0);
      expect(infoMessages.some((m) => m.message === "Telemetry event")).toBe(true);
      expect(infoMessages.some((m) => m.context?.event === "app_launched")).toBe(true);
    });
  });

  describe("captureError", () => {
    it("captures error events", async () => {
      const service = new PostHogTelemetryService(createDeps());

      const error = new Error("Test error message");
      service.captureError(error);

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const mock = getMock();
      expect(mock).toHaveCapturedError();
      expect(mock).toHaveCaptured("error", { message: "Test error message" });
    });

    it("sanitizes user paths from error stacks", async () => {
      // Use platform-specific home directory
      const homeDir = platformInfo.homeDir;
      const service = new PostHogTelemetryService(createDeps());

      // Create error with home directory in stack
      const error = new Error("Test error");
      error.stack = `Error: Test error
    at Object.<anonymous> (${homeDir}/projects/myapp/src/index.ts:10:5)
    at Module._compile (node:internal/modules/cjs/loader:1369:14)
    at ${homeDir}/.config/myapp/plugin.js:5:10`;

      service.captureError(error);

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

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

      // Trigger initialization by capturing an event
      service.capture("app_launched", {});
      await new Promise((resolve) => setTimeout(resolve, 10));

      await service.shutdown();

      const mock = getMock();
      expect(mock).toHaveBeenShutdown();
    });
  });

  describe("distinctId persistence", () => {
    it("uses persisted distinctId across restarts", async () => {
      const testDistinctId = "test-uuid-12345";

      // Pre-create config with existing distinctId
      const config: AppConfig = {
        agent: null,
        versions: { claude: null, opencode: null, codeServer: "4.107.0" },
        telemetry: { enabled: true, distinctId: testDistinctId },
      };
      fileSystem.$.setEntry(pathProvider.configPath.toString(), file(JSON.stringify(config)));

      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", {});

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const mock = getMock();
      const event = mock.$.capturedEvents[0];
      expect(event?.distinctId).toBe(testDistinctId);
    });

    it("generates and persists new distinctId if missing", async () => {
      // Start with default config (no distinctId)
      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", {});

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check that distinctId was generated and persisted
      const configContent = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(configContent?.type).toBe("file");
      if (configContent?.type === "file") {
        const savedConfig = JSON.parse(configContent.content as string) as AppConfig;
        expect(savedConfig.telemetry?.distinctId).toBeDefined();
        expect(savedConfig.telemetry?.distinctId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
      }
    });
  });

  describe("backwards compatibility", () => {
    it("enables telemetry by default when telemetry config is missing", async () => {
      // Pre-create config without telemetry field (old config format)
      const config = {
        agent: null,
        versions: { claude: null, opencode: null, codeServer: "4.107.0" },
      };
      fileSystem.$.setEntry(pathProvider.configPath.toString(), file(JSON.stringify(config)));

      const service = new PostHogTelemetryService(createDeps());

      service.capture("app_launched", {});

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have captured the event (telemetry enabled by default)
      const mock = getMock();
      expect(mock).toHaveCaptured("app_launched");
    });
  });
});
