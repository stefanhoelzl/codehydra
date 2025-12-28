/**
 * Unit tests for MCP Server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer, createDefaultMcpServer, type McpServerFactory } from "./mcp-server";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import type { WorkspaceLookup } from "./workspace-resolver";
import type { ProjectId } from "../../shared/api/types";
import { createMockLogger } from "../logging";

/**
 * Create a mock ICoreApi for testing.
 */
function createMockCoreApi(overrides?: {
  workspaces?: Partial<IWorkspaceApi>;
  projects?: Partial<IProjectApi>;
}): ICoreApi {
  const defaultWorkspaces: IWorkspaceApi = {
    create: vi.fn().mockResolvedValue({
      name: "test",
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    }),
    remove: vi.fn().mockResolvedValue({ started: true }),
    forceRemove: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    getOpencodePort: vi.fn().mockResolvedValue(14001),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };

  const defaultProjects: IProjectApi = {
    open: vi.fn().mockResolvedValue({
      id: "test-12345678" as ProjectId,
      name: "test",
      path: "/path",
      workspaces: [],
    }),
    close: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
  };

  return {
    workspaces: { ...defaultWorkspaces, ...overrides?.workspaces },
    projects: { ...defaultProjects, ...overrides?.projects },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock WorkspaceLookup for testing.
 */
function createMockAppState(
  workspaces: { projectPath: string; workspacePath: string }[] = []
): WorkspaceLookup {
  return {
    findProjectForWorkspace(workspacePath: string) {
      const match = workspaces.find((w) => w.workspacePath === workspacePath);
      if (match) {
        return {
          path: match.projectPath,
          workspaces: [{ path: match.workspacePath }],
        };
      }
      return undefined;
    },
  };
}

/**
 * Create a mock MCP SDK server for testing.
 */
function createMockMcpSdk() {
  const registeredTools: Array<{ name: string; handler: (...args: unknown[]) => unknown }> = [];

  return {
    server: {},
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    registerTool: vi
      .fn()
      .mockImplementation(
        (name: string, _config: unknown, handler: (...args: unknown[]) => unknown) => {
          registeredTools.push({ name, handler });
          return { name };
        }
      ),
    getRegisteredTools: () => registeredTools,
  };
}

describe("McpServer", () => {
  let mockApi: ICoreApi;
  let mockAppState: WorkspaceLookup;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockMcpSdk: ReturnType<typeof createMockMcpSdk>;
  let mockFactory: McpServerFactory;

  beforeEach(() => {
    mockApi = createMockCoreApi();
    mockAppState = createMockAppState();
    mockLogger = createMockLogger();
    mockMcpSdk = createMockMcpSdk();
    mockFactory = () => mockMcpSdk as unknown as ReturnType<typeof createDefaultMcpServer>;
  });

  describe("constructor", () => {
    it("creates server with injected dependencies", () => {
      const server = new McpServer(mockApi, mockAppState, mockFactory, mockLogger);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server without logger", () => {
      const server = new McpServer(mockApi, mockAppState, mockFactory);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server with default factory", () => {
      const server = new McpServer(mockApi, mockAppState);
      expect(server).toBeInstanceOf(McpServer);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const server = new McpServer(mockApi, mockAppState, mockFactory, mockLogger);
      expect(server.isRunning()).toBe(false);
    });
  });

  describe("tool registration", () => {
    it("registers all required tools when started", async () => {
      const server = new McpServer(mockApi, mockAppState, mockFactory, mockLogger);

      // Start and immediately stop to trigger registration
      await server.start(0); // Port 0 = let OS assign
      await server.stop();

      // Check that all tools were registered
      const tools = mockMcpSdk.getRegisteredTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("workspace_get_status");
      expect(toolNames).toContain("workspace_get_metadata");
      expect(toolNames).toContain("workspace_set_metadata");
      expect(toolNames).toContain("workspace_get_opencode_port");
      expect(toolNames).toContain("workspace_delete");
      expect(toolNames).toContain("workspace_execute_command");
      expect(toolNames).toContain("log");
      expect(tools.length).toBe(7);
    });
  });

  describe("dispose", () => {
    it("stops the server", async () => {
      const server = new McpServer(mockApi, mockAppState, mockFactory, mockLogger);

      await server.start(0);
      expect(server.isRunning()).toBe(true);

      await server.dispose();
      expect(server.isRunning()).toBe(false);
    });
  });
});

describe("createDefaultMcpServer", () => {
  it("creates an MCP SDK server instance", () => {
    const sdk = createDefaultMcpServer();
    expect(sdk).toBeDefined();
    expect(typeof sdk.registerTool).toBe("function");
    expect(typeof sdk.connect).toBe("function");
    expect(typeof sdk.close).toBe("function");
  });
});
