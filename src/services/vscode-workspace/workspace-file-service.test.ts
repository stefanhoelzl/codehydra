// @vitest-environment node

/**
 * Integration tests for WorkspaceFileService.
 *
 * Tests the creation and management of .code-workspace files used for
 * per-workspace VS Code settings.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceFileService } from "./workspace-file-service";
import { createWorkspaceFileConfig } from "./default-settings";
import type { WorkspaceFileConfig, CodeWorkspaceFile } from "./types";
import {
  createFileSystemMock,
  directory,
  file,
  createMockLoggingService,
  type MockLoggingService,
  Path,
} from "../index";

describe("WorkspaceFileService", () => {
  let mockLoggingService: MockLoggingService;
  let config: WorkspaceFileConfig;

  beforeEach(() => {
    mockLoggingService = createMockLoggingService();
    config = createWorkspaceFileConfig();
  });

  describe("getWorkspaceFilePath", () => {
    it("returns path with .code-workspace extension", () => {
      const mockFileSystem = createFileSystemMock();
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const result = service.getWorkspaceFilePath("my-feature", new Path("/project/workspaces"));

      expect(result.toString()).toBe("/project/workspaces/my-feature.code-workspace");
    });

    it("handles workspace names with special characters", () => {
      const mockFileSystem = createFileSystemMock();
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const result = service.getWorkspaceFilePath("feature-123", new Path("/project/workspaces"));

      expect(result.toString()).toBe("/project/workspaces/feature-123.code-workspace");
    });
  });

  describe("createWorkspaceFile", () => {
    it("creates workspace file with correct JSON structure", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");

      await service.createWorkspaceFile(workspacePath, projectWorkspacesDir);

      // Verify file was created
      const content = await mockFileSystem.readFile(
        new Path("/project/workspaces/my-feature.code-workspace")
      );
      const parsed = JSON.parse(content) as CodeWorkspaceFile;

      expect(parsed.folders).toHaveLength(1);
      expect(parsed.folders[0]?.path).toBe("/project/workspaces/my-feature");
    });

    it("includes agent settings when provided", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");
      const agentSettings = {
        "claudeCode.claudeProcessWrapper": "/path/to/claude",
        "claudeCode.environmentVariables": { API_KEY: "test" },
      };

      await service.createWorkspaceFile(workspacePath, projectWorkspacesDir, agentSettings);

      const content = await mockFileSystem.readFile(
        new Path("/project/workspaces/my-feature.code-workspace")
      );
      const parsed = JSON.parse(content) as CodeWorkspaceFile;

      expect(parsed.settings).toEqual(
        expect.objectContaining({
          "claudeCode.claudeProcessWrapper": "/path/to/claude",
          "claudeCode.environmentVariables": { API_KEY: "test" },
        })
      );
    });

    it("returns path to created workspace file", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");

      const result = await service.createWorkspaceFile(workspacePath, projectWorkspacesDir);

      expect(result.toString()).toBe("/project/workspaces/my-feature.code-workspace");
    });
  });

  describe("ensureWorkspaceFile", () => {
    it("always regenerates file to ensure fresh settings", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
          "/project/workspaces/my-feature.code-workspace": file(
            JSON.stringify({ folders: [{ path: "./my-feature" }] })
          ),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");

      const result = await service.ensureWorkspaceFile(workspacePath, projectWorkspacesDir);

      expect(result.toString()).toBe("/project/workspaces/my-feature.code-workspace");
      // File is always regenerated to ensure settings are fresh (e.g., bridge port)
      const content = await mockFileSystem.readFile(
        new Path("/project/workspaces/my-feature.code-workspace")
      );
      const parsed = JSON.parse(content) as CodeWorkspaceFile;
      expect(parsed.settings).toEqual({}); // Default empty settings from config
    });

    it("creates file if it does not exist", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");

      const result = await service.ensureWorkspaceFile(workspacePath, projectWorkspacesDir);

      expect(result.toString()).toBe("/project/workspaces/my-feature.code-workspace");
      // Verify file was created
      const content = await mockFileSystem.readFile(
        new Path("/project/workspaces/my-feature.code-workspace")
      );
      const parsed = JSON.parse(content) as CodeWorkspaceFile;
      expect(parsed.folders[0]?.path).toBe("/project/workspaces/my-feature");
    });

    it("passes agent settings to createWorkspaceFile when creating new file", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const workspacePath = new Path("/project/workspaces/my-feature");
      const projectWorkspacesDir = new Path("/project/workspaces");
      const agentSettings = {
        "claudeCode.claudeProcessWrapper": "/path/to/claude",
      };

      await service.ensureWorkspaceFile(workspacePath, projectWorkspacesDir, agentSettings);

      const content = await mockFileSystem.readFile(
        new Path("/project/workspaces/my-feature.code-workspace")
      );
      const parsed = JSON.parse(content) as CodeWorkspaceFile;

      expect(parsed.settings).toEqual(
        expect.objectContaining({
          "claudeCode.claudeProcessWrapper": "/path/to/claude",
        })
      );
    });
  });

  describe("deleteWorkspaceFile", () => {
    it("deletes an existing workspace file", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
          "/project/workspaces/my-feature": directory(),
          "/project/workspaces/my-feature.code-workspace": file(
            JSON.stringify({ folders: [{ path: "/project/workspaces/my-feature" }] })
          ),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const projectWorkspacesDir = new Path("/project/workspaces");

      await service.deleteWorkspaceFile("my-feature", projectWorkspacesDir);

      // Verify file was deleted by trying to read it
      await expect(
        mockFileSystem.readFile(new Path("/project/workspaces/my-feature.code-workspace"))
      ).rejects.toThrow();
    });

    it("does not throw when file does not exist", async () => {
      const mockFileSystem = createFileSystemMock({
        entries: {
          "/project": directory(),
          "/project/workspaces": directory(),
        },
      });
      const service = new WorkspaceFileService(
        mockFileSystem,
        config,
        mockLoggingService.createLogger("workspace-file")
      );

      const projectWorkspacesDir = new Path("/project/workspaces");

      // Should not throw
      await expect(
        service.deleteWorkspaceFile("nonexistent", projectWorkspacesDir)
      ).resolves.toBeUndefined();
    });
  });
});

describe("createWorkspaceFileConfig", () => {
  it("creates config with default settings", () => {
    const config = createWorkspaceFileConfig();

    expect(config.defaultSettings).toEqual({});
  });

  it("merges custom settings with defaults", () => {
    const config = createWorkspaceFileConfig({
      "editor.fontSize": 14,
    });

    expect(config.defaultSettings).toEqual({
      "editor.fontSize": 14,
    });
  });

  it("omits recommendedExtensions when none provided", () => {
    const config = createWorkspaceFileConfig();

    expect(config.recommendedExtensions).toBeUndefined();
  });

  it("includes recommendedExtensions when provided", () => {
    const config = createWorkspaceFileConfig(undefined, ["anthropic.claude-code"]);

    expect(config.recommendedExtensions).toEqual(["anthropic.claude-code"]);
  });
});
