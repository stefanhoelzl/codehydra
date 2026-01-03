/**
 * Integration tests for PluginServer with startup commands and wirePluginApi.
 *
 * Tests the full flow:
 * - PluginServer start → onConnect registration → connection → sendStartupCommands called
 * - wirePluginApi: Client → PluginServer → API handlers → ICodeHydraApi → result
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PluginServer } from "./plugin-server";
import { STARTUP_COMMANDS, sendStartupCommands } from "./startup-commands";
import { DefaultNetworkLayer } from "../platform/network";
import { SILENT_LOGGER, createBehavioralLogger } from "../logging/logging.test-utils";
import { delay } from "../test-utils";
import {
  createTestClient,
  waitForConnect,
  createMockCommandHandler,
  type TestClientSocket,
} from "./plugin-server.test-utils";
import { wirePluginApi, type WorkspaceResolver } from "../../main/api/wire-plugin-api";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { WorkspaceStatus } from "../../shared/api/types";

// Longer timeout for integration tests
const TEST_TIMEOUT = 15000;

describe("PluginServer (integration)", { timeout: TEST_TIMEOUT }, () => {
  let server: PluginServer;
  let networkLayer: DefaultNetworkLayer;
  let port: number;
  let clients: TestClientSocket[] = [];

  beforeEach(async () => {
    networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    server = new PluginServer(networkLayer, SILENT_LOGGER, { transports: ["polling"] });
    port = await server.start();
  });

  afterEach(async () => {
    // Disconnect all clients
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    clients = [];

    // Close server
    if (server) {
      await server.close();
    }
  });

  // Helper to create and track clients
  function createClient(workspacePath: string): TestClientSocket {
    const client = createTestClient(port, { workspacePath });
    clients.push(client);
    return client;
  }

  describe("startup commands on connection", () => {
    it("sends all 5 startup commands when client connects", async () => {
      const receivedCommands: string[] = [];
      const client = createClient("/test/workspace");

      // Set up command handler to track received commands
      const handler = createMockCommandHandler();
      client.on("command", (request, ack) => {
        receivedCommands.push(request.command);
        handler(request, ack);
      });

      // Register onConnect callback to send startup commands
      server.onConnect((workspacePath) => {
        void sendStartupCommands(server, workspacePath, SILENT_LOGGER, 0);
      });

      // Connect and wait for startup commands
      await waitForConnect(client);

      // Wait for all commands to be processed (give some time for async commands)
      await delay(500);

      // All 5 startup commands should be received
      expect(receivedCommands).toHaveLength(STARTUP_COMMANDS.length);
      expect(receivedCommands).toEqual([...STARTUP_COMMANDS]);
    });

    it("sends commands in correct order", async () => {
      const receivedCommands: string[] = [];
      const client = createClient("/test/workspace");

      // Set up command handler to track order
      client.on("command", (request, ack) => {
        receivedCommands.push(request.command);
        ack({ success: true, data: undefined });
      });

      // Register onConnect callback
      server.onConnect((workspacePath) => {
        void sendStartupCommands(server, workspacePath, SILENT_LOGGER, 0);
      });

      await waitForConnect(client);
      await delay(500);

      // Commands should be in exact order
      expect(receivedCommands[0]).toBe("workbench.action.closeSidebar");
      expect(receivedCommands[1]).toBe("workbench.action.closeAuxiliaryBar");
      expect(receivedCommands[2]).toBe("opencode.openTerminal");
      expect(receivedCommands[3]).toBe("workbench.action.unlockEditorGroup");
      expect(receivedCommands[4]).toBe("workbench.action.closeEditorsInOtherGroups");
    });

    it("sends commands only after connection established", async () => {
      let commandsReceivedBeforeConnect = false;
      let connectEventFired = false;
      const receivedCommands: string[] = [];

      const client = createClient("/test/workspace");

      // Track when connect event fires
      client.on("connect", () => {
        connectEventFired = true;
      });

      // Track commands
      client.on("command", (request, ack) => {
        if (!connectEventFired) {
          commandsReceivedBeforeConnect = true;
        }
        receivedCommands.push(request.command);
        ack({ success: true, data: undefined });
      });

      // Register onConnect callback
      server.onConnect((workspacePath) => {
        void sendStartupCommands(server, workspacePath, SILENT_LOGGER, 0);
      });

      await waitForConnect(client);
      await delay(500);

      // Commands should only come after connect
      expect(commandsReceivedBeforeConnect).toBe(false);
      expect(receivedCommands.length).toBeGreaterThan(0);
    });

    it("handles concurrent workspace connections independently", async () => {
      const workspace1Commands: string[] = [];
      const workspace2Commands: string[] = [];

      const client1 = createClient("/workspace/one");
      const client2 = createClient("/workspace/two");

      // Set up handlers for each workspace
      client1.on("command", (request, ack) => {
        workspace1Commands.push(request.command);
        ack({ success: true, data: undefined });
      });

      client2.on("command", (request, ack) => {
        workspace2Commands.push(request.command);
        ack({ success: true, data: undefined });
      });

      // Register onConnect callback
      server.onConnect((workspacePath) => {
        void sendStartupCommands(server, workspacePath, SILENT_LOGGER, 0);
      });

      // Connect both clients
      await Promise.all([waitForConnect(client1), waitForConnect(client2)]);
      await delay(500);

      // Each workspace should receive its own set of startup commands
      expect(workspace1Commands).toHaveLength(STARTUP_COMMANDS.length);
      expect(workspace2Commands).toHaveLength(STARTUP_COMMANDS.length);

      // Commands should be the same for both workspaces
      expect(workspace1Commands).toEqual([...STARTUP_COMMANDS]);
      expect(workspace2Commands).toEqual([...STARTUP_COMMANDS]);
    });
  });
});

/**
 * Integration tests for wirePluginApi.
 *
 * Tests the full round-trip: Client → PluginServer → wirePluginApi → ICodeHydraApi → result
 */
