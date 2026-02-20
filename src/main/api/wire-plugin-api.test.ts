/**
 * Unit tests for wirePluginApi.
 *
 * Tests the plugin API handler wiring without real Socket.IO connections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { wirePluginApi } from "./wire-plugin-api";
import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
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

// =============================================================================
// Tests
// =============================================================================

const testWorkspacePath = "/home/user/.codehydra/workspaces/my-feature";

describe("wirePluginApi", () => {
  let pluginServer: PluginServer & { registeredHandlers: ApiCallHandlers | null };
  let api: ICodeHydraApi;
  const logger = SILENT_LOGGER;

  beforeEach(() => {
    pluginServer = createMockPluginServer();
    api = createMockApi();
    wirePluginApi(pluginServer, api, logger);
  });

  it("should register handlers with plugin server", () => {
    expect(pluginServer.onApiCall).toHaveBeenCalledTimes(1);
    expect(pluginServer.registeredHandlers).not.toBeNull();
  });

  describe("getAgentSession handler", () => {
    it("should return success result with session info", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockResolvedValue({
        port: 12345,
        sessionId: "ses-123",
      });
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ port: 12345, sessionId: "ses-123" });
      }
    });

    it("should return success result with null when no session", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockResolvedValue(null);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("should return error result when API throws for unknown workspace", async () => {
      vi.mocked(api.workspaces.getAgentSession).mockRejectedValue(new Error("Workspace not found"));
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
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.getAgentSession(testWorkspacePath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Session lookup failed");
      }
    });

    it("should call API with workspacePath", async () => {
      const handlers = pluginServer.registeredHandlers!;

      await handlers.getAgentSession(testWorkspacePath);

      expect(api.workspaces.getAgentSession).toHaveBeenCalledWith(testWorkspacePath);
    });
  });

  describe("restartAgentServer handler", () => {
    it("should return success result with port number", async () => {
      vi.mocked(api.workspaces.restartAgentServer).mockResolvedValue(14001);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.restartAgentServer(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(14001);
      }
    });

    it("should return error result when API throws for unknown workspace", async () => {
      vi.mocked(api.workspaces.restartAgentServer).mockRejectedValue(
        new Error("Workspace not found")
      );
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
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.restartAgentServer(testWorkspacePath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Server not running");
      }
    });

    it("should call API with workspacePath", async () => {
      const handlers = pluginServer.registeredHandlers!;

      await handlers.restartAgentServer(testWorkspacePath);

      expect(api.workspaces.restartAgentServer).toHaveBeenCalledWith(testWorkspacePath);
    });
  });

  describe("delete handler", () => {
    it("should return success result with started confirmation", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: true });
      }
    });

    it("should pass keepBranch option to API", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      const handlers = pluginServer.registeredHandlers!;

      await handlers.delete(testWorkspacePath, { keepBranch: true });

      expect(api.workspaces.remove).toHaveBeenCalledWith(testWorkspacePath, { keepBranch: true });
    });

    it("should pass workspacePath directly to API without identity lookup", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ started: true });
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete("/unknown/workspace", {});

      // Delete no longer requires resolveIdentity - passes workspacePath directly
      expect(result.success).toBe(true);
      expect(api.workspaces.remove).toHaveBeenCalledWith("/unknown/workspace", {});
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.remove).mockRejectedValue(new Error("Deletion failed"));
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Deletion failed");
      }
    });
  });

  describe("executeCommand handler", () => {
    it("should return success result with command data", async () => {
      vi.mocked(api.workspaces.executeCommand).mockResolvedValue("command result");
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand(testWorkspacePath, {
        command: "test.command",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("command result");
      }
    });

    it("should return success result with undefined when command returns nothing", async () => {
      vi.mocked(api.workspaces.executeCommand).mockResolvedValue(undefined);
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand(testWorkspacePath, {
        command: "workbench.action.files.saveAll",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeUndefined();
      }
    });

    it("should pass command and args to API", async () => {
      const handlers = pluginServer.registeredHandlers!;

      await handlers.executeCommand(testWorkspacePath, {
        command: "vscode.open",
        args: ["/path/to/file", { preview: true }],
      });

      expect(api.workspaces.executeCommand).toHaveBeenCalledWith(testWorkspacePath, "vscode.open", [
        "/path/to/file",
        { preview: true },
      ]);
    });

    it("should return error result when API throws for unknown workspace", async () => {
      vi.mocked(api.workspaces.executeCommand).mockRejectedValue(new Error("Workspace not found"));
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand("/unknown/workspace", {
        command: "test.command",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });

    it("should return error result when API throws", async () => {
      vi.mocked(api.workspaces.executeCommand).mockRejectedValue(
        new Error("Command not found: invalid.command")
      );
      const handlers = pluginServer.registeredHandlers!;

      const result = await handlers.executeCommand(testWorkspacePath, {
        command: "invalid.command",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Command not found: invalid.command");
      }
    });
  });
});
