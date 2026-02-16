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
import { SILENT_LOGGER } from "../../services/logging";

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
      clone: vi.fn(),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn(),
      remove: vi.fn().mockResolvedValue({ started: true }),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      getAgentSession: vi.fn().mockResolvedValue(null),
      restartAgentServer: vi.fn().mockResolvedValue(14001),
      setMetadata: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn(),
      setMode: vi.fn(),
    },
    lifecycle: {
      ready: vi.fn(),
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
  const logger = SILENT_LOGGER;

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

  describe("getAgentSession handler", () => {
    it("should resolve workspace path to projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.getAgentSession("/home/user/.codehydra/workspaces/my-feature");

      expect(workspaceResolver.findProjectForWorkspace).toHaveBeenCalledWith(
        "/home/user/.codehydra/workspaces/my-feature"
      );
    });

    it("should return success result with session info", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockResolvedValue({
        port: 12345,
        sessionId: "ses-123",
      });
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ port: 12345, sessionId: "ses-123" });
      }
    });

    it("should return success result with null when no session", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockResolvedValue(null);
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("should return error result when workspace not found", async () => {
      workspaceResolver = createMockWorkspaceResolver(undefined); // Not found
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession("/unknown/workspace");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockRejectedValue(
        new Error("Session lookup failed")
      );
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession("/home/user/.codehydra/workspaces/my-feature");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Session lookup failed");
      }
    });

    it("should call API with correct projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.getAgentSession("/home/user/.codehydra/workspaces/my-feature");

      expect(api.workspaces.getAgentSession).toHaveBeenCalledWith(
        expect.any(String), // projectId (generated from path)
        "my-feature" as WorkspaceName
      );
    });
  });

  describe("restartAgentServer handler", () => {
    it("should return success result with port number", async () => {
      vi.mocked(api.workspaces.restartAgentServer).mockResolvedValue(14001);
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.restartAgentServer(
        "/home/user/.codehydra/workspaces/my-feature"
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(14001);
      }
    });

    it("should return error result when workspace not found", async () => {
      workspaceResolver = createMockWorkspaceResolver(undefined); // Not found
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.restartAgentServer("/unknown/workspace");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.restartAgentServer).mockRejectedValue(
        new Error("Server not running")
      );
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.restartAgentServer(
        "/home/user/.codehydra/workspaces/my-feature"
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Server not running");
      }
    });

    it("should call API with correct projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.restartAgentServer("/home/user/.codehydra/workspaces/my-feature");

      expect(api.workspaces.restartAgentServer).toHaveBeenCalledWith(
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
        { keepBranch: true }
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

  describe("executeCommand handler", () => {
    it("should resolve workspace path to projectId and workspaceName", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.executeCommand("/home/user/.codehydra/workspaces/my-feature", {
        command: "workbench.action.files.save",
      });

      expect(workspaceResolver.findProjectForWorkspace).toHaveBeenCalledWith(
        "/home/user/.codehydra/workspaces/my-feature"
      );
    });

    it("should return success result with command data", async () => {
      vi.mocked(api.workspaces.executeCommand).mockResolvedValue("command result");
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand("/home/user/.codehydra/workspaces/my-feature", {
        command: "test.command",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("command result");
      }
    });

    it("should return success result with undefined when command returns nothing", async () => {
      vi.mocked(api.workspaces.executeCommand).mockResolvedValue(undefined);
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand("/home/user/.codehydra/workspaces/my-feature", {
        command: "workbench.action.files.saveAll",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeUndefined();
      }
    });

    it("should pass command and args to API", async () => {
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      await handlers.executeCommand("/home/user/.codehydra/workspaces/my-feature", {
        command: "vscode.open",
        args: ["/path/to/file", { preview: true }],
      });

      expect(api.workspaces.executeCommand).toHaveBeenCalledWith(
        expect.any(String), // projectId
        "my-feature" as WorkspaceName,
        "vscode.open",
        ["/path/to/file", { preview: true }]
      );
    });

    it("should return error result when workspace not found", async () => {
      workspaceResolver = createMockWorkspaceResolver(undefined); // Not found
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand("/unknown/workspace", {
        command: "test.command",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
      // API should not be called when workspace not found
      expect(api.workspaces.executeCommand).not.toHaveBeenCalled();
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.executeCommand).mockRejectedValue(
        new Error("Command not found: invalid.command")
      );
      wirePluginApi(pluginServer, api, workspaceResolver, logger);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand("/home/user/.codehydra/workspaces/my-feature", {
        command: "invalid.command",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Command not found: invalid.command");
      }
    });
  });
});
