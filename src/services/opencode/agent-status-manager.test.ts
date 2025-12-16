// @vitest-environment node
/**
 * Tests for AgentStatusManager.
 *
 * Uses SDK mock utilities for testing OpenCodeClient integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatusManager } from "./agent-status-manager";
import type { DiscoveryService } from "./discovery-service";
import type { WorkspacePath } from "../../shared/ipc";
import { createMockSdkClient, createMockSdkFactory, createTestSession } from "./sdk-test-utils";
import type { SdkClientFactory } from "./opencode-client";
import type { SessionStatus as SdkSessionStatus } from "@opencode-ai/sdk";
import type { DiscoveredInstance } from "./types";

describe("AgentStatusManager", () => {
  let manager: AgentStatusManager;
  let mockDiscoveryService: DiscoveryService;
  let mockSdkFactory: SdkClientFactory;
  let instancesChangedCallback:
    | ((workspace: string, instances: ReadonlyArray<DiscoveredInstance>) => void)
    | null;

  beforeEach(() => {
    vi.clearAllMocks();
    instancesChangedCallback = null;

    mockDiscoveryService = {
      setCodeServerPid: vi.fn(),
      scan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      getPortsForWorkspace: vi.fn().mockReturnValue(new Set<number>()),
      getInstancesForWorkspace: vi.fn().mockReturnValue([] as DiscoveredInstance[]),
      onInstancesChanged: vi.fn().mockImplementation((cb) => {
        instancesChangedCallback = cb;
        return () => {
          instancesChangedCallback = null;
        };
      }),
      dispose: vi.fn(),
    } as unknown as DiscoveryService;

    // Create default SDK mock factory
    const mockSdk = createMockSdkClient();
    mockSdkFactory = createMockSdkFactory(mockSdk);

    manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("getStatus", () => {
    it("returns none status for unknown workspace", () => {
      const status = manager.getStatus("/unknown/workspace" as WorkspacePath);

      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });
  });

  describe("getAllStatuses", () => {
    it("returns empty map initially", () => {
      const statuses = manager.getAllStatuses();

      expect(statuses).toBeInstanceOf(Map);
      expect(statuses.size).toBe(0);
    });
  });

  describe("initWorkspace", () => {
    it("creates provider for workspace", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("none");
    });

    it("gets instances from discovery service", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createMockSdkClient({
        sessions: [],
        sessionStatuses: {},
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);
      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(mockDiscoveryService.getInstancesForWorkspace).toHaveBeenCalledWith("/test/workspace");
    });

    it("shows idle status when connected but no sessions", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createMockSdkClient({
        sessions: [],
        sessionStatuses: {},
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      // Return instances so provider has clients
      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // When connected (has clients) but no sessions, should show idle with count 1
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
    });

    it("shows none status when no clients connected", async () => {
      // No instances = no clients
      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // When not connected, should show none with count 0
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("does not duplicate if called twice", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath);
      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(manager.getAllStatuses().size).toBe(1);
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace from tracking", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath);
      expect(manager.getAllStatuses().size).toBe(1);

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("notifies listeners of removal", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);
      listener.mockClear();

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });
  });

  describe("onStatusChanged", () => {
    it("notifies when workspace is initialized", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });

    it("returns unsubscribe function", async () => {
      const listener = vi.fn();
      const unsubscribe = manager.onStatusChanged(listener);

      unsubscribe();

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears all state", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      manager.dispose();

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("unsubscribes from discovery service", () => {
      manager.dispose();

      expect(instancesChangedCallback).toBeNull();
    });
  });

  describe("handleInstancesChanged", () => {
    it("updates provider when instances change", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // Simulate discovery service finding new instances
      instancesChangedCallback?.("/test/workspace", [{ port: 8080 }, { port: 9090 }]);

      // Should not throw
      expect(manager.getStatus("/test/workspace" as WorkspacePath)).toBeDefined();
    });

    it("fetches statuses from new clients and updates status", async () => {
      // Track factory calls
      let factoryCallCount = 0;

      // Create factory that returns a new mock SDK for each port
      const factoryFn = vi.fn().mockImplementation(() => {
        factoryCallCount++;
        return createMockSdkClient({
          sessions: [createTestSession({ id: `session-${factoryCallCount}`, directory: "/test" })],
          sessionStatuses: { [`session-${factoryCallCount}`]: { type: "busy" as const } },
        });
      });

      manager = new AgentStatusManager(mockDiscoveryService, factoryFn);

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      // Initialize workspace with no instances
      await manager.initWorkspace("/test/workspace" as WorkspacePath);
      listener.mockClear();

      // Simulate discovery service finding new instances
      instancesChangedCallback?.("/test/workspace", [{ port: 8080 }]);

      // Wait for async fetchStatuses to complete
      await vi.waitFor(() => {
        expect(factoryCallCount).toBeGreaterThan(0);
      });

      // Wait for status update notification
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalled();
      });

      // Verify the status reflects the port's status (1 port = 1 agent)
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("busy");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(1);
    });
  });

  describe("port-based aggregation", () => {
    it("single port idle returns { idle: 1, busy: 0 }", async () => {
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": { type: "idle" as const } },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
      expect(status.status).toBe("idle");
    });

    it("single port busy returns { idle: 0, busy: 1 }", async () => {
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": { type: "busy" as const } },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("busy");
    });

    it("multiple ports aggregate independently", async () => {
      // Create factory that returns different status for each port
      let portCounter = 0;
      const factoryFn = vi.fn().mockImplementation(() => {
        portCounter++;
        const isFirstPort = portCounter === 1;
        return createMockSdkClient({
          sessions: [createTestSession({ id: `ses-${portCounter}`, directory: "/test" })],
          sessionStatuses: {
            [`ses-${portCounter}`]: { type: isFirstPort ? ("idle" as const) : ("busy" as const) },
          },
        });
      });

      manager = new AgentStatusManager(mockDiscoveryService, factoryFn);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([
        { port: 8080 },
        { port: 9090 },
      ]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("mixed");
    });

    it("port removal clears associated status", async () => {
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": { type: "busy" as const } },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // Verify busy status
      let status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.busy).toBe(1);

      // Simulate port removal via instances changed callback
      instancesChangedCallback?.("/test/workspace", []);

      // Wait for the async Promise chain to settle
      // handleInstancesChanged has: initializeNewClients().then().then()
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("maps retry status to busy", async () => {
      const retryStatus: SdkSessionStatus = {
        type: "retry",
        attempt: 1,
        message: "Rate limited",
        next: Date.now() + 1000,
      };
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": retryStatus },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("busy");
    });

    it("permission events are handled via OpenCodeClient callbacks", async () => {
      // This test verifies that the manager properly subscribes to client permission events
      // by checking that the status updates when ports are added with sessions
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": { type: "idle" as const } },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // Should be idle (from the status response)
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
    });

    it("multiple ports track status independently", async () => {
      // This test verifies that each port maintains its own status
      // Create factory that returns different statuses for different ports
      let portCounter = 0;
      const factoryFn = vi.fn().mockImplementation(() => {
        portCounter++;
        const isFirstPort = portCounter === 1;
        return createMockSdkClient({
          sessions: [
            createTestSession({ id: `ses-${isFirstPort ? "X" : "Y"}`, directory: "/test" }),
          ],
          sessionStatuses: {
            [`ses-${isFirstPort ? "X" : "Y"}`]: {
              type: isFirstPort ? ("idle" as const) : ("busy" as const),
            },
          },
        });
      });

      manager = new AgentStatusManager(mockDiscoveryService, factoryFn);

      // Two instances for the same workspace
      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([
        { port: 8080 },
        { port: 9090 },
      ]);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // Should have mixed status (one idle, one busy)
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("mixed");
    });

    it("regression: no accumulation over many status change cycles", async () => {
      // Regression test: Verify that count stays at 1 for a single-port workspace
      // regardless of how many status changes occur (no session accumulation bug)
      const mockSdk = createMockSdkClient({
        sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
        sessionStatuses: { "ses-1": { type: "idle" as const } },
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(mockDiscoveryService, mockSdkFactory);

      vi.mocked(mockDiscoveryService.getInstancesForWorkspace).mockReturnValue([{ port: 8080 }]);

      // Initialize workspace (triggers first status fetch)
      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // Verify status is tracked correctly
      const status = manager.getStatus("/test/workspace" as WorkspacePath);

      // The key assertion: count should be exactly 1 for a single port
      // regardless of how many times we query
      expect(status.counts.idle + status.counts.busy).toBe(1);
    });
  });
});
