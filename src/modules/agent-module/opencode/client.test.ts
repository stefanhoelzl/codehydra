// @vitest-environment node
/**
 * Tests for OpenCodeClient.
 *
 * Tests the SDK-based OpenCodeClient implementation using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeClient, isUserRequestAsked, isUserRequestResolved } from "./client";
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
    useSdk(createSdkClientMock());
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

  /** Make `sdk` the SDK every client created afterwards talks to. */
  function useSdk(sdk: MockSdkClient): void {
    mockSdk = sdk;
    mockFactory = createSdkFactoryMock(sdk);
  }

  /**
   * Create a client tracking `sessions` (see registerSessions) and return a
   * listener subscribed to its session events.
   */
  function listenToSessionEvents(
    sessions: Array<{ id: string; parentID?: string }>
  ): ReturnType<typeof vi.fn> {
    const listener = vi.fn();
    client = createClient(8080);
    registerSessions(client, sessions);
    client.onSessionEvent(listener);
    return listener;
  }

  /** An SSE event in OpenCode's wire format. */
  function sdkEvent(type: string, properties: Record<string, unknown>): SdkEvent {
    return { type, properties } as unknown as SdkEvent;
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
    /** What a client reports when the SDK lists sessions with `statuses`. */
    function statusWith(statuses: Record<string, SdkSessionStatus>) {
      useSdk(createSdkWithStatuses(statuses));
      client = createClient(8080);
      return client.getStatus();
    }

    it("returns idle for empty status response", async () => {
      const result = await statusWith({});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy when any session is busy", async () => {
      const result = await statusWith({
        "ses-1": { type: "busy" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("returns idle when all sessions are idle", async () => {
      const result = await statusWith({
        "ses-1": { type: "idle" },
        "ses-2": { type: "idle" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy for mixed statuses (any busy = busy)", async () => {
      const result = await statusWith({
        "ses-1": { type: "idle" },
        "ses-2": { type: "busy" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("maps retry to busy", async () => {
      const result = await statusWith({
        "ses-1": { type: "retry", attempt: 1, message: "Rate limited", next: Date.now() + 1000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("returns error on SDK failure", async () => {
      useSdk(
        createSdkClientMock({
          sessionStatusError: new Error("Request failed"),
        })
      );

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Request failed");
      }
    });

    it("returns error on timeout", async () => {
      useSdk(
        createSdkClientMock({
          // What fetch rejects with when an AbortSignal.timeout() fires
          sessionStatusError: new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError"
          ),
        })
      );

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    });

    it("returns CONNECTION_REFUSED from fetch's error cause", async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      });
      useSdk(
        createSdkClientMock({
          sessionStatusError: new TypeError("fetch failed", { cause }),
        })
      );

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONNECTION_REFUSED");
        expect(result.error.message).toBe("fetch failed");
      }
    });

    it("does not classify by words in the message", async () => {
      useSdk(
        createSdkClientMock({
          sessionStatusError: new Error("session timeout: ECONNREFUSED connection refused"),
        })
      );

      client = createClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REQUEST_FAILED");
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
      const event = sdkEvent("session.status", { sessionID: "ses-123", status: { type: "busy" } });

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
      const event = sdkEvent("session.status", { sessionID: "child-1", status: { type: "busy" } });

      client["handleSdkEvent"](event);

      // Should NOT fire for child sessions
      expect(listener).not.toHaveBeenCalled();
    });

    it("does not fire callback when status unchanged", async () => {
      // Register root session first
      useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      client.onStatusChanged(listener);

      // First status change to idle (same as default)
      const idleEvent = sdkEvent("session.idle", { sessionID: "ses-123" });
      client["handleSdkEvent"](idleEvent);
      listener.mockClear();

      // Same idle status again - should not fire
      client["handleSdkEvent"](idleEvent);

      expect(listener).not.toHaveBeenCalled();
    });

    it("returns unsubscribe function", async () => {
      // Register root session first
      useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

      const listener = vi.fn();
      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);
      const unsubscribe = client.onStatusChanged(listener);

      unsubscribe();

      // Simulate status change
      const event = sdkEvent("session.status", { sessionID: "ses-123", status: { type: "busy" } });
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
      useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = sdkEvent("session.status", { sessionID: "ses-123", status: { type: "busy" } });
      client["handleSdkEvent"](event);

      expect(client["_currentStatus"]).toBe("busy");
    });

    it("does not update on SSE session.status event for child session", async () => {
      // Register parent as root, child has parentID
      useSdk(
        createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ])
      );

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      // Child session goes busy - should NOT update currentStatus
      const event = sdkEvent("session.status", { sessionID: "child-1", status: { type: "busy" } });
      client["handleSdkEvent"](event);

      // Should still be idle (default)
      expect(client["_currentStatus"]).toBe("idle");
    });

    it("updates on SSE session.idle event for root session", async () => {
      // Register root session first
      useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      // First set to busy
      const busyEvent = sdkEvent("session.status", {
        sessionID: "ses-123",
        status: { type: "busy" },
      });
      client["handleSdkEvent"](busyEvent);
      expect(client["_currentStatus"]).toBe("busy");

      // Then idle event
      const idleEvent = sdkEvent("session.idle", { sessionID: "ses-123" });
      client["handleSdkEvent"](idleEvent);

      expect(client["_currentStatus"]).toBe("idle");
    });

    it("does not update on SSE session.idle event for child session", async () => {
      // Register parent as root, child has parentID
      useSdk(
        createSdkWithSessions([
          createTestSession({ id: "parent-1", directory: "/test" }),
          createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
        ])
      );

      client = createClient(8080);
      // Register parent as root, child mapped to parent
      registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);

      // Set parent to busy first
      const busyEvent = sdkEvent("session.status", {
        sessionID: "parent-1",
        status: { type: "busy" },
      });
      client["handleSdkEvent"](busyEvent);
      expect(client["_currentStatus"]).toBe("busy");

      // Child session goes idle - should NOT update currentStatus
      const idleEvent = sdkEvent("session.idle", { sessionID: "child-1" });
      client["handleSdkEvent"](idleEvent);

      // Should still be busy (parent is busy, child idle should be ignored)
      expect(client["_currentStatus"]).toBe("busy");
    });

    it("maps retry to busy for root session", async () => {
      // Register root session first
      useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

      client = createClient(8080);
      registerSessions(client, [{ id: "ses-123" }]);

      const event = sdkEvent("session.status", { sessionID: "ses-123", status: { type: "retry" } });
      client["handleSdkEvent"](event);

      expect(client["_currentStatus"]).toBe("busy");
    });
  });

  describe("event handling", () => {
    it("emits session.status events for root sessions", async () => {
      useSdk(
        createSdkWithSessions([createTestSession({ id: "test-session", directory: "/test" })])
      );

      const listener = listenToSessionEvents([{ id: "test-session" }]);

      // Simulate receiving an SSE event via the internal handler
      const event: OurSessionStatus = { type: "busy", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("does not emit events for child sessions", async () => {
      // Register parent as root, child has parentID
      useSdk(
        createSdkWithSessions([
          createTestSession({ id: "parent-session", directory: "/test" }),
          createTestSession({
            id: "child-session",
            directory: "/test",
            parentID: "parent-session",
          }),
        ])
      );

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
      useSdk(
        createSdkWithSessions([createTestSession({ id: "test-session", directory: "/test" })])
      );

      const listener = listenToSessionEvents([{ id: "test-session" }]);

      const event: OurSessionStatus = { type: "deleted", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
      // After deletion, the session should be removed from root set
      expect(client["rootSessionIds"].has("test-session")).toBe(false);
    });

    it("emits session.idle events for root sessions", async () => {
      useSdk(
        createSdkWithSessions([createTestSession({ id: "test-session", directory: "/test" })])
      );

      const listener = listenToSessionEvents([{ id: "test-session" }]);

      const event: OurSessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });
  });

  describe("connect", () => {
    it("rejects when SDK subscribe fails", async () => {
      useSdk(
        createSdkClientMock({
          connectionError: new Error("Connection failed"),
        })
      );

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
      useSdk(createSdkClientMock());

      client = createClient(8080);

      // connect() should resolve without throwing
      await expect(client.connect(5000)).resolves.toBeUndefined();
    });

    it("leaves no timeout timer behind once connected", async () => {
      useSdk(createSdkClientMock());
      client = createClient(8080);
      const before = vi.getTimerCount();

      await client.connect(5000);

      // The connect deadline used to stay armed for its full duration.
      expect(vi.getTimerCount()).toBe(before);
    });

    it("does not connect if already connected", async () => {
      useSdk(createSdkClientMock());

      client = createClient(8080);

      // First connect should succeed
      await expect(client.connect()).resolves.toBeUndefined();
      // Second connect should be a no-op (not throw)
      await expect(client.connect()).resolves.toBeUndefined();

      // Client should still be functional after double connect
      expect(mockSdk).toBeConnected();
    });

    it("does not connect if disposed", async () => {
      useSdk(createSdkClientMock());

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
      useSdk(createSdkWithSessions([]));

      const listener = listenToSessionEvents([{ id: "ses-123" }]);

      // Simulate session.created event for root session
      client["handleSessionCreated"]({ info: { id: "new-root" } });

      expect(client["rootSessionIds"].has("new-root")).toBe(true);
      // Should emit "created" event - status is unknown until we receive session.status
      // This allows sessionToPort tracking without assuming idle status
      expect(listener).toHaveBeenCalledWith({ type: "created", sessionId: "new-root" });
    });

    it("does not add child session to tracking set", async () => {
      useSdk(createSdkWithSessions([]));

      const listener = listenToSessionEvents([{ id: "ses-123" }]);

      // Simulate session.created event for child session
      client["handleSessionCreated"]({ info: { id: "new-child", parentID: "some-parent" } });

      expect(client["rootSessionIds"].has("new-child")).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed properties", async () => {
      useSdk(createSdkWithSessions([]));

      const listener = listenToSessionEvents([{ id: "ses-123" }]);

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
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        // Simulate SSE event in OpenCode wire format
        const event = sdkEvent("session.status", {
          sessionID: "ses-123",
          status: { type: "idle" },
        });

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "ses-123" });
      });

      it("emits busy status for root sessions", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.status", {
          sessionID: "ses-123",
          status: { type: "busy" },
        });

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({ type: "busy", sessionId: "ses-123" });
      });

      it("maps retry status to busy", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.status", {
          sessionID: "ses-123",
          status: { type: "retry" },
        });

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({ type: "busy", sessionId: "ses-123" });
      });

      it("ignores events for non-root sessions", async () => {
        useSdk(
          createSdkWithSessions([
            createTestSession({ id: "parent-1", directory: "/test" }),
            createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
          ])
        );

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.status", {
          sessionID: "child-1",
          status: { type: "busy" },
        });

        client["handleSdkEvent"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores events with missing sessionID", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.status", { status: { type: "busy" } });

        client["handleSdkEvent"](event);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores events with missing status", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.status", { sessionID: "ses-123" });

        client["handleSdkEvent"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.created events", () => {
      it("adds root session and emits idle", async () => {
        useSdk(createSdkWithSessions([]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.created", { info: { id: "new-root" } });

        client["handleSdkEvent"](event);

        expect(client["rootSessionIds"].has("new-root")).toBe(true);
        // Should emit "created" event - status is unknown until we receive session.status
        expect(listener).toHaveBeenCalledWith({ type: "created", sessionId: "new-root" });
      });

      it("ignores child sessions", async () => {
        useSdk(createSdkWithSessions([]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.created", {
          info: { id: "child-1", parentID: "parent-1" },
        });

        client["handleSdkEvent"](event);

        expect(client["rootSessionIds"].has("child-1")).toBe(false);
        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.idle events", () => {
      it("emits idle status for root sessions", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.idle", { sessionID: "ses-123" });

        client["handleSdkEvent"](event);

        expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "ses-123" });
      });

      it("ignores non-root sessions", async () => {
        useSdk(
          createSdkWithSessions([
            createTestSession({ id: "parent-1", directory: "/test" }),
            createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
          ])
        );

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        const event = sdkEvent("session.idle", { sessionID: "child-1" });

        client["handleSdkEvent"](event);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe("session.deleted events", () => {
      it("emits deleted and removes from root set", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = listenToSessionEvents([{ id: "ses-123" }]);

        expect(client["rootSessionIds"].has("ses-123")).toBe(true);

        const event = sdkEvent("session.deleted", { sessionID: "ses-123" });

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
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

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
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

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
        useSdk(
          createSdkWithSessions([
            createTestSession({ id: "parent-1", directory: "/test" }),
            createTestSession({ id: "child-1", directory: "/test", parentID: "parent-1" }),
          ])
        );

        const listener = vi.fn();
        client = createClient(8080);
        // Register parent as root and child mapped to parent
        registerSessions(client, [{ id: "parent-1" }, { id: "child-1", parentID: "parent-1" }]);
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"](
          sdkEvent("permission.asked", { id: "req-456", sessionID: "child-1" })
        );
        client["handleSdkEvent"](
          sdkEvent("permission.replied", {
            sessionID: "child-1",
            requestID: "req-456",
            reply: "once",
          })
        );

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
        useSdk(createSdkWithSessions([createTestSession({ id: "parent-1", directory: "/test" })]));

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "other-session" }]); // Different session
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"](
          sdkEvent("question.asked", { id: "req-456", sessionID: "unknown-session" })
        );
        client["handleSdkEvent"](
          sdkEvent("question.replied", { sessionID: "unknown-session", requestID: "req-456" })
        );

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores malformed events", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"](sdkEvent("permission.asked", { id: "req-456" }));
        client["handleSdkEvent"](sdkEvent("permission.replied", { sessionID: "ses-123" }));
        client["handleSdkEvent"]({
          type: "question.asked",
          properties: undefined,
        } as unknown as SdkEvent);

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores the pre-1.1 permission.updated event", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client["handleSdkEvent"](
          sdkEvent("permission.updated", {
            id: "perm-456",
            sessionID: "ses-123",
            type: "bash",
            title: "Run",
          })
        );

        expect(listener).not.toHaveBeenCalled();
      });

      it("clears listeners on dispose", async () => {
        useSdk(createSdkWithSessions([createTestSession({ id: "ses-123", directory: "/test" })]));

        const listener = vi.fn();
        client = createClient(8080);
        registerSessions(client, [{ id: "ses-123" }]);
        client.onUserRequestEvent(listener);

        client.dispose();

        client["handleSdkEvent"](
          sdkEvent("permission.asked", { id: "req-456", sessionID: "ses-123" })
        );

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