describe("wirePluginApi (integration)", { timeout: TEST_TIMEOUT }, () => {
  let server: PluginServer;
  let networkLayer: DefaultNetworkLayer;
  let port: number;
  let clients: TestClientSocket[] = [];
  let mockApi: ICodeHydraApi;
  let mockWorkspaceResolver: WorkspaceResolver;

  beforeEach(async () => {
    networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    server = new PluginServer(networkLayer, SILENT_LOGGER, { transports: ["polling"] });
    port = await server.start();

    // Create mock ICodeHydraApi
    mockApi = {
      projects: {} as ICodeHydraApi["projects"],
      workspaces: {
        create: vi.fn(),
        remove: vi.fn(),
        forceRemove: vi.fn(),
        get: vi.fn(),
        getStatus: vi.fn(),
        getOpencodePort: vi.fn(),
        restartOpencodeServer: vi.fn(),
        setMetadata: vi.fn(),
        getMetadata: vi.fn(),
        executeCommand: vi.fn(),
      },
      ui: {} as ICodeHydraApi["ui"],
      lifecycle: {} as ICodeHydraApi["lifecycle"],
      on: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };

    // Create mock workspace resolver that finds workspaces
    mockWorkspaceResolver = {
      findProjectForWorkspace: vi.fn((workspacePath: string) => {
        // Return a project for known workspace paths
        if (workspacePath.startsWith("/projects/myproject/")) {
          return { path: "/projects/myproject" };
        }
        return undefined;
      }),
    };

    // Wire up the plugin API
    wirePluginApi(server, mockApi, mockWorkspaceResolver, SILENT_LOGGER);
  });

  afterEach(async () => {
    // Disconnect all clients
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    clients = [];

    // Close server
    if (server) {
      await server.close();
    }
  });

  // Helper to create and track clients
  function createClient(workspacePath: string): TestClientSocket {
    const client = createTestClient(port, { workspacePath });
    clients.push(client);
    return client;
  }

  describe("getStatus", () => {
    it("returns workspace status through full round-trip", async () => {
      const expectedStatus: WorkspaceStatus = {
        isDirty: true,
        agent: { type: "busy", counts: { idle: 1, busy: 2, total: 3 } },
      };
      vi.mocked(mockApi.workspaces.getStatus).mockResolvedValue(expectedStatus);

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: WorkspaceStatus;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expectedStatus);
      expect(mockApi.workspaces.getStatus).toHaveBeenCalled();
    });
  });

  describe("getMetadata", () => {
    it("returns workspace metadata through full round-trip", async () => {
      const expectedMetadata = { base: "main", note: "working on feature" };
      vi.mocked(mockApi.workspaces.getMetadata).mockResolvedValue(expectedMetadata);

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: Record<string, string>;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getMetadata", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expectedMetadata);
      expect(mockApi.workspaces.getMetadata).toHaveBeenCalled();
    });
  });

  describe("setMetadata", () => {
    it("updates workspace metadata through full round-trip", async () => {
      vi.mocked(mockApi.workspaces.setMetadata).mockResolvedValue(undefined);

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "note", value: "my note" }, (res) =>
          resolve(res)
        );
      });

      expect(result.success).toBe(true);
      expect(mockApi.workspaces.setMetadata).toHaveBeenCalledWith(
        expect.any(String), // projectId
        expect.any(String), // workspaceName
        "note",
        "my note"
      );
    });
  });

  describe("delete", () => {
    it("deletes workspace through full round-trip", async () => {
      vi.mocked(mockApi.workspaces.remove).mockResolvedValue({ started: true });

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { started: boolean };
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:delete", {}, (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ started: true });
      expect(mockApi.workspaces.remove).toHaveBeenCalled();
    });

    it("passes keepBranch option to API", async () => {
      vi.mocked(mockApi.workspaces.remove).mockResolvedValue({ started: true });

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      await new Promise<{ success: boolean }>((resolve) => {
        client.emit("api:workspace:delete", { keepBranch: true }, (res) => resolve(res));
      });

      expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
        expect.any(String), // projectId
        expect.any(String), // workspaceName
        true // keepBranch
      );
    });
  });

  describe("error handling", () => {
    it("returns error when workspace not found", async () => {
      // Connect with unknown workspace path (not under /projects/myproject/)
      const client = createClient("/unknown/workspace/path");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Workspace not found");
      // API should not be called when workspace not found
      expect(mockApi.workspaces.getStatus).not.toHaveBeenCalled();
    });

    it("returns error when API throws exception", async () => {
      vi.mocked(mockApi.workspaces.getStatus).mockRejectedValue(new Error("Database unavailable"));

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database unavailable");
    });

    it("returns error when metadata key is invalid", async () => {
      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      // Empty key should be rejected at validation (before reaching API)
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "", value: "test" }, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      // API should not be called for invalid requests
      expect(mockApi.workspaces.setMetadata).not.toHaveBeenCalled();
    });

    it("returns error when delete fails", async () => {
      vi.mocked(mockApi.workspaces.remove).mockRejectedValue(new Error("Deletion failed"));

      const client = createClient("/projects/myproject/workspaces/feature-x");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:delete", {}, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Deletion failed");
    });
  });
});

