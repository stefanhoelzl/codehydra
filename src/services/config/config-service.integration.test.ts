/**
 * Integration tests for ConfigService.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ConfigService } from "./config-service";
import { DEFAULT_APP_CONFIG } from "./types";
import type { AppConfig } from "./types";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import {
  createFileSystemMock,
  file,
  directory,
  type MockFileSystemLayer,
} from "../platform/filesystem.state-mock";
import { createMockLogger } from "../logging/logging.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { Logger } from "../logging";

describe("ConfigService", () => {
  let fileSystem: MockFileSystemLayer;
  let pathProvider: PathProvider;
  let logger: Logger;

  beforeEach(() => {
    pathProvider = createMockPathProvider();
    // Create filesystem with parent directory for config file
    fileSystem = createFileSystemMock({
      entries: {
        [pathProvider.dataRootDir.toString()]: directory(),
      },
    });
    logger = createMockLogger();
  });

  function createService(): ConfigService {
    return new ConfigService({
      fileSystem,
      pathProvider,
      logger,
    });
  }

  describe("load", () => {
    it("returns default config when file does not exist", async () => {
      const service = createService();

      const config = await service.load();

      expect(config).toEqual(DEFAULT_APP_CONFIG);
    });

    it("writes default config when file does not exist", async () => {
      const service = createService();

      await service.load();

      expect(fileSystem).toHaveFile(pathProvider.configPath.toString());
      const entry = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(entry?.type).toBe("file");
      if (entry?.type === "file") {
        const parsed = JSON.parse(entry.content as string);
        expect(parsed).toEqual(DEFAULT_APP_CONFIG);
      }
    });

    it("parses existing config file", async () => {
      const existingConfig: AppConfig = {
        agent: "claude",
        versions: {
          claude: "1.0.58",
          opencode: null,
          codeServer: "4.107.0",
        },
      };
      fileSystem.$.setEntry(
        pathProvider.configPath.toString(),
        file(JSON.stringify(existingConfig))
      );

      const service = createService();
      const config = await service.load();

      expect(config).toEqual(existingConfig);
    });

    it("returns defaults when JSON is corrupt", async () => {
      fileSystem.$.setEntry(pathProvider.configPath.toString(), file("{ invalid json }"));

      const service = createService();
      const config = await service.load();

      expect(config).toEqual(DEFAULT_APP_CONFIG);
    });

    it("returns defaults when config structure is invalid", async () => {
      // Missing versions field
      fileSystem.$.setEntry(
        pathProvider.configPath.toString(),
        file(JSON.stringify({ agent: "claude" }))
      );

      const service = createService();
      const config = await service.load();

      expect(config).toEqual(DEFAULT_APP_CONFIG);
    });

    it("returns defaults when agent type is invalid", async () => {
      fileSystem.$.setEntry(
        pathProvider.configPath.toString(),
        file(
          JSON.stringify({
            agent: "invalid-agent",
            versions: { claude: null, opencode: null, codeServer: "4.107.0" },
          })
        )
      );

      const service = createService();
      const config = await service.load();

      expect(config).toEqual(DEFAULT_APP_CONFIG);
    });
  });

  describe("save", () => {
    it("writes formatted JSON to config path", async () => {
      const config: AppConfig = {
        agent: "opencode",
        versions: {
          claude: null,
          opencode: "1.0.223",
          codeServer: "4.107.0",
        },
      };

      const service = createService();
      await service.save(config);

      const entry = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(entry?.type).toBe("file");
      if (entry?.type === "file") {
        const content = entry.content as string;
        // Check it's formatted with indentation
        expect(content).toContain("\n  ");
        const parsed = JSON.parse(content);
        expect(parsed).toEqual(config);
      }
    });

    it("creates parent directory if needed", async () => {
      const service = createService();
      await service.save(DEFAULT_APP_CONFIG);

      // Parent directory should exist
      expect(fileSystem).toHaveDirectory(pathProvider.configPath.dirname.toString());
    });
  });

  describe("setAgent", () => {
    it("updates agent in config", async () => {
      const service = createService();

      await service.setAgent("claude");

      const entry = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(entry?.type).toBe("file");
      if (entry?.type === "file") {
        const parsed = JSON.parse(entry.content as string);
        expect(parsed.agent).toBe("claude");
      }
    });

    it("preserves existing version config", async () => {
      const existingConfig: AppConfig = {
        agent: null,
        versions: {
          claude: "1.0.58",
          opencode: "1.0.223",
          codeServer: "4.100.0",
        },
      };
      fileSystem.$.setEntry(
        pathProvider.configPath.toString(),
        file(JSON.stringify(existingConfig))
      );

      const service = createService();
      await service.setAgent("opencode");

      const entry = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(entry?.type).toBe("file");
      if (entry?.type === "file") {
        const parsed = JSON.parse(entry.content as string);
        expect(parsed.agent).toBe("opencode");
        expect(parsed.versions).toEqual(existingConfig.versions);
      }
    });

    it("can set agent to null", async () => {
      const existingConfig: AppConfig = {
        agent: "claude",
        versions: {
          claude: null,
          opencode: null,
          codeServer: "4.107.0",
        },
      };
      fileSystem.$.setEntry(
        pathProvider.configPath.toString(),
        file(JSON.stringify(existingConfig))
      );

      const service = createService();
      await service.setAgent(null);

      const entry = fileSystem.$.entries.get(pathProvider.configPath.toString());
      expect(entry?.type).toBe("file");
      if (entry?.type === "file") {
        const parsed = JSON.parse(entry.content as string);
        expect(parsed.agent).toBeNull();
      }
    });
  });
});
