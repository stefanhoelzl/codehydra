/**
 * Integration tests for PluginServer with config and wirePluginApi.
 *
 * Tests the full flow:
 * - PluginServer start → onConfigData registration → connection → config event with startup commands
 * - wirePluginApi: Client → PluginServer → API handlers → ICodeHydraApi → result
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PluginServer } from "./plugin-server";
import { DefaultNetworkLayer } from "../platform/network";
import { SILENT_LOGGER } from "../logging/logging.test-utils";
import { delay } from "@shared/test-fixtures";
import {
  createTestClient,
  waitForConnect,
  type TestClientSocket,
} from "./plugin-server.test-utils";
import { wirePluginApi, type WorkspaceResolver } from "../../main/api/wire-plugin-api";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { WorkspaceStatus } from "../../shared/api/types";
import type { PluginConfig } from "../../shared/plugin-protocol";

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

  describe("config event on connection", () => {
    it("sends config with startup commands when client connects", async () => {
      let receivedConfig: PluginConfig | null = null;
      const client = createClient("/test/workspace");

      // Set up config handler to track received config
      client.on("config", (config) => {
        receivedConfig = config;
      });

      // Register onConfigData callback
      server.onConfigData(() => ({
        env: null,
        agentCommand: "myagent.command",
      }));

      // Connect and wait
      await waitForConnect(client);
      await delay(100);

      // Config should be received
      expect(receivedConfig).not.toBeNull();
      const config = receivedConfig!;
      expect(config.isDevelopment).toBe(false);
      expect(config.startupCommands).toBeDefined();
      expect(config.startupCommands.length).toBeGreaterThan(0);
      // Check that agent command is included
      expect(config.startupCommands).toContain("myagent.command");
    });

    it("sends config with environment variables", async () => {
      let receivedConfig: PluginConfig | null = null;
      const client = createClient("/test/workspace");

      // Set up config handler
      client.on("config", (config) => {
        receivedConfig = config;
      });

      // Register onConfigData callback with env vars
      server.onConfigData(() => ({
        env: { TEST_VAR: "test-value", ANOTHER_VAR: "another" },
        agentCommand: undefined,
      }));

      await waitForConnect(client);
      await delay(100);

      expect(receivedConfig).not.toBeNull();
      expect(receivedConfig!.env).toEqual({ TEST_VAR: "test-value", ANOTHER_VAR: "another" });
    });

    it("sends config with null env when not available", async () => {
      let receivedConfig: PluginConfig | null = null;
      const client = createClient("/test/workspace");

      client.on("config", (config) => {
        receivedConfig = config;
      });

      server.onConfigData(() => ({
        env: null,
        agentCommand: undefined,
      }));

      await waitForConnect(client);
      await delay(100);

      expect(receivedConfig).not.toBeNull();
      expect(receivedConfig!.env).toBeNull();
    });

    it("handles concurrent workspace connections independently", async () => {
      let config1: PluginConfig | null = null;
      let config2: PluginConfig | null = null;

      const client1 = createClient("/workspace/one");
      const client2 = createClient("/workspace/two");

      client1.on("config", (config) => {
        config1 = config;
      });

      client2.on("config", (config) => {
        config2 = config;
      });

      // Register onConfigData that returns different env for different workspaces
      server.onConfigData((workspacePath) => ({
        env: { WORKSPACE: workspacePath },
        agentCommand: undefined,
      }));

      // Connect both clients
      await Promise.all([waitForConnect(client1), waitForConnect(client2)]);
      await delay(100);

      // Each workspace should receive its own config
      expect(config1).not.toBeNull();
      expect(config2).not.toBeNull();
      expect(config1!.env).toEqual({ WORKSPACE: "/workspace/one" });
      expect(config2!.env).toEqual({ WORKSPACE: "/workspace/two" });
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
        getAgentSession: vi.fn(),
        restartAgentServer: vi.fn(),
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
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    clients = [];

    if (server) {
      await server.close();
    }
  });

  function createClient(workspacePath: string): TestClientSocket {
    const client = createTestClient(port, { workspacePath });
    clients.push(client);
    return client;
  }

  describe("getStatus round-trip", () => {
    it("returns status from ICodeHydraApi", async () => {
      const expectedStatus: WorkspaceStatus = {
        isDirty: true,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };
      vi.mocked(mockApi.workspaces.getStatus).mockResolvedValue(expectedStatus);

      const client = createClient("/projects/myproject/workspaces/test");
      await waitForConnect(client);

      const result = await new Promise<WorkspaceStatus>((resolve, reject) => {
        client.emit("api:workspace:getStatus", (res) => {
          if (res.success) {
            resolve(res.data);
          } else {
            reject(new Error(res.error));
          }
        });
      });

      expect(result).toEqual(expectedStatus);
      expect(mockApi.workspaces.getStatus).toHaveBeenCalled();
    });

    it("returns error when workspace not found", async () => {
      const client = createClient("/unknown/workspace");
      await waitForConnect(client);

      await expect(
        new Promise((resolve, reject) => {
          client.emit("api:workspace:getStatus", (res) => {
            if (res.success) {
              resolve(res.data);
            } else {
              reject(new Error(res.error));
            }
          });
        })
      ).rejects.toThrow();
    });
  });

  describe("getAgentSession round-trip", () => {
    it("returns session from ICodeHydraApi", async () => {
      const expectedSession = { port: 14001, sessionId: "abc123" };
      vi.mocked(mockApi.workspaces.getAgentSession).mockResolvedValue(expectedSession);

      const client = createClient("/projects/myproject/workspaces/test");
      await waitForConnect(client);

      const result = await new Promise((resolve, reject) => {
        client.emit("api:workspace:getAgentSession", (res) => {
          if (res.success) {
            resolve(res.data);
          } else {
            reject(new Error(res.error));
          }
        });
      });

      expect(result).toEqual(expectedSession);
    });
  });

  describe("restartAgentServer round-trip", () => {
    it("returns port from ICodeHydraApi", async () => {
      vi.mocked(mockApi.workspaces.restartAgentServer).mockResolvedValue(14001);

      const client = createClient("/projects/myproject/workspaces/test");
      await waitForConnect(client);

      const result = await new Promise<number>((resolve, reject) => {
        client.emit("api:workspace:restartAgentServer", (res) => {
          if (res.success) {
            resolve(res.data);
          } else {
            reject(new Error(res.error));
          }
        });
      });

      expect(result).toBe(14001);
    });
  });

  describe("getMetadata round-trip", () => {
    it("returns metadata from ICodeHydraApi", async () => {
      const expectedMetadata = { base: "main", note: "test" };
      vi.mocked(mockApi.workspaces.getMetadata).mockResolvedValue(expectedMetadata);

      const client = createClient("/projects/myproject/workspaces/test");
      await waitForConnect(client);

      const result = await new Promise<Record<string, string>>((resolve, reject) => {
        client.emit("api:workspace:getMetadata", (res) => {
          if (res.success) {
            resolve(res.data);
          } else {
            reject(new Error(res.error));
          }
        });
      });

      expect(result).toEqual(expectedMetadata);
    });
  });

  describe("setMetadata round-trip", () => {
    it("calls ICodeHydraApi.setMetadata", async () => {
      vi.mocked(mockApi.workspaces.setMetadata).mockResolvedValue(undefined);

      const client = createClient("/projects/myproject/workspaces/test");
      await waitForConnect(client);

      await new Promise<void>((resolve, reject) => {
        client.emit("api:workspace:setMetadata", { key: "note", value: "test" }, (res) => {
          if (res.success) {
            resolve();
          } else {
            reject(new Error(res.error));
          }
        });
      });

      expect(mockApi.workspaces.setMetadata).toHaveBeenCalled();
    });
  });
});
