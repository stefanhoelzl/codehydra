// @vitest-environment node
/**
 * Tests for AgentStatusManager.
 *
 * Uses SDK behavioral mock for testing OpenCodeClient integration.
 * AgentStatusManager now receives ports directly from OpenCodeServerManager
 * via callbacks routed through AppState.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatusManager, OpenCodeProvider } from "./status-manager";
import type { WorkspacePath } from "../../shared/ipc";
import {
  createSdkClientMock,
  createSdkFactoryMock,
  createTestSession,
  createSessionCreatedEvent,
  createSessionStatusEvent,
  asSdkFactory,
  type SdkClientFactory,
  type MockSdkClient,
} from "./sdk-client.state-mock";
import type { SessionStatus as SdkSessionStatus } from "@opencode-ai/sdk";
import { SILENT_LOGGER } from "../../services/logging";

/**
 * Helper to create and initialize a provider for testing.
 * Mirrors what AppState.handleServerStarted does.
 */
async function createAndInitializeProvider(
  port: number,
  sdkFactory: SdkClientFactory,
  workspacePath = "/test/workspace"
): Promise<OpenCodeProvider> {
  const provider = new OpenCodeProvider(workspacePath, SILENT_LOGGER, asSdkFactory(sdkFactory));
  await provider.connect(port);
  await provider.fetchStatus();
  return provider;
}

