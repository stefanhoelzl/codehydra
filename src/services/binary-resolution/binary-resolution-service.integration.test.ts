/**
 * Integration tests for BinaryResolutionService.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BinaryResolutionService } from "./binary-resolution-service";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import {
  createFileSystemMock,
  file,
  directory,
  type MockFileSystemLayer,
} from "../platform/filesystem.state-mock";
import { createMockProcessRunner, type MockProcessRunner } from "../platform/process.state-mock";
import { createMockLogger } from "../logging/logging.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { Logger } from "../logging";

describe("BinaryResolutionService", () => {
  let fileSystem: MockFileSystemLayer;
  let processRunner: MockProcessRunner;
  let pathProvider: PathProvider;
  let logger: Logger;

  beforeEach(() => {
    pathProvider = createMockPathProvider();
    fileSystem = createFileSystemMock({
      entries: {
        [pathProvider.dataRootDir.toString()]: directory(),
      },
    });
    processRunner = createMockProcessRunner();
    logger = createMockLogger();
  });

  function createService(
    platform: "darwin" | "linux" | "win32" = "linux"
  ): BinaryResolutionService {
    return new BinaryResolutionService({
      fileSystem,
      processRunner,
      pathProvider,
      logger,
      platform,
    });
  }

  describe("findSystemBinary", () => {
    it("returns null for code-server (never system-installed)", async () => {
      const service = createService();

      const result = await service.findSystemBinary("code-server");

      expect(result).toBeNull();
    });

    it("finds system binary on Unix using which", async () => {
      const expectedPath = "/usr/local/bin/claude";
      processRunner = createMockProcessRunner({
        onSpawn: (command) => {
          if (command === "which") {
            return { exitCode: 0, stdout: expectedPath + "\n" };
          }
          return { exitCode: 1 };
        },
      });
      // Mock the file exists check
      fileSystem.$.setEntry(expectedPath, file("binary content"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.findSystemBinary("claude");

      expect(result).not.toBeNull();
      expect(result?.toString()).toBe(expectedPath);
      expect(processRunner).toHaveSpawned([{ command: "which", args: ["claude"] }]);
    });

    it("finds system binary on Windows using where", async () => {
      // Note: We use Unix-style paths for the mock filesystem since it runs on Linux.
      // The test validates that 'where' command is used on Windows platform.
      const expectedPath = "/c/Program Files/claude/claude.exe";
      processRunner = createMockProcessRunner({
        onSpawn: (command) => {
          if (command === "where") {
            return { exitCode: 0, stdout: expectedPath + "\n" };
          }
          return { exitCode: 1 };
        },
      });
      // Mock the file exists check
      fileSystem.$.setEntry(expectedPath, file("binary content"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "win32",
      });

      const result = await service.findSystemBinary("claude");

      expect(result).not.toBeNull();
      expect(result?.toString()).toContain("claude.exe");
      expect(processRunner).toHaveSpawned([{ command: "where", args: ["claude"] }]);
    });

    it("returns null when which/where returns exit code 1", async () => {
      processRunner = createMockProcessRunner({
        onSpawn: () => {
          return { exitCode: 1, stdout: "", stderr: "not found" };
        },
      });

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.findSystemBinary("claude");

      expect(result).toBeNull();
    });

    it("returns null when binary file does not exist", async () => {
      // which succeeds but file doesn't exist
      processRunner = createMockProcessRunner({
        onSpawn: () => {
          return { exitCode: 0, stdout: "/some/path/claude\n" };
        },
      });
      // Don't add the file to filesystem

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.findSystemBinary("claude");

      expect(result).toBeNull();
    });
  });

  describe("findLatestDownloaded", () => {
    it("returns null when base directory does not exist", async () => {
      const service = createService();

      const result = await service.findLatestDownloaded("claude");

      expect(result).toBeNull();
    });

    it("returns null when no version directories exist", async () => {
      // Create base directory but no versions
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      fileSystem.$.setEntry(`${bundlesRoot.toString()}/claude`, directory());

      const service = createService();
      const result = await service.findLatestDownloaded("claude");

      expect(result).toBeNull();
    });

    it("returns highest version when multiple exist", async () => {
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      const baseDir = `${bundlesRoot.toString()}/claude`;

      // Create multiple versions
      fileSystem.$.setEntry(`${baseDir}/1.0.57`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.57/claude`, file("binary"));
      fileSystem.$.setEntry(`${baseDir}/1.0.58`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.58/claude`, file("binary"));
      fileSystem.$.setEntry(`${baseDir}/1.0.59`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.59/claude`, file("binary"));

      const service = createService();
      const result = await service.findLatestDownloaded("claude");

      expect(result).not.toBeNull();
      expect(result?.version).toBe("1.0.59");
    });

    it("compares versions numerically", async () => {
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      const baseDir = `${bundlesRoot.toString()}/opencode`;

      // 1.0.100 should be higher than 1.0.9
      fileSystem.$.setEntry(`${baseDir}/1.0.9`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.9/opencode`, file("binary"));
      fileSystem.$.setEntry(`${baseDir}/1.0.100`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.100/opencode`, file("binary"));

      const service = createService();
      const result = await service.findLatestDownloaded("opencode");

      expect(result?.version).toBe("1.0.100");
    });
  });

  describe("resolve", () => {
    it("returns system binary when available and version not pinned", async () => {
      const systemPath = "/usr/local/bin/opencode";
      processRunner = createMockProcessRunner({
        onSpawn: (command) => {
          if (command === "which") {
            return { exitCode: 0, stdout: systemPath };
          }
          return { exitCode: 1 };
        },
      });
      fileSystem.$.setEntry(systemPath, file("binary"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.resolve("opencode");

      expect(result.available).toBe(true);
      expect(result.source).toBe("system");
      expect(result.path?.toString()).toBe(systemPath);
    });

    it("falls back to downloaded when system not available", async () => {
      // System binary not found
      processRunner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 1 }),
      });

      // But downloaded version exists
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      const baseDir = `${bundlesRoot.toString()}/claude`;
      fileSystem.$.setEntry(`${baseDir}/1.0.58`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.58/claude`, file("binary"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.resolve("claude");

      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      expect(result.version).toBe("1.0.58");
    });

    it("skips system check for pinned version", async () => {
      // Set up system binary that would be found
      processRunner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 0, stdout: "/usr/local/bin/claude" }),
      });
      fileSystem.$.setEntry("/usr/local/bin/claude", file("binary"));

      // Set up downloaded version
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      const baseDir = `${bundlesRoot.toString()}/claude`;
      fileSystem.$.setEntry(`${baseDir}/1.0.58`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.58/claude`, file("binary"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.resolve("claude", { pinnedVersion: "1.0.58" });

      // Should use downloaded, not system
      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      expect(result.version).toBe("1.0.58");
      // Should not have called which
      expect(processRunner).toHaveSpawned([]);
    });

    it("returns not-found when pinned version not available", async () => {
      const service = createService();

      const result = await service.resolve("claude", { pinnedVersion: "1.0.99" });

      expect(result.available).toBe(false);
      expect(result.source).toBe("not-found");
    });

    it("returns not-found when neither system nor downloaded available", async () => {
      processRunner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 1 }),
      });

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        logger,
        platform: "linux",
      });

      const result = await service.resolve("claude");

      expect(result.available).toBe(false);
      expect(result.source).toBe("not-found");
    });

    it("always checks downloaded for code-server (never system)", async () => {
      // Set up downloaded code-server
      const bundlesRoot = pathProvider.getBinaryBaseDir("code-server").dirname;
      const baseDir = `${bundlesRoot.toString()}/code-server`;
      fileSystem.$.setEntry(`${baseDir}/4.107.0`, directory());
      fileSystem.$.setEntry(`${baseDir}/4.107.0/bin/code-server`, file("binary"));

      const service = createService();
      const result = await service.resolve("code-server");

      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      // Should not have called which for code-server
      expect(processRunner).toHaveSpawned([]);
    });
  });
});
