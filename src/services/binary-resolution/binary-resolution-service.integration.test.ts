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
import type { BinaryType } from "./types";

const TEST_EXECUTABLE_PATHS: Record<BinaryType, string> = {
  "code-server": "bin/code-server",
  opencode: "opencode",
  claude: "claude",
};

describe("BinaryResolutionService", () => {
  let fileSystem: MockFileSystemLayer;
  let processRunner: MockProcessRunner;
  let pathProvider: PathProvider;
  let logger: Logger;

  beforeEach(() => {
    pathProvider = createMockPathProvider();
    fileSystem = createFileSystemMock();
    processRunner = createMockProcessRunner();
    logger = createMockLogger();
  });

  function createService(): BinaryResolutionService {
    return new BinaryResolutionService({
      fileSystem,
      processRunner,
      pathProvider,
      executablePaths: TEST_EXECUTABLE_PATHS,
      logger,
    });
  }

  describe("findSystemBinary", () => {
    it("returns false for code-server (never system-installed)", async () => {
      const service = createService();

      const result = await service.findSystemBinary("code-server");

      expect(result).toBe(false);
    });

    it("finds system binary using --version", async () => {
      processRunner = createMockProcessRunner({
        onSpawn: (command, args) => {
          if (command === "claude" && args?.[0] === "--version") {
            return { exitCode: 0, stdout: "claude 1.0.58\n" };
          }
          return { exitCode: 1 };
        },
      });

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.findSystemBinary("claude");

      expect(result).toBe(true);
      expect(processRunner).toHaveSpawned([{ command: "claude", args: ["--version"] }]);
    });

    it("returns false when --version fails", async () => {
      processRunner = createMockProcessRunner({
        onSpawn: () => {
          return { exitCode: 1, stdout: "", stderr: "command not found" };
        },
      });

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.findSystemBinary("claude");

      expect(result).toBe(false);
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
      fileSystem.$.setEntry(pathProvider.bundlePath("claude").toString(), directory());

      const service = createService();
      const result = await service.findLatestDownloaded("claude");

      expect(result).toBeNull();
    });

    it("returns highest version when multiple exist", async () => {
      const baseDir = pathProvider.bundlePath("claude").toString();

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
      const baseDir = pathProvider.bundlePath("opencode").toString();

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
      processRunner = createMockProcessRunner({
        onSpawn: (command, args) => {
          if (command === "opencode" && args?.[0] === "--version") {
            return { exitCode: 0, stdout: "opencode 0.1.0\n" };
          }
          return { exitCode: 1 };
        },
      });

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.resolve("opencode");

      expect(result.available).toBe(true);
      expect(result.source).toBe("system");
      expect(result.path).toBeUndefined(); // No path for system binaries
    });

    it("falls back to downloaded when system not available", async () => {
      // System binary not found (--version fails)
      processRunner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 1 }),
      });

      // But downloaded version exists
      const baseDir = pathProvider.bundlePath("claude").toString();
      fileSystem.$.setEntry(`${baseDir}/1.0.58`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.58/claude`, file("binary"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.resolve("claude");

      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      expect(result.version).toBe("1.0.58");
    });

    it("skips system check for pinned version", async () => {
      // Set up system binary that would be found via --version
      processRunner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 0, stdout: "claude 1.0.58\n" }),
      });

      // Set up downloaded version
      const baseDir = pathProvider.bundlePath("claude").toString();
      fileSystem.$.setEntry(`${baseDir}/1.0.58`, directory());
      fileSystem.$.setEntry(`${baseDir}/1.0.58/claude`, file("binary"));

      const service = new BinaryResolutionService({
        fileSystem,
        processRunner,
        pathProvider,
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.resolve("claude", { pinnedVersion: "1.0.58" });

      // Should use downloaded, not system
      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      expect(result.version).toBe("1.0.58");
      // Should not have called --version for pinned versions
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
        executablePaths: TEST_EXECUTABLE_PATHS,
        logger,
      });

      const result = await service.resolve("claude");

      expect(result.available).toBe(false);
      expect(result.source).toBe("not-found");
    });

    it("always checks downloaded for code-server (never system)", async () => {
      // Set up downloaded code-server
      const baseDir = pathProvider.bundlePath("code-server").toString();
      fileSystem.$.setEntry(`${baseDir}/4.109.2`, directory());
      fileSystem.$.setEntry(`${baseDir}/4.109.2/bin/code-server`, file("binary"));

      const service = createService();
      const result = await service.resolve("code-server");

      expect(result.available).toBe(true);
      expect(result.source).toBe("downloaded");
      // Should not have called --version for code-server
      expect(processRunner).toHaveSpawned([]);
    });
  });
});
