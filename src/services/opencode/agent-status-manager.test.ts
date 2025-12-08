// @vitest-environment node
/**
 * Tests for AgentStatusManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatusManager } from "./agent-status-manager";
import type { DiscoveryService } from "./discovery-service";
import type { WorkspacePath } from "../../shared/ipc";

// Mock the eventsource package (used by OpenCodeClient)
vi.mock("eventsource", () => {
  const mockEventSource = vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    addEventListener: vi.fn(),
    onopen: null,
    onerror: null,
    onmessage: null,
  }));
  return { EventSource: mockEventSource };
});

describe("AgentStatusManager", () => {
  let manager: AgentStatusManager;
  let mockDiscoveryService: DiscoveryService;
  let instancesChangedCallback: ((workspace: string, ports: Set<number>) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    instancesChangedCallback = null;

    mockDiscoveryService = {
      setCodeServerPid: vi.fn(),
      scan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      getPortsForWorkspace: vi.fn().mockReturnValue(new Set<number>()),
      onInstancesChanged: vi.fn().mockImplementation((cb) => {
        instancesChangedCallback = cb;
        return () => {
          instancesChangedCallback = null;
        };
      }),
      dispose: vi.fn(),
    } as unknown as DiscoveryService;

    manager = new AgentStatusManager(mockDiscoveryService);
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

    it("gets ports from discovery service", async () => {
      vi.mocked(mockDiscoveryService.getPortsForWorkspace).mockReturnValue(new Set([8080]));

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      expect(mockDiscoveryService.getPortsForWorkspace).toHaveBeenCalledWith("/test/workspace");
    });

    it("shows idle status when connected but no sessions", async () => {
      // Mock fetch to return empty session array (OpenCode connected but no active sessions)
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

      // Return ports so provider has clients
      vi.mocked(mockDiscoveryService.getPortsForWorkspace).mockReturnValue(new Set([8080]));

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath);

      // When connected (has clients) but no sessions, should show idle with count 1
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);

      fetchSpy.mockRestore();
    });

    it("shows none status when no clients connected", async () => {
      // No ports = no clients
      vi.mocked(mockDiscoveryService.getPortsForWorkspace).mockReturnValue(new Set());

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

      // Simulate discovery service finding new ports
      instancesChangedCallback?.("/test/workspace", new Set([8080, 9090]));

      // Should not throw
      expect(manager.getStatus("/test/workspace" as WorkspacePath)).toBeDefined();
    });

    it("fetches statuses from new clients and updates status", async () => {
      // Mock fetch to return session data (OpenCode returns a direct array)
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "session-1", status: "idle" },
            { id: "session-2", status: "busy" },
          ]),
          { status: 200 }
        )
      );

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      // Initialize workspace with no ports
      await manager.initWorkspace("/test/workspace" as WorkspacePath);
      listener.mockClear();
      fetchSpy.mockClear();

      // Simulate discovery service finding new ports
      instancesChangedCallback?.("/test/workspace", new Set([8080]));

      // Wait for async fetchStatuses to complete
      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "http://localhost:8080/session/status",
          expect.any(Object)
        );
      });

      // Wait for status update notification
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalled();
      });

      // Verify the status reflects the fetched sessions
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("mixed"); // Both idle and busy sessions
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(1);

      fetchSpy.mockRestore();
    });
  });
});
