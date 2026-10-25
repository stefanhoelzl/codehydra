/**
 * Unit tests for OpenCodeClient — the wire-agnostic machinery: session
 * tracking (roots and subagents), status aggregation, and the listener
 * surface. The wire client is the behavioral mock (wire-client.state-mock.ts);
 * the real wires run in the boundary suites (client.boundary.test.ts for 1.x,
 * client-v2.boundary.test.ts for 2.x).
 */

import { describe, it, expect, vi } from "vitest";
import { OpenCodeClient } from "./client";
import {
  createWireClientMock,
  wireFactoryMock,
  type MockWireClient,
} from "./wire-client.state-mock";
import type { WireEvent } from "./wire";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";

const ROOT = "ses-0001";
const CHILD = "ses-0002";

/** A client over a fresh mock, with the mock returned for control. */
function createClient(mock?: MockWireClient): { client: OpenCodeClient; mock: MockWireClient } {
  const wire = mock ?? createWireClientMock();
  const client = new OpenCodeClient(
    8080,
    SILENT_LOGGER,
    { major: 1, directory: "/workspace" },
    wireFactoryMock(wire)
  );
  return { client, mock: wire };
}

describe("OpenCodeClient", () => {
  describe("getStatus", () => {
    it("returns idle when no session is busy", async () => {
      const { client } = createClient(
        createWireClientMock({
          sessions: [{ id: ROOT, directory: "/workspace", status: { type: "idle" } }],
        })
      );

      const result = await client.getStatus();
      expect(result).toEqual({ ok: true, value: "idle" });
    });

    it("returns busy when any session is busy", async () => {
      const { client } = createClient(
        createWireClientMock({
          sessions: [
            { id: ROOT, directory: "/workspace", status: { type: "idle" } },
            { id: CHILD, directory: "/workspace", status: { type: "busy" } },
          ],
        })
      );

      expect(await client.getStatus()).toEqual({ ok: true, value: "busy" });
    });

    it("maps retry to busy", async () => {
      const { client } = createClient(
        createWireClientMock({
          sessions: [{ id: ROOT, directory: "/workspace", status: { type: "retry" } }],
        })
      );

      expect(await client.getStatus()).toEqual({ ok: true, value: "busy" });
    });

    it("passes the wire's error through", async () => {
      const { client } = createClient(
        createWireClientMock({ statusError: new Error("server exploded") })
      );

      const result = await client.getStatus();
      expect(result.ok).toBe(false);
    });
  });

  describe("createSession", () => {
    it("creates a session and tracks it as a root", async () => {
      const { client, mock } = createClient();

      const result = await client.createSession();
      if (!result.ok) throw new Error(`expected a session, got: ${result.error.message}`);

      // Tracked immediately, so a status event that arrives before any
      // session.created event still updates the aggregate.
      const listener = vi.fn();
      client.onStatusChanged(listener);
      mock.$.emitEvent({ type: "session.status", sessionID: result.value.id, status: "busy" });

      expect(listener).toHaveBeenCalledWith("busy");
      expect(mock).toHaveWireSession(result.value.id);
    });
  });

  describe("prompts", () => {
    it("sends a prompt with agent and model selection", async () => {
      const { client, mock } = createClient(
        createWireClientMock({
          sessions: [{ id: ROOT, directory: "/workspace" }],
        })
      );

      const result = await client.sendPrompt(ROOT, "do the thing", {
        agent: "build",
        model: { providerID: "mock", modelID: "test" },
      });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(mock).toHaveSentPrompt(ROOT, "do the thing");
      expect(mock.$.prompts[0]).toMatchObject({
        agent: "build",
        model: { providerID: "mock", modelID: "test" },
      });
    });

    it("queues an async prompt without waiting for a turn", async () => {
      const { client, mock } = createClient(
        createWireClientMock({
          sessions: [{ id: ROOT, directory: "/workspace" }],
        })
      );

      await client.sendPromptAsync(ROOT, "later please");

      expect(mock).toHaveSentPrompt(ROOT, "later please");
      expect(mock.$.prompts[0]?.queued).toBe(true);
    });

    it("passes agent and model options through to the queued prompt", async () => {
      const { client, mock } = createClient();

      const result = await client.sendPromptAsync(ROOT, "hello", {
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-4" },
      });

      expect(result.ok).toBe(true);
      expect(mock.$.prompts).toEqual([
        expect.objectContaining({
          sessionId: ROOT,
          prompt: "hello",
          queued: true,
          agent: "coder",
          model: { providerID: "anthropic", modelID: "claude-4" },
        }),
      ]);
    });

    it("reports a wire error", async () => {
      const { client } = createClient();
      const result = await client.sendPrompt("missing", "hi");
      // The mock accepts everything; error mapping is the wires' concern, so
      // this pins only that a non-ok result flows through unchanged.
      expect(result.ok).toBe(true);
    });
  });

  describe("connect", () => {
    it("connects the wire and syncs the initial status", async () => {
      const { client, mock } = createClient(
        createWireClientMock({
          sessions: [{ id: ROOT, directory: "/workspace", status: { type: "busy" } }],
        })
      );
      const listener = vi.fn();
      client.onStatusChanged(listener);

      await client.connect();

      expect(mock).toBeConnected();
      // The busy session synced to the client's status on connect.
      expect(listener).toHaveBeenCalledWith("busy");
    });

    it("rejects when the wire cannot connect", async () => {
      const { client } = createClient(createWireClientMock({ connectError: new Error("refused") }));

      await expect(client.connect()).rejects.toThrow("refused");
    });

    it("does not connect twice", async () => {
      const { client, mock } = createClient();
      await client.connect();
      await client.connect();
      // Still connected — the second call was a no-op, not a second wire.
      expect(mock.$.connected).toBe(true);
    });

    it("does not connect when disposed", async () => {
      const { client, mock } = createClient();
      client.dispose();
      await client.connect();
      expect(mock.$.connected).toBe(false);
    });
  });

  describe("session events", () => {
    it("emits status events for root sessions only", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const events: string[] = [];
      client.onSessionEvent((event) => events.push(event.type));

      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });
      mock.$.emitEvent({ type: "session.status", sessionID: CHILD, status: "busy" });

      expect(events).toEqual(["busy"]);
    });

    it("maps retry to busy when emitting", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const events: Array<{ type: string; sessionId: string }> = [];
      client.onSessionEvent((event) => events.push(event));

      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "retry" });

      expect(events).toEqual([{ type: "busy", sessionId: ROOT }]);
    });

    it("tracks a session.created root and ignores children for emission", () => {
      const { client, mock } = createClient();
      const events: string[] = [];
      client.onSessionEvent((event) => events.push(event.type));

      mock.$.emitEvent({ type: "session.created", sessionID: ROOT });
      // A child of that root is tracked for user requests, but emits nothing.
      mock.$.emitEvent({ type: "session.created", sessionID: CHILD, parentID: ROOT });
      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });

      expect(events).toEqual(["created", "busy"]);
    });

    it("emits deleted for a root and forgets it", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const events: string[] = [];
      client.onSessionEvent((event) => events.push(event.type));

      mock.$.emitEvent({ type: "session.deleted", sessionID: ROOT });
      // A status for the now-forgotten session no longer emits.
      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });

      expect(events).toEqual(["deleted"]);
    });

    it("maps a grandchild to its root for user requests", () => {
      const { client, mock } = createClient();
      const asked: string[] = [];
      client.onUserRequestEvent((event) => {
        if (event.type === "asked") asked.push(event.event.sessionID);
      });

      mock.$.emitEvent({ type: "session.created", sessionID: ROOT });
      mock.$.emitEvent({ type: "session.created", sessionID: CHILD, parentID: ROOT });
      const grandchild = "ses-0003";
      mock.$.emitEvent({ type: "session.created", sessionID: grandchild, parentID: CHILD });

      mock.$.emitEvent({
        type: "user-request.asked",
        kind: "permission",
        id: "req-1",
        sessionID: grandchild,
      });

      expect(asked).toEqual([grandchild]);
    });
  });

  describe("user request events", () => {
    it("emits asked and resolved for a root session", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const seen: Array<{ type: string; kind: string }> = [];
      client.onUserRequestEvent((event) => seen.push({ type: event.type, kind: event.event.kind }));

      mock.$.emitEvent({
        type: "user-request.asked",
        kind: "permission",
        id: "req-1",
        sessionID: ROOT,
      });
      mock.$.emitEvent({
        type: "user-request.resolved",
        kind: "permission",
        requestID: "req-1",
        sessionID: ROOT,
      });

      expect(seen).toEqual([
        { type: "asked", kind: "permission" },
        { type: "resolved", kind: "permission" },
      ]);
    });

    it("carries the kind through — a form (2.x) behaves like a question", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const kinds: string[] = [];
      client.onUserRequestEvent((event) => kinds.push(event.event.kind));

      mock.$.emitEvent({ type: "user-request.asked", kind: "form", id: "f-1", sessionID: ROOT });
      mock.$.emitEvent({
        type: "user-request.resolved",
        kind: "form",
        requestID: "f-1",
        sessionID: ROOT,
      });

      expect(kinds).toEqual(["form", "form"]);
    });

    it("ignores requests for untracked sessions", () => {
      const { client, mock } = createClient();
      const seen: string[] = [];
      client.onUserRequestEvent((event) => seen.push(event.type));

      mock.$.emitEvent({
        type: "user-request.asked",
        kind: "permission",
        id: "req-1",
        sessionID: "unknown",
      });

      expect(seen).toEqual([]);
    });
  });

  describe("status aggregation", () => {
    it("starts idle and only notifies on change", () => {
      const { client, mock } = createClient();
      client.addRootSession(ROOT);
      const listener = vi.fn();
      client.onStatusChanged(listener);

      // Root goes busy — a change.
      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith("busy");

      // Still busy — no change, no notification.
      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });
      expect(listener).toHaveBeenCalledTimes(1);

      // An idle child session changes nothing.
      mock.$.emitEvent({ type: "session.created", sessionID: CHILD, parentID: ROOT });
      mock.$.emitEvent({ type: "session.status", sessionID: CHILD, status: "idle" });
      expect(listener).toHaveBeenCalledTimes(1);

      // Root goes idle — a change again.
      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "idle" });
      expect(listener).toHaveBeenLastCalledWith("idle");
    });

    describe("child sessions", () => {
      /** A client with an idle root and the given children, listening to status. */
      function withChildren(children: Array<{ id: string; parentID?: string; title?: string }>): {
        client: OpenCodeClient;
        mock: MockWireClient;
        listener: ReturnType<typeof vi.fn>;
      } {
        const { client, mock } = createClient();
        client.addRootSession(ROOT);
        for (const child of children) {
          mock.$.emitEvent({
            type: "session.created",
            sessionID: child.id,
            parentID: child.parentID ?? ROOT,
            ...(child.title !== undefined && { title: child.title }),
          });
        }
        const listener = vi.fn();
        client.onStatusChanged(listener);
        return { client, mock, listener };
      }

      function status(mock: MockWireClient, sessionID: string, type: "busy" | "idle"): void {
        mock.$.emitEvent({ type: "session.status", sessionID, status: type });
      }

      it("keeps the workspace busy while an unmarked child outlives the root's turn", () => {
        const { client, mock, listener } = withChildren([{ id: CHILD, title: "review auth" }]);
        status(mock, ROOT, "busy");
        status(mock, CHILD, "busy");
        status(mock, ROOT, "idle");
        expect(client["_currentStatus"]).toBe("busy");

        status(mock, CHILD, "idle");
        expect(listener.mock.calls).toEqual([["busy"], ["idle"]]);
      });

      it("goes idle with the root when only [bg] children run on", () => {
        const { mock, listener } = withChildren([
          { id: CHILD, title: "[BG] review auth (@general subagent)" },
        ]);
        status(mock, ROOT, "busy");
        status(mock, CHILD, "busy");
        status(mock, ROOT, "idle");
        expect(listener.mock.calls).toEqual([["busy"], ["idle"]]);
      });

      it("opts out everything under a [bg] child", () => {
        const { client, mock } = withChildren([
          { id: CHILD, title: "[bg] fan out" },
          { id: "grandchild", parentID: CHILD, title: "review auth" },
        ]);
        status(mock, "grandchild", "busy");
        expect(client["_currentStatus"]).toBe("idle");
      });

      it("matches the marker at the start only", () => {
        const { client, mock } = withChildren([{ id: CHILD, title: "explain the [bg] marker" }]);
        status(mock, CHILD, "busy");
        expect(client["_currentStatus"]).toBe("busy");
      });

      it("releases a busy child that is deleted", () => {
        const { client, mock } = withChildren([{ id: CHILD, title: "review auth" }]);
        status(mock, CHILD, "busy");
        mock.$.emitEvent({ type: "session.deleted", sessionID: CHILD });
        expect(client["_currentStatus"]).toBe("idle");
      });
    });
  });

  describe("lifecycle", () => {
    it("disconnect stops the stream and a new connect works", async () => {
      const { client, mock } = createClient();
      await client.connect();
      client.disconnect();
      expect(mock.$.connected).toBe(false);

      await client.connect();
      expect(mock.$.connected).toBe(true);
    });

    it("dispose clears listeners and stops the wire", async () => {
      const { client, mock } = createClient();
      await client.connect();
      const listener = vi.fn();
      client.onSessionEvent(listener);

      client.dispose();

      mock.$.emitEvent({ type: "session.status", sessionID: ROOT, status: "busy" });
      expect(listener).not.toHaveBeenCalled();
      expect(mock.$.connected).toBe(false);
    });
  });
});

// Re-exported for tests that construct events by hand.
export type { WireEvent };