describe("AgentStatusManager", () => {
  let manager: AgentStatusManager;
  let mockSdkFactory: SdkClientFactory;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create default SDK mock factory
    const mockSdk = createSdkClientMock();
    mockSdkFactory = createSdkFactoryMock(mockSdk);

    manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));
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

  describe("addProvider", () => {
    it("registers provider and tracks workspace", async () => {
      const provider = await createAndInitializeProvider(14001, mockSdkFactory);
      manager.addProvider("/test/workspace" as WorkspacePath, provider);

      // Should have created a client and be tracking the workspace
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      // When connected but TUI not attached yet, shows "none"
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("shows none status when connected but TUI not attached", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createSdkClientMock({
        sessions: [],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      const listener = vi.fn();
      manager.onStatusChanged(listener);

      const provider = await createAndInitializeProvider(8080, mockSdkFactory);
      manager.addProvider("/test/workspace" as WorkspacePath, provider);

      // When connected (has client) but TUI not attached, should show "none"
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("none");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(0);
    });

    it("shows idle status when TUI attached but no sessions", async () => {
      // Mock SDK client with empty sessions
      const mockSdk = createSdkClientMock({
        sessions: [],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      const provider = await createAndInitializeProvider(8080, mockSdkFactory);
      manager.addProvider("/test/workspace" as WorkspacePath, provider);

      // Mark agent as active (simulates first MCP request received)
      manager.markActive("/test/workspace" as WorkspacePath);

      // When TUI attached but no sessions, should show "idle" (ready to use)
      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
    });

    it("does not duplicate if called twice with same path", async () => {
      const provider1 = await createAndInitializeProvider(14001, mockSdkFactory);
      const provider2 = await createAndInitializeProvider(14001, mockSdkFactory);
      manager.addProvider("/test/workspace" as WorkspacePath, provider1);
      manager.addProvider("/test/workspace" as WorkspacePath, provider2);

      expect(manager.getAllStatuses().size).toBe(1);
    });

    it("handles connection failure gracefully in provider creation", async () => {
      // Mock SDK that fails to connect
      const mockSdk = createSdkClientMock({
        sessions: [],
        connectionError: new Error("Connection refused"),
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      // Provider creation should not throw
      const provider = new OpenCodeProvider(
        "/test/workspace",
        SILENT_LOGGER,
        asSdkFactory(mockSdkFactory)
      );
      await expect(provider.connect(59999)).resolves.not.toThrow();
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace from tracking", async () => {
      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );
      expect(manager.getAllStatuses().size).toBe(1);

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("notifies listeners of removal", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );
      listener.mockClear();

      manager.removeWorkspace("/test/workspace" as WorkspacePath);

      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });

    it("disposes OpenCodeClient", async () => {
      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );

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

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );

      // When connected but TUI not attached yet, status is "none"
      expect(listener).toHaveBeenCalledWith(
        "/test/workspace",
        expect.objectContaining({ status: "none" })
      );
    });

    it("notifies when TUI attaches", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );
      listener.mockClear();

      // Mark agent as active
      manager.markActive("/test/workspace" as WorkspacePath);

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

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("markActive", () => {
    it("transitions status from none to idle when called", async () => {
      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );

      // Before TUI attach: status is "none"
      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("none");

      // Mark agent as active
      manager.markActive("/test/workspace" as WorkspacePath);

      // After TUI attach: status is "idle"
      expect(manager.getStatus("/test/workspace" as WorkspacePath).status).toBe("idle");
    });

    it("only notifies once when called multiple times", async () => {
      const listener = vi.fn();
      manager.onStatusChanged(listener);

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );
      listener.mockClear();

      // Call markActive multiple times
      manager.markActive("/test/workspace" as WorkspacePath);
      manager.markActive("/test/workspace" as WorkspacePath);
      manager.markActive("/test/workspace" as WorkspacePath);

      // Should only notify once (first call transitions from none to idle)
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does nothing for unknown workspace", () => {
      // Should not throw when called on unknown workspace
      expect(() => manager.markActive("/unknown/workspace" as WorkspacePath)).not.toThrow();
    });

    it("restores TUI attached state after workspace is re-initialized", async () => {
      // This tests the server restart scenario:
      // 1. TUI attaches (markActive called when first MCP request received)
      // 2. Server restarts (removeWorkspace + initWorkspace)
      // 3. New provider should have tuiAttached = true restored
      const path = "/test/workspace" as WorkspacePath;

      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));
      manager.markActive(path);

      // Verify TUI attached (should be "idle" status)
      expect(manager.getStatus(path).status).toBe("idle");

      // Simulate server restart: removeWorkspace then initWorkspace
      manager.removeWorkspace(path);

      // After removal, status should be "none"
      expect(manager.getStatus(path).status).toBe("none");

      // Re-initialize (simulates server restart with new provider)
      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));

      // Key assertion: TUI attached state should be restored from tracking set
      // So status should be "idle" (not "none" which would require waiting for new MCP request)
      expect(manager.getStatus(path).status).toBe("idle");
    });

    it("clearTuiTracking removes workspace from tracking", async () => {
      // This tests permanent deletion (vs restart):
      // After clearTuiTracking, re-initializing should NOT restore TUI attached state
      const path = "/test/workspace" as WorkspacePath;

      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));
      manager.markActive(path);

      // Verify TUI attached
      expect(manager.getStatus(path).status).toBe("idle");

      // Simulate permanent deletion: clearTuiTracking + removeWorkspace
      manager.clearTuiTracking(path);
      manager.removeWorkspace(path);

      // Re-initialize (simulates recreating workspace)
      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));

      // Key assertion: TUI attached state should NOT be restored
      // Status should be "none" (waiting for new MCP request)
      expect(manager.getStatus(path).status).toBe("none");
    });
  });

  describe("initializeClient with existing sessions", () => {
    it("registers existing sessions and processes their status events", async () => {
      // Create mock SDK with an existing session that matches our workspace
      const existingSessionId = "existing-session-123";
      const mockSdk = createSdkClientMock({
        sessions: [
          createTestSession({
            id: existingSessionId,
            directory: "/test/workspace",
            status: { type: "idle" },
          }),
        ],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      const path = "/test/workspace" as WorkspacePath;
      const provider = new OpenCodeProvider(path, SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      // Initialize the client - this should find the existing session and register it as a root session
      await provider.connect(8080);

      // Add the provider to the manager and mark it as active
      manager.addProvider(path, provider);
      manager.markActive(path);

      // Initially should be idle since the session starts as idle
      let status = manager.getStatus(path);
      expect(status.status).toBe("idle");
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);

      // Now emit a status change event for the existing session (simulating SSE)
      // This tests that the session was properly registered as a root session
      mockSdk.$.emitEvent(createSessionStatusEvent(existingSessionId, { type: "busy" }));

      // Wait for async processing
      await Promise.resolve();

      // Verify the status was updated correctly (should show busy)
      status = manager.getStatus(path);
      expect(status.status).toBe("busy");
      expect(status.counts.idle).toBe(0);
      expect(status.counts.busy).toBe(1);
    });
  });

  describe("dispose", () => {
    it("clears all state", async () => {
      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(14001, mockSdkFactory)
      );

      manager.dispose();

      expect(manager.getAllStatuses().size).toBe(0);
    });

    it("clears TUI tracking state", async () => {
      const path = "/test/workspace" as WorkspacePath;
      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));
      manager.markActive(path);

      // Verify TUI was attached
      expect(manager.getStatus(path).status).toBe("idle");

      // Dispose clears everything including TUI tracking
      manager.dispose();

      // Re-initialize on the same manager (after dispose)
      // This tests that tuiAttachedWorkspaces was cleared by dispose
      manager.addProvider(path, await createAndInitializeProvider(14001, mockSdkFactory));

      // If tuiAttachedWorkspaces was properly cleared, status should be "none"
      // (not "idle" which would indicate TUI tracking was restored)
      expect(manager.getStatus(path).status).toBe("none");
    });
  });

  describe("port-based aggregation", () => {
    /**
     * Helper to emit session events and wait for async processing.
     * This simulates receiving SSE events from the OpenCode server.
     */
    async function emitSessionEvents(
      mockSdk: MockSdkClient,
      sessions: Array<{ id: string; directory: string; status: SdkSessionStatus }>
    ): Promise<void> {
      for (const session of sessions) {
        // Emit session.created event to register the session
        mockSdk.$.emitEvent(
          createSessionCreatedEvent({
            id: session.id,
            directory: session.directory,
            title: "Test",
            projectID: "proj-test",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          })
        );
        // Emit session.status event to set the status
        mockSdk.$.emitEvent(createSessionStatusEvent(session.id, session.status));
      }
      // Wait for async processing of events
      await Promise.resolve();
    }

    it("single client idle returns { idle: 1, busy: 0 }", async () => {
      // Create mock with session that has idle status
      const mockSdk = createSdkClientMock({
        sessions: [
          createTestSession({ id: "ses-1", directory: "/test", status: { type: "idle" } }),
        ],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(8080, mockSdkFactory)
      );

      // Emit SSE events to register session and set status
      await emitSessionEvents(mockSdk, [
        { id: "ses-1", directory: "/test", status: { type: "idle" } },
      ]);

      // Mark agent as active (simulates first MCP request received)
      manager.markActive("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.idle).toBe(1);
      expect(status.counts.busy).toBe(0);
      expect(status.status).toBe("idle");
    });

    it("single client busy returns { idle: 0, busy: 1 }", async () => {
      // Create mock with session that has busy status
      const mockSdk = createSdkClientMock({
        sessions: [
          createTestSession({ id: "ses-1", directory: "/test", status: { type: "busy" } }),
        ],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(8080, mockSdkFactory)
      );

      // Emit SSE events to register session and set status
      await emitSessionEvents(mockSdk, [
        { id: "ses-1", directory: "/test", status: { type: "busy" } },
      ]);

      // Mark agent as active (simulates first MCP request received)
      manager.markActive("/test/workspace" as WorkspacePath);

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
      // Create mock with session that has retry status
      const mockSdk = createSdkClientMock({
        sessions: [createTestSession({ id: "ses-1", directory: "/test", status: retryStatus })],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(8080, mockSdkFactory)
      );

      // Emit SSE events to register session and set status
      await emitSessionEvents(mockSdk, [{ id: "ses-1", directory: "/test", status: retryStatus }]);

      // Mark agent as active (simulates first MCP request received)
      manager.markActive("/test/workspace" as WorkspacePath);

      const status = manager.getStatus("/test/workspace" as WorkspacePath);
      expect(status.counts.busy).toBe(1);
      expect(status.status).toBe("busy");
    });

    it("regression: no accumulation over many status change cycles", async () => {
      // Regression test: Verify that count stays at 1 for a single workspace
      // regardless of how many status changes occur (no session accumulation bug)
      const mockSdk = createSdkClientMock({
        sessions: [
          createTestSession({ id: "ses-1", directory: "/test", status: { type: "idle" } }),
        ],
      });
      mockSdkFactory = createSdkFactoryMock(mockSdk);
      manager = new AgentStatusManager(SILENT_LOGGER, asSdkFactory(mockSdkFactory));

      // Initialize workspace (triggers first status fetch)
      manager.addProvider(
        "/test/workspace" as WorkspacePath,
        await createAndInitializeProvider(8080, mockSdkFactory)
      );

      // Emit SSE events to register session and set status
      await emitSessionEvents(mockSdk, [
        { id: "ses-1", directory: "/test", status: { type: "idle" } },
      ]);

      // Mark agent as active (simulates first MCP request received)
      manager.markActive("/test/workspace" as WorkspacePath);

      // Verify status is tracked correctly
      const status = manager.getStatus("/test/workspace" as WorkspacePath);

      // The key assertion: count should be exactly 1 for a single workspace
      // regardless of how many times we query
      expect(status.counts.idle + status.counts.busy).toBe(1);
    });
  });
});
