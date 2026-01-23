/**
 * Integration tests for SessionLayer using behavioral mock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSessionLayerMock, type MockSessionLayer } from "./session.state-mock";
import { ShellError } from "./errors";

describe("SessionLayer (integration)", () => {
  let sessionLayer: MockSessionLayer;

  beforeEach(() => {
    sessionLayer = createSessionLayerMock();
  });

  describe("fromPartition", () => {
    it("creates a session handle", () => {
      const handle = sessionLayer.fromPartition("persist:test-partition");

      expect(handle.id).toMatch(/^session-\d+$/);
      expect(handle.__brand).toBe("SessionHandle");
      expect(sessionLayer).toHaveSession(handle.id);
    });

    it("returns the same handle for the same partition", () => {
      const handle1 = sessionLayer.fromPartition("persist:same-partition");
      const handle2 = sessionLayer.fromPartition("persist:same-partition");

      expect(handle1.id).toBe(handle2.id);
      expect(sessionLayer).toHaveSessionCount(1);
    });

    it("creates different handles for different partitions", () => {
      const handle1 = sessionLayer.fromPartition("persist:partition-a");
      const handle2 = sessionLayer.fromPartition("persist:partition-b");

      expect(handle1.id).not.toBe(handle2.id);
      expect(sessionLayer).toHaveSessionCount(2);
    });

    it("tracks partition name correctly", () => {
      const partition = "persist:test-project/workspace";
      const handle = sessionLayer.fromPartition(partition);

      expect(sessionLayer).toHaveSession(handle.id, { partition });
    });
  });

  describe("setPermissionRequestHandler", () => {
    it("tracks handler state when set", () => {
      const handle = sessionLayer.fromPartition("persist:permission-req");

      sessionLayer.setPermissionRequestHandler(handle, () => true);

      expect(sessionLayer).toHaveSession(handle.id, { requestHandler: true });
    });

    it("tracks handler state when cleared", () => {
      const handle = sessionLayer.fromPartition("persist:permission-req-clear");

      sessionLayer.setPermissionRequestHandler(handle, () => true);
      sessionLayer.setPermissionRequestHandler(handle, null);

      expect(sessionLayer).toHaveSession(handle.id, { requestHandler: false });
    });

    it("throws SESSION_NOT_FOUND for invalid handle", () => {
      const fakeHandle = { id: "session-999", __brand: "SessionHandle" as const };

      expect(() => {
        sessionLayer.setPermissionRequestHandler(fakeHandle, () => true);
      }).toThrow(ShellError);
    });
  });

  describe("setPermissionCheckHandler", () => {
    it("tracks handler state when set", () => {
      const handle = sessionLayer.fromPartition("persist:permission-check");

      sessionLayer.setPermissionCheckHandler(handle, () => true);

      expect(sessionLayer).toHaveSession(handle.id, { checkHandler: true });
    });

    it("tracks handler state when cleared", () => {
      const handle = sessionLayer.fromPartition("persist:permission-check-clear");

      sessionLayer.setPermissionCheckHandler(handle, () => true);
      sessionLayer.setPermissionCheckHandler(handle, null);

      expect(sessionLayer).toHaveSession(handle.id, { checkHandler: false });
    });

    it("throws SESSION_NOT_FOUND for invalid handle", () => {
      const fakeHandle = { id: "session-999", __brand: "SessionHandle" as const };

      expect(() => {
        sessionLayer.setPermissionCheckHandler(fakeHandle, () => true);
      }).toThrow(ShellError);
    });
  });

  describe("dispose", () => {
    it("removes all sessions from tracking", async () => {
      sessionLayer.fromPartition("persist:dispose-1");
      sessionLayer.fromPartition("persist:dispose-2");

      await sessionLayer.dispose();

      expect(sessionLayer).toHaveSessionCount(0);
    });

    it("can be called on empty layer", async () => {
      await expect(sessionLayer.dispose()).resolves.not.toThrow();
    });
  });
});
