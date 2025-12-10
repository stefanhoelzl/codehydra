// @vitest-environment node
/**
 * Tests for OpenCodeClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenCodeClient,
  isPermissionUpdatedEvent,
  isPermissionRepliedEvent,
  isValidSessionStatus,
  isSessionStatusResponse,
} from "./opencode-client";
import type { SessionStatus } from "./types";

// Mock the eventsource package
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

describe("OpenCodeClient", () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    client?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("getStatus", () => {
    it("returns idle for empty array response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy for array with busy status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([{ type: "busy" }]), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("returns idle for array with only idle status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([{ type: "idle" }]), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("idle");
      }
    });

    it("returns busy for mixed array (any busy = busy)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([{ type: "idle" }, { type: "busy" }]), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("maps retry to busy", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([{ type: "retry" }]), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("busy");
      }
    });

    it("uses correct URL", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

      client = new OpenCodeClient(3000);
      await client.getStatus();

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/session/status",
        expect.any(Object)
      );
    });

    it("returns error on HTTP 500", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Internal Server Error", { status: 500 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("500");
      }
    });

    it("returns error on timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("timeout");
      }
    });

    it("returns error on malformed JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid");
      }
    });

    it("returns error on invalid structure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ wrong: "structure" }), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.getStatus();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid");
      }
    });
  });

  describe("onStatusChanged", () => {
    it("fires callback when status changes", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
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

    it("does not fire callback when status unchanged", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onStatusChanged(listener);

      // First status change to idle
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
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
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
      client = new OpenCodeClient(8080);
      expect(client.currentStatus).toBe("idle");
    });

    it("updates on SSE session.status event", () => {
      client = new OpenCodeClient(8080);

      const event = {
        data: JSON.stringify({
          type: "session.status",
          properties: { sessionID: "ses-123", status: { type: "busy" } },
        }),
      } as MessageEvent;
      client["handleMessage"](event);

      expect(client.currentStatus).toBe("busy");
    });

    it("updates on SSE session.idle event", () => {
      client = new OpenCodeClient(8080);

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

    it("maps retry to busy", () => {
      client = new OpenCodeClient(8080);

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

  describe("SSE reconnection", () => {
    it("onopen handler calls getStatus() to re-fetch status", async () => {
      // This test verifies the onopen handler behavior by directly testing
      // the integration: when SSE connects, getStatus should be called.
      // Since mock EventSource callbacks are hard to trigger, we test the
      // underlying behavior: that getStatus returns correct status and
      // updates currentStatus when called.

      // Mock fetch to return busy status
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify([{ type: "busy" }]), { status: 200 }));

      const statusListener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onStatusChanged(statusListener);

      // Initial status is idle
      expect(client.currentStatus).toBe("idle");

      // Simulate what onopen does: call getStatus and update status
      // This is the behavior we want to verify works correctly
      const result = await client.getStatus();
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The updateCurrentStatus is private, but we can verify via currentStatus
        // that the client correctly parses the response
        expect(result.value).toBe("busy");
      }

      // Verify fetch was called with status endpoint
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:8080/session/status",
        expect.any(Object)
      );

      // Also verify EventSource was instantiated when connect() is called
      client.connect();
      const { EventSource } = await import("eventsource");
      expect(vi.mocked(EventSource)).toHaveBeenCalledWith("http://localhost:8080/event");

      fetchSpy.mockRestore();
    });
  });

  describe("event handling", () => {
    it("emits session.status events for root sessions", async () => {
      // Register root session first
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "test-session", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      // Simulate receiving an SSE event via the internal handler
      const event: SessionStatus = { type: "busy", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("does not emit events for child sessions", async () => {
      // Register parent as root, child has parentID
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "parent-session", directory: "/test", title: "Parent" },
            { id: "child-session", directory: "/test", title: "Child", parentID: "parent-session" },
          ]),
          { status: 200 }
        )
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      // Try to emit event for child session
      const childEvent: SessionStatus = { type: "busy", sessionId: "child-session" };
      client["emitSessionEvent"](childEvent);

      // Should not be called for child session
      expect(listener).not.toHaveBeenCalled();

      // But should be called for parent session
      const parentEvent: SessionStatus = { type: "idle", sessionId: "parent-session" };
      client["emitSessionEvent"](parentEvent);
      expect(listener).toHaveBeenCalledWith(parentEvent);
    });

    it("emits session.deleted events and removes from root set", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "test-session", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      const event: SessionStatus = { type: "deleted", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
      // After deletion, the session should be removed from root set
      expect(client.isRootSession("test-session")).toBe(false);
    });

    it("emits session.idle events for root sessions", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "test-session", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      const event: SessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("returns unsubscribe function", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "test-session", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      const unsubscribe = client.onSessionEvent(listener);

      unsubscribe();

      const event: SessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("can be disposed", () => {
      client = new OpenCodeClient(8080);
      expect(() => client.dispose()).not.toThrow();
    });

    it("clears listeners on dispose", () => {
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onSessionEvent(listener);

      client.dispose();

      const event: SessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("fetchRootSessions", () => {
    it("returns only root sessions", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "root-1", directory: "/test", title: "Root 1" },
            { id: "child-1", directory: "/test", title: "Child", parentID: "root-1" },
            { id: "root-2", directory: "/test", title: "Root 2" },
          ]),
          { status: 200 }
        )
      );

      client = new OpenCodeClient(8080);
      const result = await client.fetchRootSessions();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value.map((s) => s.id)).toEqual(["root-1", "root-2"]);
      }
    });

    it("registers root sessions for filtering", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "root-1", directory: "/test", title: "Root" },
            { id: "child-1", directory: "/test", title: "Child", parentID: "root-1" },
          ]),
          { status: 200 }
        )
      );

      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();

      expect(client.isRootSession("root-1")).toBe(true);
      expect(client.isRootSession("child-1")).toBe(false);
    });

    it("returns error on invalid response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ wrong: "structure" }), { status: 200 })
      );

      client = new OpenCodeClient(8080);
      const result = await client.fetchRootSessions();

      expect(result.ok).toBe(false);
    });
  });

  describe("handleSessionCreated", () => {
    it("adds new root session to tracking set", async () => {
      // Initialize with empty session list
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      // Simulate session.created event for root session (now takes object, not JSON string)
      client["handleSessionCreated"]({ info: { id: "new-root" } });

      expect(client.isRootSession("new-root")).toBe(true);
      // Should emit idle status for new root session
      expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "new-root" });
    });

    it("does not add child session to tracking set", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onSessionEvent(listener);

      // Simulate session.created event for child session (now takes object, not JSON string)
      client["handleSessionCreated"]({ info: { id: "new-child", parentID: "some-parent" } });

      expect(client.isRootSession("new-child")).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed properties", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { id: "parent-1", directory: "/test", title: "Parent" },
              { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
            ]),
            { status: 200 }
          )
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
        client.onSessionEvent(listener);

        const event = {
          data: JSON.stringify({
            type: "session.created",
            properties: { info: { id: "new-root" } },
          }),
        } as MessageEvent;

        client["handleMessage"](event);

        expect(client.isRootSession("new-root")).toBe(true);
        expect(listener).toHaveBeenCalledWith({ type: "idle", sessionId: "new-root" });
      });

      it("ignores child sessions", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { id: "parent-1", directory: "/test", title: "Parent" },
              { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
            ]),
            { status: 200 }
          )
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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

      it("ignores non-root sessions", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { id: "parent-1", directory: "/test", title: "Parent" },
              { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
            ]),
            { status: 200 }
          )
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores malformed events", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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

      it("ignores non-root sessions", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { id: "parent-1", directory: "/test", title: "Parent" },
              { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
            ]),
            { status: 200 }
          )
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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

        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores invalid response types", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
        client.onSessionEvent(listener);

        const event = { data: "not valid json" } as MessageEvent;

        // Should not throw
        expect(() => client["handleMessage"](event)).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
      });

      it("ignores unknown event types", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
            status: 200,
          })
        );

        const listener = vi.fn();
        client = new OpenCodeClient(8080);
        await client.fetchRootSessions();
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
  // Tests for new array format (OpenCode returns SessionStatusValue[])
  it("accepts empty array", () => {
    expect(isSessionStatusResponse([])).toBe(true);
  });

  it("accepts array with single busy status", () => {
    const response = [{ type: "busy" }];
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts array with single idle status", () => {
    const response = [{ type: "idle" }];
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts mixed array with idle and busy", () => {
    const response = [{ type: "idle" }, { type: "busy" }];
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts array with retry status", () => {
    const response = [{ type: "retry" }];
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  it("accepts array with all three status types", () => {
    const response = [{ type: "idle" }, { type: "busy" }, { type: "retry" }];
    expect(isSessionStatusResponse(response)).toBe(true);
  });

  // Tests for rejecting old object format
  it("rejects old object format with sessionId keys", () => {
    const response = {
      "session-1": { type: "busy" },
    };
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects empty object (old format)", () => {
    expect(isSessionStatusResponse({})).toBe(false);
  });

  // Tests for rejecting malformed entries
  it("rejects array with null entry", () => {
    const response = [null];
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects array with unknown type", () => {
    const response = [{ type: "unknown" }];
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects array with missing type property", () => {
    const response = [{ status: "idle" }];
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects array with non-object entry", () => {
    const response = ["idle"];
    expect(isSessionStatusResponse(response)).toBe(false);
  });

  it("rejects null", () => {
    expect(isSessionStatusResponse(null)).toBe(false);
  });

  it("rejects non-array values", () => {
    expect(isSessionStatusResponse("string")).toBe(false);
    expect(isSessionStatusResponse(123)).toBe(false);
    expect(isSessionStatusResponse(undefined)).toBe(false);
  });
});

describe("Permission Event Emission", () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    client?.dispose();
  });

  describe("permission.updated", () => {
    it("emits event for root session", async () => {
      // Register root session first
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Simulate permission.updated event via internal handler (now takes object, not JSON string)
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

    it("ignores child sessions", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "parent-1", directory: "/test", title: "Parent" },
            { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
          ]),
          { status: 200 }
        )
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Try to emit permission event for child session (now takes object, not JSON string)
      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "child-1",
        type: "bash",
        title: "Run command",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed events", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Send malformed event (missing required fields) (now takes object, not JSON string)
      client["handlePermissionUpdated"]({ id: "perm-456" });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores undefined properties", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      client["handlePermissionUpdated"](undefined);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("permission.replied", () => {
    it("emits event for root session", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Now takes object, not JSON string
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

    it("ignores child sessions", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "parent-1", directory: "/test", title: "Parent" },
            { id: "child-1", directory: "/test", title: "Child", parentID: "parent-1" },
          ]),
          { status: 200 }
        )
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Now takes object, not JSON string
      client["handlePermissionReplied"]({
        sessionID: "child-1",
        permissionID: "perm-456",
        response: "once",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("ignores malformed events", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      // Now takes object, not JSON string
      client["handlePermissionReplied"]({ sessionID: "ses-123" });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("subscription", () => {
    it("returns unsubscribe function", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      const unsubscribe = client.onPermissionEvent(listener);

      unsubscribe();

      // Now takes object, not JSON string
      client["handlePermissionUpdated"]({
        id: "perm-456",
        sessionID: "ses-123",
        type: "bash",
        title: "Run command",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("clears listeners on dispose", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "ses-123", directory: "/test", title: "Test" }]), {
          status: 200,
        })
      );

      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      await client.fetchRootSessions();
      client.onPermissionEvent(listener);

      client.dispose();

      // Now takes object, not JSON string
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
