/**
 * Unit tests for the 2.x wire's event normalization (normalizeV2Event).
 *
 * Pins how the /api/event surface maps onto the normalized wire events — most
 * importantly that busy/idle is derived from the execution lifecycle, since
 * a v2 turn no longer emits `session.status` (verified against a real 2.1.x
 * server). The wire's calls run against a real server in
 * client-v2.boundary.test.ts.
 */

import { describe, it, expect } from "vitest";
import { normalizeV2Event } from "./wire-v2";
import type { V2Event } from "@opencode/client";

function v2Event(type: string, data: unknown): V2Event {
  return { type, data } as unknown as V2Event;
}

describe("normalizeV2Event", () => {
  it("maps a session.status event when one arrives", () => {
    expect(
      normalizeV2Event(v2Event("session.status", { sessionID: "ses-1", status: { type: "busy" } }))
    ).toEqual({ type: "session.status", sessionID: "ses-1", status: "busy" });
    expect(
      normalizeV2Event(v2Event("session.status", { sessionID: "ses-1", status: { type: "retry" } }))
    ).toEqual({ type: "session.status", sessionID: "ses-1", status: "retry" });
  });

  describe("the execution lifecycle is the busy/idle signal", () => {
    it("maps execution.started to busy", () => {
      expect(
        normalizeV2Event(v2Event("session.execution.started", { sessionID: "ses-1" }))
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "busy" });
    });

    it.each(["succeeded", "failed", "interrupted"])("maps execution.%s to idle", (outcome) => {
      expect(
        normalizeV2Event(v2Event(`session.execution.${outcome}`, { sessionID: "ses-1" }))
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "idle" });
    });

    it("maps retry.scheduled to busy — a retrying session is still working", () => {
      expect(
        normalizeV2Event(
          v2Event("session.retry.scheduled", {
            sessionID: "ses-1",
            attempt: 2,
            error: { type: "provider.transport" },
          })
        )
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "busy" });
    });
  });

  it("maps session.created, with a subagent's parentID", () => {
    expect(normalizeV2Event(v2Event("session.created", { sessionID: "ses-1" }))).toEqual({
      type: "session.created",
      sessionID: "ses-1",
    });
    expect(
      normalizeV2Event(v2Event("session.created", { sessionID: "ses-2", parentID: "ses-1" }))
    ).toEqual({ type: "session.created", sessionID: "ses-2", parentID: "ses-1" });
    expect(
      normalizeV2Event(
        v2Event("session.created", { sessionID: "ses-3", parentID: "ses-1", title: "[bg] fan out" })
      )
    ).toEqual({
      type: "session.created",
      sessionID: "ses-3",
      parentID: "ses-1",
      title: "[bg] fan out",
    });
  });

  it("maps session.deleted", () => {
    expect(normalizeV2Event(v2Event("session.deleted", { sessionID: "ses-1" }))).toEqual({
      type: "session.deleted",
      sessionID: "ses-1",
    });
  });

  describe("permissions", () => {
    it("maps asked and replied", () => {
      expect(
        normalizeV2Event(
          v2Event("permission.asked", {
            id: "req-1",
            sessionID: "ses-1",
            action: "shell",
            resources: ["git push"],
          })
        )
      ).toEqual({
        type: "user-request.asked",
        kind: "permission",
        id: "req-1",
        sessionID: "ses-1",
      });
      expect(
        normalizeV2Event(
          v2Event("permission.replied", { sessionID: "ses-1", requestID: "req-1", reply: "once" })
        )
      ).toEqual({
        type: "user-request.resolved",
        kind: "permission",
        requestID: "req-1",
        sessionID: "ses-1",
      });
    });
  });

  describe("forms (v2's questions)", () => {
    it("maps form.created from its nested shape", () => {
      expect(
        normalizeV2Event(
          v2Event("form.created", {
            form: { id: "form-1", sessionID: "ses-1", title: "Pick", fields: {} },
          })
        )
      ).toEqual({
        type: "user-request.asked",
        kind: "form",
        id: "form-1",
        sessionID: "ses-1",
      });
    });

    it.each(["replied", "cancelled"])("maps form.%s", (outcome) => {
      expect(
        normalizeV2Event(v2Event(`form.${outcome}`, { id: "form-1", sessionID: "ses-1" }))
      ).toEqual({
        type: "user-request.resolved",
        kind: "form",
        requestID: "form-1",
        sessionID: "ses-1",
      });
    });
  });

  it("ignores the many events the client has nothing to do with", () => {
    expect(normalizeV2Event(v2Event("session.text.delta", { sessionID: "ses-1" }))).toBeUndefined();
    expect(normalizeV2Event(v2Event("server.connected", {}))).toBeUndefined();
    expect(
      normalizeV2Event(v2Event("session.usage.updated", { sessionID: "ses-1" }))
    ).toBeUndefined();
  });
});
