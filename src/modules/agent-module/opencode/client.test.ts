// @vitest-environment node
/**
 * Tests for OpenCodeClient.
 *
 * Tests the SDK-based OpenCodeClient implementation using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenCodeClient,
  isUserRequestAsked,
  isUserRequestResolved,
  isValidSessionStatus,
  isSessionStatusResponse,
} from "./client";
import type { SdkClientFactory as RealSdkClientFactory } from "./client";
import type { SessionStatus as OurSessionStatus } from "./types";
import {
  createSdkClientMock,
  createSdkFactoryMock,
  createTestSession,
  type SdkClientFactory,
  type MockSdkClient,
  type SdkEvent,
} from "./sdk-client.state-mock";
import type { SessionStatus as SdkSessionStatus } from "@opencode-ai/sdk";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";

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
      (customFactory ?? mockFactory) as unknown as RealSdkClientFactory
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

      // Simulate SDK session.status event via handleSdkEvent
      const event = {
        type: "session.status",
        properties: { sessionID: "ses-123", status: { type: "busy" } },
      } as unknown as SdkEvent;

      client["handleSdkEvent"](event);

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
        type: "session.status",
        properties: { sessionID: "child-1", status: { type: "busy" } },
      } as unknown as SdkEvent;

      client["handleSdkEvent"](event);

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
        type: "session.idle",
        properties: { sessionID: "ses-123" },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](idleEvent);
      listener.mockClear();

      // Same idle status again - should not fire
      client["handleSdkEvent"](idleEvent);

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
        type: "session.status",
        properties: { sessionID: "ses-123", status: { type: "busy" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("currentStatus", () => {
    it("starts as idle", () => {
      client = createClient(8080);
      expect(client["_currentStatus"]).toBe("idle");
    });

    it("updates on SSE session.status event for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = {
        type: "session.status",
        properties: { sessionID: "ses-123", status: { type: "busy" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](event);

      expect(client["_currentStatus"]).toBe("busy");
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
        type: "session.status",
        properties: { sessionID: "child-1", status: { type: "busy" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](event);

      // Should still be idle (default)
      expect(client["_currentStatus"]).toBe("idle");
    });

    it("updates on SSE session.idle event for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      // First set to busy
      const busyEvent = {
        type: "session.status",
        properties: { sessionID: "ses-123", status: { type: "busy" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](busyEvent);
      expect(client["_currentStatus"]).toBe("busy");

      // Then idle event
      const idleEvent = {
        type: "session.idle",
        properties: { sessionID: "ses-123" },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](idleEvent);

      expect(client["_currentStatus"]).toBe("idle");
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
        type: "session.status",
        properties: { sessionID: "parent-1", status: { type: "busy" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](busyEvent);
      expect(client["_currentStatus"]).toBe("busy");

      // Child session goes idle - should NOT update currentStatus
      const idleEvent = {
        type: "session.idle",
        properties: { sessionID: "child-1" },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](idleEvent);

      // Should still be busy (parent is busy, child idle should be ignored)
      expect(client["_currentStatus"]).toBe("busy");
    });

    it("maps retry to busy for root session", async () => {
      // Register root session first
      mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
      mockFactory = createSdkFactoryMock(mockSdk);

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = {
        type: "session.status",
        properties: { sessionID: "ses-123", status: { type: "retry" } },
      } as unknown as SdkEvent;
      client["handleSdkEvent"](event);

      expect(client["_currentStatus"]).toBe("busy");
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
      expect(client["rootSessionIds"].has("test-session")).toBe(false);
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

  describe("sendPromptAsync", () => {
    it("queues the prompt on the session and returns ok", async () => {
      client = createClient();

      const result = await client.sendPromptAsync("ses-1", "hello");

      expect(result.ok).toBe(true);
      expect(mockSdk.$.prompts).toEqual([
        expect.objectContaining({ sessionId: "ses-1", prompt: "hello", queued: true }),
      ]);
    });

    it("reports an error the server answered with", async () => {
      mockSdk.session.promptAsync = vi
        .fn()
        .mockResolvedValue({ data: undefined, error: { name: "NotFoundError" } });
      client = createClient();

      const result = await client.sendPromptAsync("ses-missing", "hello");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("NotFoundError");
    });

    it("reports a failed request", async () => {
      mockSdk.session.promptAsync = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      client = createClient();

      const result = await client.sendPromptAsync("ses-1", "hello");

      expect(result.ok).toBe(false);
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

      expect(client["rootSessionIds"].has("new-root")).toBe(true);
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

      expect(client["rootSessionIds"].has("new-child")).toBe(false);
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

  describe("handleSdkEvent", () => {
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
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "idle" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "retry" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.status",
          properties: { sessionID: "child-1", status: { type: "busy" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.status",
          properties: { status: { type: "busy" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.status",
          properties: { sessionID: "ses-123" },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.created",
          properties: { info: { id: "new-root" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

        expect(client["rootSessionIds"].has("new-root")).toBe(true);
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
          type: "session.created",
          properties: { info: { id: "child-1", parentID: "parent-1" } },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

        expect(client["rootSessionIds"].has("child-1")).toBe(false);
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
          type: "session.idle",
          properties: { sessionID: "ses-123" },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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
          type: "session.idle",
          properties: { sessionID: "child-1" },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

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

        expect(client["rootSessionIds"].has("ses-123")).toBe(true);

        const event = {
          type: "session.deleted",
          properties: { sessionID: "ses-123" },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({ type: "deleted", sessionId: "ses-123" });
        expect(client["rootSessionIds"].has("ses-123")).toBe(false);
      });
    });

    describe("user request events", () => {
      it.each([
        ["permission.asked", "permission"],
        ["question.asked", "question"],
      ] as const)("%s emits asked for root sessions", (type, kind) => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        const event = {
          type,
          properties: { id: "req-456", sessionID: "ses-123", permission: "bash", questions: [] },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "asked",
          event: { kind, id: "req-456", sessionID: "ses-123" },
        });
      });

      it.each([
        ["permission.replied", "permission", { reply: "once" }],
        ["permission.replied", "permission", { reply: "reject" }],
        ["question.replied", "question", { answers: [["yes"]] }],
        ["question.rejected", "question", {}],
      ] as const)("%s emits resolved (%s)", (type, kind, extra) => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        const event = {
          type,
          properties: { sessionID: "ses-123", requestID: "req-456", ...extra },
        } as unknown as SdkEvent;

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({
          type: "resolved",
          event: { kind, requestID: "req-456", sessionID: "ses-123" },
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
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"]({
          type: "permission.asked",
          properties: { id: "req-456", sessionID: "child-1" },
        } as unknown as SdkEvent);
        client["handleSdkEvent"]({
          type: "permission.replied",
          properties: { sessionID: "child-1", requestID: "req-456", reply: "once" },
        } as unknown as SdkEvent);

        expect(listener.mock.calls).toEqual([
          [{ type: "asked", event: { kind: "permission", id: "req-456", sessionID: "child-1" } }],
          [
            {
              type: "resolved",
              event: { kind: "permission", requestID: "req-456", sessionID: "child-1" },
            },
          ],
        ]);
      });

      it("ignores untracked sessions", async () => {
        mockSdk = createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
        ]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "other-session" }]); // Different session
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"]({
          type: "question.asked",
          properties: { id: "req-456", sessionID: "unknown-session" },
        } as unknown as SdkEvent);
        client["handleSdkEvent"]({
          type: "question.replied",
          properties: { sessionID: "unknown-session", requestID: "req-456" },
        } as unknown as SdkEvent);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores malformed events", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"]({
          type: "permission.asked",
          properties: { id: "req-456" },
        } as unknown as SdkEvent);
        client["handleSdkEvent"]({
          type: "permission.replied",
          properties: { sessionID: "ses-123" },
        } as unknown as SdkEvent);
        client["handleSdkEvent"]({
          type: "question.asked",
          properties: undefined,
        } as unknown as SdkEvent);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores the pre-1.1 permission.updated event", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"]({
          type: "permission.updated",
          properties: { id: "perm-456", sessionID: "ses-123", type: "bash", title: "Run" },
        } as unknown as SdkEvent);

        expect(listener).not.toHaveBeenCalled();
      });

      it("clears listeners on dispose", async () => {
        mockSdk = createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]);
        mockFactory = createSdkFactoryMock(mockSdk);

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client.dispose();

        client["handleSdkEvent"]({
          type: "permission.asked",
          properties: { id: "req-456", sessionID: "ses-123" },
        } as unknown as SdkEvent);

        expect(listener).not.toHaveBeenCalled();
      });
    });
  });
});

describe("isUserRequestAsked", () => {
  it("accepts an id and a sessionID", () => {
    expect(isUserRequestAsked({ id: "req-1", sessionID: "ses-1", permission: "bash" })).toBe(true);
  });

  it("rejects a missing id or sessionID", () => {
    expect(isUserRequestAsked({ sessionID: "ses-1" })).toBe(false);
    expect(isUserRequestAsked({ id: "req-1" })).toBe(false);
    expect(isUserRequestAsked({ id: 1, sessionID: "ses-1" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isUserRequestAsked(null)).toBe(false);
    expect(isUserRequestAsked("string")).toBe(false);
    expect(isUserRequestAsked(undefined)).toBe(false);
  });
});

describe("isUserRequestResolved", () => {
  it("accepts a sessionID and a requestID", () => {
    expect(isUserRequestResolved({ sessionID: "ses-1", requestID: "req-1", reply: "once" })).toBe(
      true
    );
  });

  it("rejects the pre-1.1 permissionID shape", () => {
    expect(
      isUserRequestResolved({ sessionID: "ses-1", permissionID: "perm-1", response: "once" })
    ).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isUserRequestResolved(null)).toBe(false);
    expect(isUserRequestResolved("string")).toBe(false);
    expect(isUserRequestResolved(undefined)).toBe(false);
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
