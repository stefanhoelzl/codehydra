/**
 * Unit tests for the 1.x wire's event normalization (normalizeSdkEvent).
 *
 * The shapes are pinned against the SDK's event types; malformed payloads and
 * pre-1.1 events must normalize to undefined, never throw. The wire's calls
 * run against a real server in client.boundary.test.ts.
 */

import { describe, it, expect } from "vitest";
import { normalizeSdkEvent, isUserRequestAsked, isUserRequestResolved } from "./wire-v1";
import type { Event as SdkEvent } from "@opencode-ai/sdk";

/** The 1.x SDK event shape: `{ type, properties }`. */
function sdkEvent(type: string, properties: unknown): SdkEvent {
  return { type, properties } as unknown as SdkEvent;
}

describe("normalizeSdkEvent", () => {
  describe("session.status", () => {
    it("normalizes idle and busy", () => {
      expect(
        normalizeSdkEvent(
          sdkEvent("session.status", { sessionID: "ses-1", status: { type: "idle" } })
        )
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "idle" });
      expect(
        normalizeSdkEvent(
          sdkEvent("session.status", { sessionID: "ses-1", status: { type: "busy" } })
        )
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "busy" });
    });

    it("keeps retry for the client to map to busy", () => {
      expect(
        normalizeSdkEvent(
          sdkEvent("session.status", { sessionID: "ses-1", status: { type: "retry" } })
        )
      ).toEqual({ type: "session.status", sessionID: "ses-1", status: "retry" });
    });

    it("ignores a missing sessionID or status", () => {
      expect(normalizeSdkEvent(sdkEvent("session.status", {}))).toBeUndefined();
      expect(
        normalizeSdkEvent(sdkEvent("session.status", { sessionID: "ses-1", status: {} }))
      ).toBeUndefined();
    });

    it("ignores an unknown status type", () => {
      expect(
        normalizeSdkEvent(
          sdkEvent("session.status", { sessionID: "ses-1", status: { type: "weird" } })
        )
      ).toBeUndefined();
    });
  });

  describe("session.created", () => {
    it("normalizes a root session", () => {
      expect(normalizeSdkEvent(sdkEvent("session.created", { info: { id: "ses-1" } }))).toEqual({
        type: "session.created",
        sessionID: "ses-1",
      });
    });

    it("carries the parentID of a child session", () => {
      expect(
        normalizeSdkEvent(sdkEvent("session.created", { info: { id: "ses-2", parentID: "ses-1" } }))
      ).toEqual({ type: "session.created", sessionID: "ses-2", parentID: "ses-1" });
    });

    it("carries the title, where a child's [bg] marker lives", () => {
      expect(
        normalizeSdkEvent(
          sdkEvent("session.created", {
            info: { id: "ses-2", parentID: "ses-1", title: "[bg] review (@general subagent)" },
          })
        )
      ).toEqual({
        type: "session.created",
        sessionID: "ses-2",
        parentID: "ses-1",
        title: "[bg] review (@general subagent)",
      });
    });

    it("ignores a missing info or id", () => {
      expect(normalizeSdkEvent(sdkEvent("session.created", {}))).toBeUndefined();
      expect(normalizeSdkEvent(sdkEvent("session.created", { info: {} }))).toBeUndefined();
    });
  });

  describe("session.idle", () => {
    it("normalizes to a status event", () => {
      expect(normalizeSdkEvent(sdkEvent("session.idle", { sessionID: "ses-1" }))).toEqual({
        type: "session.status",
        sessionID: "ses-1",
        status: "idle",
      });
    });

    it("ignores a missing sessionID", () => {
      expect(normalizeSdkEvent(sdkEvent("session.idle", {}))).toBeUndefined();
    });
  });

  describe("session.deleted", () => {
    it("reads the SDK shape and the legacy shape", () => {
      expect(normalizeSdkEvent(sdkEvent("session.deleted", { info: { id: "ses-1" } }))).toEqual({
        type: "session.deleted",
        sessionID: "ses-1",
      });
      expect(normalizeSdkEvent(sdkEvent("session.deleted", { sessionID: "ses-1" }))).toEqual({
        type: "session.deleted",
        sessionID: "ses-1",
      });
    });

    it("ignores a payload with neither", () => {
      expect(normalizeSdkEvent(sdkEvent("session.deleted", {}))).toBeUndefined();
    });
  });

  describe("permissions", () => {
    it("normalizes asked and replied", () => {
      expect(
        normalizeSdkEvent(sdkEvent("permission.asked", { id: "req-1", sessionID: "ses-1" }))
      ).toEqual({
        type: "user-request.asked",
        kind: "permission",
        id: "req-1",
        sessionID: "ses-1",
      });
      expect(
        normalizeSdkEvent(
          sdkEvent("permission.replied", { sessionID: "ses-1", requestID: "req-1" })
        )
      ).toEqual({
        type: "user-request.resolved",
        kind: "permission",
        requestID: "req-1",
        sessionID: "ses-1",
      });
    });

    it("ignores the pre-1.1 permission.updated event", () => {
      expect(
        normalizeSdkEvent(sdkEvent("permission.updated", { sessionID: "ses-1" }))
      ).toBeUndefined();
    });

    it("ignores malformed payloads", () => {
      expect(normalizeSdkEvent(sdkEvent("permission.asked", {}))).toBeUndefined();
      expect(normalizeSdkEvent(sdkEvent("permission.asked", { id: "req-1" }))).toBeUndefined();
      expect(normalizeSdkEvent(sdkEvent("permission.replied", {}))).toBeUndefined();
    });
  });

  describe("questions", () => {
    it("normalizes asked, replied and rejected", () => {
      expect(
        normalizeSdkEvent(sdkEvent("question.asked", { id: "q-1", sessionID: "ses-1" }))
      ).toEqual({ type: "user-request.asked", kind: "question", id: "q-1", sessionID: "ses-1" });
      expect(
        normalizeSdkEvent(sdkEvent("question.replied", { sessionID: "ses-1", requestID: "q-1" }))
      ).toEqual({
        type: "user-request.resolved",
        kind: "question",
        requestID: "q-1",
        sessionID: "ses-1",
      });
      expect(
        normalizeSdkEvent(sdkEvent("question.rejected", { sessionID: "ses-1", requestID: "q-1" }))
      ).toEqual({
        type: "user-request.resolved",
        kind: "question",
        requestID: "q-1",
        sessionID: "ses-1",
      });
    });

    it("ignores malformed payloads", () => {
      expect(normalizeSdkEvent(sdkEvent("question.asked", { sessionID: "ses-1" }))).toBeUndefined();
      expect(normalizeSdkEvent(sdkEvent("question.replied", {}))).toBeUndefined();
    });
  });

  it("ignores unknown event types", () => {
    expect(normalizeSdkEvent(sdkEvent("something.else", {}))).toBeUndefined();
  });
});

describe("isUserRequestAsked", () => {
  it("accepts an id and a sessionID", () => {
    expect(isUserRequestAsked({ id: "req-1", sessionID: "ses-1", permission: "bash" })).toBe(true);
  });

  it("rejects a missing id or sessionID", () => {
    expect(isUserRequestAsked({ sessionID: "ses-1" })).toBe(false);
    expect(isUserRequestAsked({ id: "req-1" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isUserRequestAsked(null)).toBe(false);
    expect(isUserRequestAsked("x")).toBe(false);
  });
});

describe("isUserRequestResolved", () => {
  it("accepts a sessionID and a requestID", () => {
    expect(isUserRequestResolved({ sessionID: "ses-1", requestID: "req-1" })).toBe(true);
  });

  it("rejects the pre-1.1 permissionID shape", () => {
    expect(isUserRequestResolved({ sessionID: "ses-1", permissionID: "req-1" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isUserRequestResolved(undefined)).toBe(false);
    expect(isUserRequestResolved(42)).toBe(false);
  });
});