/**
 * Integration tests for log event handling.
 *
 * Tests the full flow: Client → PluginServer → extensionLogger → message storage
 */
describe("PluginServer log events (integration)", { timeout: TEST_TIMEOUT }, () => {
  let server: PluginServer;
  let networkLayer: DefaultNetworkLayer;
  let port: number;
  let clients: TestClientSocket[] = [];
  let extensionLogger: ReturnType<typeof createBehavioralLogger>;

  beforeEach(async () => {
    networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    extensionLogger = createBehavioralLogger();
    server = new PluginServer(networkLayer, SILENT_LOGGER, {
      transports: ["polling"],
      extensionLogger,
    });
    port = await server.start();
  });

  afterEach(async () => {
    // Disconnect all clients
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    clients = [];

    // Close server
    if (server) {
      await server.close();
    }
  });

  // Helper to create and track clients
  function createClient(workspacePath: string): TestClientSocket {
    const client = createTestClient(port, { workspacePath });
    clients.push(client);
    return client;
  }

  describe("valid log events", () => {
    it("logs info level message", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.emit("api:log", { level: "info", message: "Test message" });

      // Wait for async processing
      await delay(100);

      const messages = extensionLogger.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        level: "info",
        message: "Test message",
      });
    });

    it("logs all levels correctly", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const levels = ["silly", "debug", "info", "warn", "error"] as const;
      for (const level of levels) {
        client.emit("api:log", { level, message: `${level} message` });
      }

      // Wait for async processing
      await delay(200);

      for (const level of levels) {
        const messages = extensionLogger.getMessagesByLevel(level);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          level,
          message: `${level} message`,
        });
      }
    });

    it("auto-appends workspace context", async () => {
      const workspacePath = "/projects/myproject/workspace";
      const client = createClient(workspacePath);
      await waitForConnect(client);

      client.emit("api:log", { level: "info", message: "Test" });

      // Wait for async processing
      await delay(100);

      const messages = extensionLogger.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.context?.workspace).toBe(workspacePath);
    });

    it("preserves existing context and adds workspace", async () => {
      const workspacePath = "/test/workspace";
      const client = createClient(workspacePath);
      await waitForConnect(client);

      client.emit("api:log", {
        level: "debug",
        message: "Test",
        context: { key: "value", count: 42 },
      });

      // Wait for async processing
      await delay(100);

      const messages = extensionLogger.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.context).toEqual({
        key: "value",
        count: 42,
        workspace: workspacePath,
      });
    });
  });

  describe("invalid log events", () => {
    it("silently ignores invalid level", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Testing invalid input: "invalid" is not a valid log level
      client.emit("api:log", {
        level: "invalid" as "info",
        message: "Test",
      });

      // Wait for async processing
      await delay(100);

      expect(extensionLogger.getMessages()).toHaveLength(0);
    });

    it("silently ignores empty message", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.emit("api:log", { level: "info", message: "" });

      // Wait for async processing
      await delay(100);

      expect(extensionLogger.getMessages()).toHaveLength(0);
    });

    it("silently ignores invalid context", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Testing invalid input: context with nested object should be rejected
      client.emit("api:log", {
        level: "info",
        message: "Test",
        context: { nested: { deep: 1 } } as unknown as Record<string, string | number | boolean>,
      });

      // Wait for async processing
      await delay(100);

      expect(extensionLogger.getMessages()).toHaveLength(0);
    });
  });
});
