// @vitest-environment node
/**
 * Tests for OpenCodeClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeClient } from "./opencode-client";
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

  describe("getSessionStatuses", () => {
    it("returns session statuses on successful fetch", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "session-1", status: "idle" },
            { id: "session-2", status: "busy" },
          ]),
          { status: 200 }
        )
      );

      client = new OpenCodeClient(8080);
      const result = await client.getSessionStatuses();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]).toEqual({ type: "idle", sessionId: "session-1" });
        expect(result.value[1]).toEqual({ type: "busy", sessionId: "session-2" });
      }
    });

    it("uses correct URL", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

      client = new OpenCodeClient(3000);
      await client.getSessionStatuses();

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/session/status",
        expect.any(Object)
      );
    });

    it("returns error on timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));

      client = new OpenCodeClient(8080);
      const result = await client.getSessionStatuses();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("timeout");
      }
    });

    it("returns error on malformed JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

      client = new OpenCodeClient(8080);
      const result = await client.getSessionStatuses();

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
      const result = await client.getSessionStatuses();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid");
      }
    });
  });

  describe("event handling", () => {
    it("emits session.status events", async () => {
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onSessionEvent(listener);

      // Simulate receiving an SSE event via the internal handler
      const event: SessionStatus = { type: "busy", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("emits session.deleted events", async () => {
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onSessionEvent(listener);

      const event: SessionStatus = { type: "deleted", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("emits session.idle events", async () => {
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
      client.onSessionEvent(listener);

      const event: SessionStatus = { type: "idle", sessionId: "test-session" };
      client["emitSessionEvent"](event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("returns unsubscribe function", () => {
      const listener = vi.fn();
      client = new OpenCodeClient(8080);
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

  describe("parseSSEEvent", () => {
    it("parses session.status event", () => {
      client = new OpenCodeClient(8080);
      const result = client["parseSSEEvent"]("session.status", '{"id":"s1","status":"busy"}');

      expect(result).toEqual({ type: "busy", sessionId: "s1" });
    });

    it("parses session.idle event", () => {
      client = new OpenCodeClient(8080);
      const result = client["parseSSEEvent"]("session.idle", '{"id":"s1"}');

      expect(result).toEqual({ type: "idle", sessionId: "s1" });
    });

    it("parses session.deleted event", () => {
      client = new OpenCodeClient(8080);
      const result = client["parseSSEEvent"]("session.deleted", '{"id":"s1"}');

      expect(result).toEqual({ type: "deleted", sessionId: "s1" });
    });

    it("returns null for unknown event types", () => {
      client = new OpenCodeClient(8080);
      const result = client["parseSSEEvent"]("unknown.event", '{"id":"s1"}');

      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      client = new OpenCodeClient(8080);
      const result = client["parseSSEEvent"]("session.status", "not json");

      expect(result).toBeNull();
    });
  });
});
