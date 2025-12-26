/**
 * Unit tests for wirePluginApi.
 *
 * Tests the plugin API handler wiring without real Socket.IO connections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { wirePluginApi, type WorkspaceResolver } from "./wire-plugin-api";
import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { WorkspaceName } from "../../shared/api/types";
import { createSilentLogger } from "../../services/logging";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockPluginServer(): PluginServer & { registeredHandlers: ApiCallHandlers | null } {
  const mock = {
    registeredHandlers: null as ApiCallHandlers | null,
    onApiCall: vi.fn().mockImplementation((handlers: ApiCallHandlers) => {
      mock.registeredHandlers = handlers;
    }),
  };
  return mock as unknown as PluginServer & { registeredHandlers: ApiCallHandlers | null };
}

function createMockApi(): ICodeHydraApi {
  return {
    projects: {
      open: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn(),
      remove: vi.fn().mockResolvedValue({ branchDeleted: false }),
      forceRemove: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      getOpencodePort: vi.fn().mockResolvedValue(null),
      setMetadata: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn(),
      setMode: vi.fn(),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue("ready"),
      setup: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

function createMockWorkspaceResolver(projectPath?: string): WorkspaceResolver {
  return {
    findProjectForWorkspace: vi
      .fn()
      .mockReturnValue(projectPath ? { path: projectPath } : undefined),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("wirePluginApi", () => {
  let pluginServer: PluginServer & { registeredHandlers: ApiCallHandlers | null };
  let api: ICodeHydraApi;
  let workspaceResolver: WorkspaceResolver;
  const logger = createSilentLogger();

  beforeEach(() => {
    pluginServer = createMockPluginServer();
    api = createMockApi();
    workspaceResolver = createMockWorkspaceResolver("/home/user/projects/my-app");
  });

  it("should register handlers with plugin server", () => {
    wirePluginApi(pluginServer, api, workspaceResolver, logger);

    expect(pluginServer.onApiCall).toHaveBeenCalledTimes(1);
    expect(pluginServer.registeredHandlers).not.toBeNull();
  });

  describe("getOpencodePort handler", () => {
    it("should resolve workspace path to projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.getOpencodePort("/home/user/.codehydra/workspaces/my-feature");

      expect(workspaceResolver.findProjectForWorkspace).toHaveBeenCalledWith(
        "/home/user/.codehydra/workspaces/my-feature"
      );
    });

    it("should return success result with port number", async () => {
      vi.mocked(api.workspaces.getOpencodePort).mockResolvedValue(12345);
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getOpencodePort("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(12345);
      }
    });

    it("should return success result with null when no server", async () => {
      vi.mocked(api.workspaces.getOpencodePort).mockResolvedValue(null);
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getOpencodePort("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("should return error result when workspace not found", async () => {
      workspaceResolver = createMockWorkspaceResolver(undefined); // Not found
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getOpencodePort("/unknown/workspace");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.getOpencodePort).mockRejectedValue(new Error("Port lookup failed"));
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getOpencodePort("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Port lookup failed");
      }
    });

    it("should call API with correct projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.getOpencodePort("/home/user/.codehydra/workspaces/my-feature");

      expect(api.workspaces.getOpencodePort).toHaveBeenCalledWith(
        expect.any(String), // projectId (generated from path)
        "my-feature" as WorkspaceName
      );
    });
  });

  describe("delete handler", () => {
    it("should resolve workspace path to projectId and workspaceName", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.delete("/home/user/.codehydra/workspaces/my-feature", {});

      expect(workspaceResolver.findProjectForWorkspace).toHaveBeenCalledWith(
        "/home/user/.codehydra/workspaces/my-feature"
      );
    });

    it("should return success result with started confirmation", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete("/home/user/.codehydra/workspaces/my-feature", {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: true });
      }
    });

    it("should pass keepBranch option to API", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.delete("/home/user/.codehydra/workspaces/my-feature", { keepBranch: true });

      expect(api.workspaces.remove).toHaveBeenCalledWith(
        expect.any(String), // projectId
        "my-feature" as WorkspaceName,
        true // keepBranch
      );
    });

    it("should return error result when workspace not found", async () => {
      workspaceResolver = createMockWorkspaceResolver(undefined); // Not found
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete("/unknown/workspace", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
      // API should not be called when workspace not found
      expect(api.workspaces.remove).not.toHaveBeenCalled();
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.remove).mockRejectedValue(new Error("Deletion failed"));
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete("/home/user/.codehydra/workspaces/my-feature", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Deletion failed");
      }
    });
  });
});
