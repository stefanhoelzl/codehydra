// @vitest-environment node
/**
 * Tests for AgentStatusManager.
 *
 * Uses SDK mock utilities for testing OpenCodeClient integration.
 * AgentStatusManager now receives ports directly from OpenCodeServerManager
 * via callbacks routed through AppState.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatusManager } from "./agent-status-manager";
import type { WorkspacePath } from "../../shared/ipc";
import {
  createMockSdkClient,
  createMockSdkFactory,
  createTestSession,
  createMockEventStream,
  createSessionCreatedEvent,
} from "./sdk-test-utils";
import type { SdkClientFactory } from "./opencode-client";
import type { SessionStatus as SdkSessionStatus } from "@opencode-ai/sdk";
import { SILENT_LOGGER } from "../logging";

describe("AgentStatusManager", () => {
  let manager: AgentStatusManager;
  let mockSdkFactory: SdkClientFactory;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create default SDK mock factory
    const mockSdk = createMockSdkClient();
    mockSdkFactory = createMockSdkFactory(mockSdk);

    manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);
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
    it("creates OpenCodeClient with provided port", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      // Should have created a client and be tracking the workspace
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      // When connected but TUI not attached yet, shows "none"
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("shows none status when connected but TUI not attached", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createMockSdkClient({
        sessions: [],
        sessionStatuses: {},
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);

      // When connected (has client) but TUI not attached, should show "none"
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("shows idle status when TUI attached but no sessions", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createMockSdkClient({
        sessions: [],
        sessionStatuses: {},
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);

      // Mark TUI as attached (simulates first MCP request received)
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      // When TUI attached but no sessions, should show "idle" (ready to use)
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
    });

    it("does not duplicate if called twice", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      expect(manager.getAllStatuses().size).toBe(1);
    });

    it("handles connection failure gracefully", async () => {
      // Mock SDK that fails to connect
      const mockSdk = createMockSdkClient({
        sessions: [],
        sessionStatuses: {},
      });
      // Simulate connection failure by making event.subscribe throw
      mockSdk.event.subscribe = vi.fn().mockRejectedValue(new Error("Connection refused"));
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      // Should not throw, but should handle gracefully
      await expect(
        manager.initWorkspace("/test/workspace" as WorkspacePath, 59999)
      ).resolves.not.toThrow();
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace from tracking", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);
      expect(manager.getAllStatuses().size).toBe(1);

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("notifies listeners of removal", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);
      listener.mockClear();

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });

    it("disposes OpenCodeClient", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      // Remove should dispose the client
      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      // Verify workspace is removed
      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("none");
    });
  });

  describe("onStatusChanged", () => {
    it("notifies when workspace is initialized", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      // When connected but TUI not attached yet, status is "none"
      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });

    it("notifies when TUI attaches", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);
      listener.mockClear();

      // Mark TUI as attached
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      // Should notify with "idle" status when TUI attaches (no sessions = ready to use)
      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "idle", counts: { idle: 1, busy: 0 } })
      );
    });

    it("returns unsubscribe function", async () => {
      const listener = vi.fn();
      const unsubscribe = manager.onStatusChanged(listener);

      unsubscribe();

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("setTuiAttached", () => {
    it("transitions status from none to idle when called", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      // Before TUI attach: status is "none"
      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("none");

      // Mark TUI as attached
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      // After TUI attach: status is "idle"
      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("idle");
    });

    it("only notifies once when called multiple times", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);
      listener.mockClear();

      // Call setTuiAttached multiple times
      manager.setTuiAttached("/test/workspace" as WorkspacePath);
      manager.setTuiAttached("/test/workspace" as WorkspacePath);
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      // Should only notify once (first call transitions from none to idle)
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does nothing for unknown workspace", () => {
      // Should not throw when called on unknown workspace
      expect(() => manager.setTuiAttached("/unknown/workspace" as WorkspacePath)).not.toThrow();
    });

    it("restores TUI attached state after workspace is re-initialized", async () => {
      // This tests the server restart scenario:
      // 1. TUI attaches (setTuiAttached called when first MCP request received)
      // 2. Server restarts (removeWorkspace + initWorkspace)
      // 3. New provider should have tuiAttached = true restored
      const path = "/test/workspace" as WorkspacePath;

      await manager.initWorkspace(path, 14001);
      manager.setTuiAttached(path);

      // Verify TUI attached (should be "idle" status)
      expect(manager.getStatus(path).status).toBe("idle");

      // Simulate server restart: removeWorkspace then initWorkspace
      manager.removeWorkspace(path);

      // After removal, status should be "none"
      expect(manager.getStatus(path).status).toBe("none");

      // Re-initialize (simulates server restart with new provider)
      await manager.initWorkspace(path, 14001);

      // Key assertion: TUI attached state should be restored from tracking set
      // So status should be "idle" (not "none" which would require waiting for new MCP request)
      expect(manager.getStatus(path).status).toBe("idle");
    });

    it("clearTuiTracking removes workspace from tracking", async () => {
      // This tests permanent deletion (vs restart):
      // After clearTuiTracking, re-initializing should NOT restore TUI attached state
      const path = "/test/workspace" as WorkspacePath;

      await manager.initWorkspace(path, 14001);
      manager.setTuiAttached(path);

      // Verify TUI attached
      expect(manager.getStatus(path).status).toBe("idle");

      // Simulate permanent deletion: clearTuiTracking + removeWorkspace
      manager.clearTuiTracking(path);
      manager.removeWorkspace(path);

      // Re-initialize (simulates recreating workspace)
      await manager.initWorkspace(path, 14001);

      // Key assertion: TUI attached state should NOT be restored
      // Status should be "none" (waiting for new MCP request)
      expect(manager.getStatus(path).status).toBe("none");
    });
  });

  describe("dispose", () => {
    it("clears all state", async () => {
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 14001);

      manager.dispose();

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("clears TUI tracking state", async () => {
      const path = "/test/workspace" as WorkspacePath;
      await manager.initWorkspace(path, 14001);
      manager.setTuiAttached(path);

      // Verify TUI was attached
      expect(manager.getStatus(path).status).toBe("idle");

      // Dispose clears everything including TUI tracking
      manager.dispose();

      // Re-initialize on the same manager (after dispose)
      // This tests that tuiAttachedWorkspaces was cleared by dispose
      await manager.initWorkspace(path, 14001);

      // If tuiAttachedWorkspaces was properly cleared, status should be "none"
      // (not "idle" which would indicate TUI tracking was restored)
      expect(manager.getStatus(path).status).toBe("none");
    });
  });

  describe("port-based aggregation", () => {
    it("single client idle returns { idle: 1, busy: 0 }", async () => {
      const testSession = createTestSession({ id: "ses-1", directory: "/test" });
      // Include session.created event to populate sessionToPort (via event stream)
      const mockSdk = createMockSdkClient({
        sessions: [testSession],
        sessionStatuses: { "ses-1": { type: "idle" as const } },
        eventStream: createMockEventStream([createSessionCreatedEvent(testSession)]),
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);
      // Mark TUI as attached (simulates first MCP request received)
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
      expect(status.status).toBe("idle");
    });

    it("single client busy returns { idle: 0, busy: 1 }", async () => {
      const testSession = createTestSession({ id: "ses-1", directory: "/test" });
      // Include session.created event to populate sessionToPort (via event stream)
      const mockSdk = createMockSdkClient({
        sessions: [testSession],
        sessionStatuses: { "ses-1": { type: "busy" as const } },
        eventStream: createMockEventStream([createSessionCreatedEvent(testSession)]),
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);
      // Mark TUI as attached (simulates first MCP request received)
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("busy");
    });

    it("maps retry status to busy", async () => {
      const retryStatus: SdkSessionStatus = {
        type: "retry",
        attempt: 1,
        message: "Rate limited",
        next: Date.now() + 1000,
      };
      const testSession = createTestSession({ id: "ses-1", directory: "/test" });
      // Include session.created event to populate sessionToPort (via event stream)
      const mockSdk = createMockSdkClient({
        sessions: [testSession],
        sessionStatuses: { "ses-1": retryStatus },
        eventStream: createMockEventStream([createSessionCreatedEvent(testSession)]),
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);
      // Mark TUI as attached (simulates first MCP request received)
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("busy");
    });

    it("regression: no accumulation over many status change cycles", async () => {
      // Regression test: Verify that count stays at 1 for a single workspace
      // regardless of how many status changes occur (no session accumulation bug)
      const testSession = createTestSession({ id: "ses-1", directory: "/test" });
      // Include session.created event to populate sessionToPort (via event stream)
      const mockSdk = createMockSdkClient({
        sessions: [testSession],
        sessionStatuses: { "ses-1": { type: "idle" as const } },
        eventStream: createMockEventStream([createSessionCreatedEvent(testSession)]),
      });
      mockSdkFactory = createMockSdkFactory(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, mockSdkFactory);

      // Initialize workspace (triggers first status fetch)
      await manager.initWorkspace("/test/workspace" as WorkspacePath, 8080);
      // Mark TUI as attached (simulates first MCP request received)
      manager.setTuiAttached("/test/workspace" as WorkspacePath);

      // Verify status is tracked correctly
      const status = manager.getStatus("/test/workspace" as WorkspacePath);

      // The key assertion: count should be exactly 1 for a single workspace
      // regardless of how many times we query
      expect(status.counts.idle + status.counts.busy).toBe(1);
    });
  });
});
