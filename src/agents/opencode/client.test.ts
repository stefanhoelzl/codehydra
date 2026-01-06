// @vitest-environment node
/**
 * Tests for OpenCodeClient.
 *
 * Tests the SDK-based OpenCodeClient implementation using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenCodeClient,
  isPermissionUpdatedEvent,
  isPermissionRepliedEvent,
  isValidSessionStatus,
  isSessionStatusResponse,
} from "./client";
import type { SessionStatus as OurSessionStatus } from "./types";
import {
  createSdkClientMock,
  createSdkFactoryMock,
  createTestSession,
  type SdkClientFactory,
  type MockSdkClient,
} from "./sdk-client.state-mock";
import type { SessionStatus as SdkSessionStatus } from "@opencode-ai/sdk";
import { SILENT_LOGGER } from "../../services/logging";

describe("OpenCodeClient", () => {
  let client: OpenCodeClient;
  let mockSdk: MockSdkClient;
  let mockFactory: SdkClientFactory;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Create default SDK mock with empty responses
    mockSdk = createSdkClientMock();
    mockFactory = createSdkFactoryMock(mockSdk);
  });

  afterEach(() => {
    client?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a client with mock SDK.
   * Casts to unknown first to satisfy OpenCodeClient's SdkClientFactory type.
   */
  function createClient(port = 8080, customFactory?: SdkClientFactory): OpenCodeClient {
    return new OpenCodeClient(
      port,
      SILENT_LOGGER,
      (customFactory ?? mockFactory) as unknown as import("./client").SdkClientFactory
    );
  }

  /**
   * Helper to create mock SDK that returns specific sessions with default idle status.
   */
  function createSdkWithSessions(
    sessions: Array<{ id: string; directory: string; parentID?: string }>
  ): MockSdkClient {
    return createSdkClientMock({
      sessions: sessions.map((s) => ({
        ...s,
        status: { type: "idle" as const },
      })),
    });
  }

  /**
   * Helper to create mock SDK that returns sessions with specific statuses.
   */
  function createSdkWithStatuses(statuses: Record<string, SdkSessionStatus>): MockSdkClient {
    return createSdkClientMock({
      sessions: Object.entries(statuses).map(([id, status]) => ({
        id,
        directory: "/test",
        status,
      })),
    });
  }

  /**
   * Helper to register sessions for event filtering.
   * Simulates what would happen when sessions are created via createSession() or SSE events.
   * Root sessions (no parentID) are added to rootSessionIds.
   * Child sessions are mapped to their root parent.
   */
  function registerSessions(
    c: OpenCodeClient,
    sessions: Array<{ id: string; parentID?: string }>
  ): void {
    for (const session of sessions) {
      const info: { id: string; parentID?: string } = { id: session.id };
      if (session.parentID !== undefined) {
        info.parentID = session.parentID;
      }
      c["handleSessionCreated"]({ info });
    }
  }

  describe("getStatus", () => {
    it("returns idle for empty status response", async () => {
      mockSdk = createSdkWithStatuses({});
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy when any session is busy", async () => {
      mockSdk = createSdkWithStatuses({
        "ses-1": { type: "busy" },
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("returns idle when all sessions are idle", async () => {
      mockSdk = createSdkWithStatuses({
        "ses-1": { type: "idle" },
        "ses-2": { type: "idle" },
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy for mixed statuses (any busy = busy)", async () => {
      mockSdk = createSdkWithStatuses({
        "ses-1": { type: "idle" },
        "ses-2": { type: "busy" },
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("maps retry to busy", async () => {
      mockSdk = createSdkWithStatuses({
        "ses-1": { type: "retry", attempt: 1, message: "Rate limited", next: Date.now() + 1000 },
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("returns error on SDK failure", async () => {
      mockSdk = createSdkClientMock({
        sessionStatusError: new Error("Request failed"),
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Request failed");
      }
    });

    it("returns error on timeout", async () => {
      mockSdk = createSdkClientMock({
        sessionStatusError: new Error("Request timeout"),
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    });
  });

  describe("onStatusChanged", () => {
    it("fires callback when root session status changes", () => {
      // Register root session first
      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onStatusChanged(listener);

      // Simulate SSE session.status event via handleMessage
      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        }),
      } as MessageEvent;

      client["handleMessage"](event);

      expect(listener).toHaveBeenCalledWith("busy");
    });

    it("does not fire callback for child session status changes", () => {
      // Register parent as root, child has parentID
      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
      client.onStatusChanged(listener);

      // Simulate status change for child session
      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "child-1", status: { type: "busy" } },
        }),
      } as MessageEvent;

      client["handleMessage"](event);

      // Should NOT fire for child sessions
      expect(listener).not.toHaveBeenCalled();
    });

    it("does not fire callback when status unchanged", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onStatusChanged(listener);

      // First status change to idle (same as default)
      const idleEvent = {
        data: JSON.stringify({
          type: "session.idle",
          properties: { sessionID: "ses-123" },
        }),
      } as MessageEvent;
      client["handleMessage"](idleEvent);
      listener.mockClear();

      // Same idle status again - should not fire
      client["handleMessage"](idleEvent);

      expect(listener).not.toHaveBeenCalled();
    });

    it("returns unsubscribe function", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      const unsubscribe = client.onStatusChanged(listener);

      unsubscribe();

      // Simulate status change
      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("currentStatus", () => {
    it("starts as idle", () => {
      client = createClient(8080);
      expect(client.currentStatus).toBe("idle");
    });

    it("updates on SSE session.status event for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](event);

      expect(client.currentStatus).toBe("busy");
    });

    it("does not update on SSE session.status event for child session", async () => {
      // Register parent as root, child has parentID
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "parent-1", directory: "/test" }),
        createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      // Child session goes busy - should NOT update currentStatus
      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "child-1", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](event);

      // Should still be idle (default)
      expect(client.currentStatus).toBe("idle");
    });

    it("updates on SSE session.idle event for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      // First set to busy
      const busyEvent = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](busyEvent);
      expect(client.currentStatus).toBe("busy");

      // Then idle event
      const idleEvent = {
        data: JSON.stringify({
          type: "session.idle",
          properties: { sessionID: "ses-123" },
        }),
      } as MessageEvent;
      client["handleMessage"](idleEvent);

      expect(client.currentStatus).toBe("idle");
    });

    it("does not update on SSE session.idle event for child session", async () => {
      // Register parent as root, child has parentID
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "parent-1", directory: "/test" }),
        createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      // Register parent as root, child mapped to parent
      registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);

      // Set parent to busy first
      const busyEvent = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "parent-1", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](busyEvent);
      expect(client.currentStatus).toBe("busy");

      // Child session goes idle - should NOT update currentStatus
      const idleEvent = {
        data: JSON.stringify({
          type: "session.idle",
          properties: { sessionID: "child-1" },
        }),
      } as MessageEvent;
      client["handleMessage"](idleEvent);

      // Should still be busy (parent is busy, child idle should be ignored)
      expect(client.currentStatus).toBe("busy");
    });

    it("maps retry to busy for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "retry" } },
        }),
      } as MessageEvent;
      client["handleMessage"](event);

      expect(client.currentStatus).toBe("busy");
    });
  });

  describe("event handling", () => {
    it("emits session.status events for root sessions", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "test-session", directory: "/test" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "test-session" }]);
      client.onSessionEvent(listener);

      // Simulate receiving an SSE event via the internal handler
      const event: OurSessionStatus = { type: "busy", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("does not emit events for child sessions", async () => {
      // Register parent as root, child has parentID
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "parent-session", directory: "/test" }),
        createTestSession({ id: "child-session", directory: "/test", parentID: "parent-session" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      // Register parent as root, child mapped to parent
      registerSessions(client, [
        { id: "parent-session" },
        { id: "child-session", parentID: "parent-session" },
      ]);
      client.onSessionEvent(listener);

      // Try to emit event for child session
      const childEvent: OurSessionStatus = { type: "busy", sessionId: "child-session" };
      client["emitSessionEvent"](childEvent);

      // Should not be called for child session
      expect(listener).not.toHaveBeenCalled();

      // But should be called for parent session
      const parentEvent: OurSessionStatus = { type: "idle", sessionId: "parent-session" };
      client["emitSessionEvent"](parentEvent);
      expect(listener).toHaveBeenCalledWith(parentEvent);
    });

    it("emits session.deleted events and removes from root set", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "test-session", directory: "/test" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "test-session" }]);
      client.onSessionEvent(listener);

      const event: OurSessionStatus = { type: "deleted", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
      // After deletion, the session should be removed from root set
      expect(client.isRootSession("test-session")).toBe(false);
    });

    it("emits session.idle events for root sessions", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "test-session", directory: "/test" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "test-session" }]);
      client.onSessionEvent(listener);

      const event: OurSessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("returns unsubscribe function", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "test-session", directory: "/test" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      const unsubscribe = client.onSessionEvent(listener);

      unsubscribe();

      const event: OurSessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("connect", () => {
    it("rejects when SDK subscribe fails", async () => {
      mockSdk = createSdkClientMock({
        connectionError: new Error("Connection failed"),
      });
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      await expect(client.connect()).rejects.toThrow("Connection failed");
    });

    it("rejects when connection times out", async () => {
      // Create a mock that never resolves event.subscribe()
      const neverResolvingEvent = vi.fn().mockReturnValue(new Promise(() => {}));
      mockSdk = createSdkClientMock();
      mockSdk.event.subscribe = neverResolvingEvent;
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      const connectPromise = client.connect(100); // 100ms timeout

      // Advance timers past the timeout and wait for promise to reject
      vi.advanceTimersByTime(150);

      // Verify the rejection is thrown
      await expect(connectPromise).rejects.toThrow("Connect timeout");
    });

    it("respects custom timeout parameter", async () => {
      // Create a mock that never resolves event.subscribe()
      const neverResolvingEvent = vi.fn().mockReturnValue(new Promise(() => {}));
      mockSdk = createSdkClientMock();
      mockSdk.event.subscribe = neverResolvingEvent;
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      // Use longer timeout of 500ms
      const connectPromise = client.connect(500);

      // Advance timers by 200ms - should NOT timeout yet
      vi.advanceTimersByTime(200);

      // Allow any pending microtasks to run
      await Promise.resolve();

      // Promise should still be pending (connect not resolved/rejected yet)
      // Advance past the 500ms timeout
      vi.advanceTimersByTime(350);

      await expect(connectPromise).rejects.toThrow("Connect timeout");
    });

    it("uses default timeout of 5000ms when not specified", async () => {
      // Create a mock that never resolves event.subscribe()
      const neverResolvingEvent = vi.fn().mockReturnValue(new Promise(() => {}));
      mockSdk = createSdkClientMock();
      mockSdk.event.subscribe = neverResolvingEvent;
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      const connectPromise = client.connect(); // Default timeout

      // Advance timers by 4900ms - should NOT timeout yet
      vi.advanceTimersByTime(4900);

      // Allow any pending microtasks to run
      await Promise.resolve();

      // Now advance past 5000ms
      vi.advanceTimersByTime(200);

      await expect(connectPromise).rejects.toThrow("Connect timeout");
    });

    it("succeeds when SDK resolves before timeout", async () => {
      mockSdk = createSdkClientMock();
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      // connect() should resolve without throwing
      await expect(client.connect(5000)).resolves.toBeUndefined();
    });

    it("does not connect if already connected", async () => {
      mockSdk = createSdkClientMock();
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);

      // First connect should succeed
      await expect(client.connect()).resolves.toBeUndefined();
      // Second connect should be a no-op (not throw)
      await expect(client.connect()).resolves.toBeUndefined();

      // Client should still be functional after double connect
      expect(mockSdk).toBeConnected();
    });

    it("does not connect if disposed", async () => {
      mockSdk = createSdkClientMock();
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      client.dispose();

      // Connect should be a no-op after dispose (not throw)
      await expect(client.connect()).resolves.toBeUndefined();

      // Client should not be connected
      expect(mockSdk).not.toBeConnected();
    });
  });

  describe("lifecycle", () => {
    it("can be disposed", () => {
      client = createClient(8080);
      expect(() => client.dispose()).not.toThrow();
    });

    it("clears listeners on dispose", () => {
      const listener = vi.fn();
      client = createClient(8080);
      client.onSessionEvent(listener);

      client.dispose();

      const event: OurSessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("handleSessionCreated", () => {
    it("adds new root session to tracking set", async () => {
      // Initialize with empty session list
      mockSdk = createSdkWithSessions([]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onSessionEvent(listener);

      // Simulate session.created event for root session
      client["handleSessionCreated"]({ info: { id: "new-root" } });

      expect(client.isRootSession("new-root")).toBe(true);
      // Should emit "created" event - status is unknown until we receive session.status
      // This allows sessionToPort tracking without assuming idle status
      expect(listener).toHaveBeenCalledWith({ type: "created", sessionId: "new-root" });
    });

    it("does not add child session to tracking set", async () => {
      mockSdk = createSdkWithSessions([]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onSessionEvent(listener);

      // Simulate session.created event for child session
      client["handleSessionCreated"]({ info: { id: "new-child", parentID: "some-parent" } });

      expect(client.isRootSession("new-child")).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed properties", async () => {
      mockSdk = createSdkWithSessions([]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onSessionEvent(listener);

      // Missing info
      client["handleSessionCreated"](undefined);
      client["handleSessionCreated"]({});
      client["handleSessionCreated"]({ info: {} });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("handleMessage", () => {
    describe("session.status events", () => {
      it("emits idle status for root sessions", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        // Simulate SSE event in OpenCode wire format
        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { sessionID: "ses-123", status: { type: "idle" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "ses-123" });
      });

      it("emits busy status for root sessions", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { sessionID: "ses-123", status: { type: "busy" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({ type: "busy", sessionId: "ses-123" });
      });

      it("maps retry status to busy", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { sessionID: "ses-123", status: { type: "retry" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({ type: "busy", sessionId: "ses-123" });
      });

      it("ignores events for non-root sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { sessionID: "child-1", status: { type: "busy" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores events with missing sessionID", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { status: { type: "busy" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores events with missing status", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.status",
            properties: { sessionID: "ses-123" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.created events", () => {
      it("adds root session and emits idle", async () => {
        mockSdk = createSdkWithSessions([]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.created",
            properties: { info: { id: "new-root" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(client.isRootSession("new-root")).toBe(true);
        // Should emit "created" event - status is unknown until we receive session.status
        expect(listener).toHaveBeenCalledWith({ type: "created", sessionId: "new-root" });
      });

      it("ignores child sessions", async () => {
        mockSdk = createSdkWithSessions([]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.created",
            properties: { info: { id: "child-1", parentID: "parent-1" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(client.isRootSession("child-1")).toBe(false);
        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.idle events", () => {
      it("emits idle status for root sessions", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "ses-123" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "ses-123" });
      });

      it("ignores non-root sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "child-1" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.deleted events", () => {
      it("emits deleted and removes from root set", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        expect(client.isRootSession("ses-123")).toBe(true);

        const event = {
          data: JSON.stringify({
            type: "session.deleted",
            properties: { sessionID: "ses-123" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({ type: "deleted", sessionId: "ses-123" });
        expect(client.isRootSession("ses-123")).toBe(false);
      });
    });

    describe("permission.updated events", () => {
      it("emits for root sessions with valid structure", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.updated",
            properties: {
              id: "perm-456",
              sessionID: "ses-123",
              type: "bash",
              title: "Run command",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "permission.updated",
          event: {
            id: "perm-456",
            sessionID: "ses-123",
            type: "bash",
            title: "Run command",
          },
        });
      });

      it("emits for tracked child sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        // Register parent as root and child mapped to parent
        registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.updated",
            properties: {
              id: "perm-456",
              sessionID: "child-1",
              type: "bash",
              title: "Run command",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        // Child sessions are now tracked and emit permission events
        expect(listener).toHaveBeenCalledWith({
          type: "permission.updated",
          event: {
            id: "perm-456",
            sessionID: "child-1",
            type: "bash",
            title: "Run command",
          },
        });
      });

      it("ignores untracked sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "other-session" }]); // Different session
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.updated",
            properties: {
              id: "perm-456",
              sessionID: "unknown-session",
              type: "bash",
              title: "Run command",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores malformed events", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        // Missing required fields
        const event = {
          data: JSON.stringify({
            type: "permission.updated",
            properties: { id: "perm-456" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("permission.replied events", () => {
      it("handles once response", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "ses-123",
              permissionID: "perm-456",
              response: "once",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "permission.replied",
          event: {
            sessionID: "ses-123",
            permissionID: "perm-456",
            response: "once",
          },
        });
      });

      it("handles always response", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "ses-123",
              permissionID: "perm-456",
              response: "always",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "permission.replied",
          event: {
            sessionID: "ses-123",
            permissionID: "perm-456",
            response: "always",
          },
        });
      });

      it("handles reject response", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "ses-123",
              permissionID: "perm-456",
              response: "reject",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "permission.replied",
          event: {
            sessionID: "ses-123",
            permissionID: "perm-456",
            response: "reject",
          },
        });
      });

      it("emits for tracked child sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        // Register parent as root and child mapped to parent
        registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "child-1",
              permissionID: "perm-456",
              response: "once",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        // Child sessions are now tracked and emit permission events
        expect(listener).toHaveBeenCalledWith({
          type: "permission.replied",
          event: {
            sessionID: "child-1",
            permissionID: "perm-456",
            response: "once",
          },
        });
      });

      it("ignores untracked sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "other-session" }]); // Different session
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "unknown-session",
              permissionID: "perm-456",
              response: "once",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores invalid response types", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onPermissionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "permission.replied",
            properties: {
              sessionID: "ses-123",
              permissionID: "perm-456",
              response: "invalid",
            },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      it("ignores invalid JSON", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = { data: "not valid json" } as MessageEvent;

        // Should not throw
        expect(() => client["handleMessage"](event)).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores unknown event types", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "unknown.event",
            properties: { sessionID: "ses-123" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores events without type field", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            properties: { sessionID: "ses-123" },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });
  });
});

describe("isPermissionUpdatedEvent", () => {
  it("validates correct permission.updated event structure", () => {
    const validEvent = {
      id: "perm-123",
      sessionID: "ses-456",
      type: "bash",
      title: "Run shell command",
    };

    expect(isPermissionUpdatedEvent(validEvent)).toBe(true);
  });

  it("rejects event missing id", () => {
    const invalid = {
      sessionID: "ses-456",
      type: "bash",
      title: "Run shell command",
    };

    expect(isPermissionUpdatedEvent(invalid)).toBe(false);
  });

  it("rejects event missing sessionID", () => {
    const invalid = {
      id: "perm-123",
      type: "bash",
      title: "Run shell command",
    };

    expect(isPermissionUpdatedEvent(invalid)).toBe(false);
  });

  it("rejects event missing type", () => {
    const invalid = {
      id: "perm-123",
      sessionID: "ses-456",
      title: "Run shell command",
    };

    expect(isPermissionUpdatedEvent(invalid)).toBe(false);
  });

  it("rejects event missing title", () => {
    const invalid = {
      id: "perm-123",
      sessionID: "ses-456",
      type: "bash",
    };

    expect(isPermissionUpdatedEvent(invalid)).toBe(false);
  });

  it("rejects null", () => {
    expect(isPermissionUpdatedEvent(null)).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isPermissionUpdatedEvent("string")).toBe(false);
    expect(isPermissionUpdatedEvent(123)).toBe(false);
    expect(isPermissionUpdatedEvent(undefined)).toBe(false);
  });
});

describe("isPermissionRepliedEvent", () => {
  it("validates correct permission.replied event structure", () => {
    const validEvent = {
      sessionID: "ses-456",
      permissionID: "perm-123",
      response: "once",
    };

    expect(isPermissionRepliedEvent(validEvent)).toBe(true);
  });

  it("validates all response types", () => {
    expect(isPermissionRepliedEvent({ sessionID: "s", permissionID: "p", response: "once" })).toBe(
      true
    );
    expect(
      isPermissionRepliedEvent({ sessionID: "s", permissionID: "p", response: "always" })
    ).toBe(true);
    expect(
      isPermissionRepliedEvent({ sessionID: "s", permissionID: "p", response: "reject" })
    ).toBe(true);
  });

  it("rejects invalid response types", () => {
    const invalid = {
      sessionID: "ses-456",
      permissionID: "perm-123",
      response: "invalid",
    };

    expect(isPermissionRepliedEvent(invalid)).toBe(false);
  });

  it("rejects event missing sessionID", () => {
    const invalid = {
      permissionID: "perm-123",
      response: "once",
    };

    expect(isPermissionRepliedEvent(invalid)).toBe(false);
  });

  it("rejects event missing permissionID", () => {
    const invalid = {
      sessionID: "ses-456",
      response: "once",
    };

    expect(isPermissionRepliedEvent(invalid)).toBe(false);
  });

  it("rejects event missing response", () => {
    const invalid = {
      sessionID: "ses-456",
      permissionID: "perm-123",
    };

    expect(isPermissionRepliedEvent(invalid)).toBe(false);
  });

  it("rejects null", () => {
    expect(isPermissionRepliedEvent(null)).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isPermissionRepliedEvent("string")).toBe(false);
    expect(isPermissionRepliedEvent(123)).toBe(false);
    expect(isPermissionRepliedEvent(undefined)).toBe(false);
  });
});

describe("isValidSessionStatus", () => {
  it("validates idle status", () => {
    expect(isValidSessionStatus({ type: "idle" })).toBe(true);
  });

  it("validates busy status", () => {
    expect(isValidSessionStatus({ type: "busy" })).toBe(true);
  });

  it("validates retry status", () => {
    expect(isValidSessionStatus({ type: "retry" })).toBe(true);
  });

  it("rejects invalid status type", () => {
    expect(isValidSessionStatus({ type: "invalid" })).toBe(false);
  });

  it("rejects missing type property", () => {
    expect(isValidSessionStatus({ status: "idle" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isValidSessionStatus(null)).toBe(false);
    expect(isValidSessionStatus(undefined)).toBe(false);
    expect(isValidSessionStatus("string")).toBe(false);
    expect(isValidSessionStatus(123)).toBe(false);
  });
});

describe("isSessionStatusResponse", () => {
  // Tests for SDK format (Record<string, SessionStatus>)
  it("accepts empty object", () => {
    expect(isSessionStatusResponse({})).toBe(true);
  });

  it("accepts object with single busy status", () => {
    const response = { "ses-1": { type: "busy" } };
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts object with single idle status", () => {
    const response = { "ses-1": { type: "idle" } };
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts object with multiple statuses", () => {
    const response = {
      "ses-1": { type: "idle" },
      "ses-2": { type: "busy" },
    };
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts object with retry status", () => {
    const response = { "ses-1": { type: "retry" } };
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts object with all three status types", () => {
    const response = {
      "ses-1": { type: "idle" },
      "ses-2": { type: "busy" },
      "ses-3": { type: "retry" },
    };
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  // Tests for rejecting arrays (old format)
  it("rejects array format", () => {
    expect(isSessionStatusResponse([])).toBe(false);
    expect(isSessionStatusResponse([{ type: "busy" }])).toBe(false);
  });

  // Tests for rejecting malformed entries
  it("rejects object with null value", () => {
    const response = { "ses-1": null };
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects object with unknown type", () => {
    const response = { "ses-1": { type: "unknown" } };
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects object with missing type property", () => {
    const response = { "ses-1": { status: "idle" } };
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects null", () => {
    expect(isSessionStatusResponse(null)).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isSessionStatusResponse("string")).toBe(false);
    expect(isSessionStatusResponse(123)).toBe(false);
    expect(isSessionStatusResponse(undefined)).toBe(false);
  });
});

describe("Permission Event Emission", () => {
  let client: OpenCodeClient;
  let mockSdk: MockSdkClient;
  let mockFactory: SdkClientFactory;

  function createSdkWithSessions(
    sessions: Array<{ id: string; directory: string; parentID?: string }>
  ): MockSdkClient {
    return createSdkClientMock({
      sessions: sessions.map((s) => ({
        ...s,
        status: { type: "idle" as const },
      })),
    });
  }

  function createClient(factory: SdkClientFactory): OpenCodeClient {
    return new OpenCodeClient(
      8080,
      SILENT_LOGGER,
      factory as unknown as import("./client").SdkClientFactory
    );
  }

  /**
   * Helper to register sessions for event filtering.
   */
  function registerSessions(
    c: OpenCodeClient,
    sessions: Array<{ id: string; parentID?: string }>
  ): void {
    for (const session of sessions) {
      const info: { id: string; parentID?: string } = { id: session.id };
      if (session.parentID !== undefined) {
        info.parentID = session.parentID;
      }
      c["handleSessionCreated"]({ info });
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSdk = createSdkClientMock();
    mockFactory = createSdkFactoryMock(mockSdk);
  });

  afterEach(() => {
    client?.dispose();
  });

  describe("permission.updated", () => {
    it("emits event for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      // Simulate permission.updated event via internal handler
      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "ses-123",
        type: "bash",
        title: "Run command",
      });

      expect(listener).toHaveBeenCalledWith({
        type: "permission.updated",
        event: {
          id: "perm-456",
          sessionID: "ses-123",
          type: "bash",
          title: "Run command",
        },
      });
    });

    it("emits for tracked child sessions", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "parent-1", directory: "/test" }),
        createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      // Register parent as root and child mapped to parent
      registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
      client.onPermissionEvent(listener);

      // Permission event for tracked child session should be emitted
      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "child-1",
        type: "bash",
        title: "Run command",
      });

      expect(listener).toHaveBeenCalledWith({
        type: "permission.updated",
        event: {
          id: "perm-456",
          sessionID: "child-1",
          type: "bash",
          title: "Run command",
        },
      });
    });

    it("ignores untracked sessions", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "parent-1", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "other-session" }]); // Different session
      client.onPermissionEvent(listener);

      // Permission event for unknown session should be ignored
      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "unknown-session",
        type: "bash",
        title: "Run command",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed events", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      // Send malformed event (missing required fields)
      client["handlePermissionUpdated"]({ id: "perm-456" });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores undefined properties", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      client["handlePermissionUpdated"](undefined);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("permission.replied", () => {
    it("emits event for root session", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      client["handlePermissionReplied"]({
        sessionID: "ses-123",
        permissionID: "perm-456",
        response: "once",
      });

      expect(listener).toHaveBeenCalledWith({
        type: "permission.replied",
        event: {
          sessionID: "ses-123",
          permissionID: "perm-456",
          response: "once",
        },
      });
    });

    it("emits for tracked child sessions", async () => {
      mockSdk = createSdkWithSessions([
        createTestSession({ id: "parent-1", directory: "/test" }),
        createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
      ]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      // Register parent as root and child mapped to parent
      registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
      client.onPermissionEvent(listener);

      client["handlePermissionReplied"]({
        sessionID: "child-1",
        permissionID: "perm-456",
        response: "once",
      });

      expect(listener).toHaveBeenCalledWith({
        type: "permission.replied",
        event: {
          sessionID: "child-1",
          permissionID: "perm-456",
          response: "once",
        },
      });
    });

    it("ignores untracked sessions", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "parent-1", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "other-session" }]); // Different session
      client.onPermissionEvent(listener);

      client["handlePermissionReplied"]({
        sessionID: "unknown-session",
        permissionID: "perm-456",
        response: "once",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed events", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      client["handlePermissionReplied"]({ sessionID: "ses-123" });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("subscription", () => {
    it("returns unsubscribe function", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      const unsubscribe = client.onPermissionEvent(listener);

      unsubscribe();

      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "ses-123",
        type: "bash",
        title: "Run command",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("clears listeners on dispose", async () => {
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      const listener = vi.fn();
      client = createClient(mockFactory);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onPermissionEvent(listener);

      client.dispose();

      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "ses-123",
        type: "bash",
        title: "Run command",
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
