/**
 * Boundary tests for DefaultOsNotificationBoundary against a mocked Electron
 * Notification class.
 *
 * These exercise the real implementation (not the behavioral mock) to verify
 * the parts that only exist because Electron behaves the way it does: the
 * unsupported-platform escape hatch, the handle bookkeeping that keeps
 * `closeAll` from touching notifications the OS already retired, and the
 * click/close event wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { instances, MockNotification, isSupported } = vi.hoisted(() => {
  const instances: MockNotificationInstance[] = [];
  const isSupported = vi.fn(() => true);

  interface MockNotificationInstance {
    options: { title?: string; body?: string };
    handlers: Map<string, () => void>;
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    on: (event: string, handler: () => void) => void;
    emit: (event: string) => void;
  }

  class MockNotification {
    static isSupported = isSupported;
    readonly handlers = new Map<string, () => void>();
    readonly show = vi.fn();
    readonly close = vi.fn();

    constructor(readonly options: { title?: string; body?: string }) {
      instances.push(this as unknown as MockNotificationInstance);
    }

    on(event: string, handler: () => void): void {
      this.handlers.set(event, handler);
    }

    emit(event: string): void {
      this.handlers.get(event)?.();
    }
  }

  return { instances, MockNotification, isSupported };
});

vi.mock("electron", () => ({ Notification: MockNotification }));

import { DefaultOsNotificationBoundary } from "./os-notification";
import { SILENT_LOGGER } from "../platform/logging";

describe("DefaultOsNotificationBoundary (real implementation)", () => {
  let boundary: DefaultOsNotificationBoundary;

  beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    isSupported.mockReturnValue(true);
    boundary = new DefaultOsNotificationBoundary(SILENT_LOGGER);
  });

  describe("show", () => {
    it("constructs and shows a notification with title and body", () => {
      const handle = boundary.show({ title: "Agent idle", body: "my-workspace" });

      expect(handle).not.toBeNull();
      expect(instances).toHaveLength(1);
      expect(instances[0]?.options).toMatchObject({ title: "Agent idle", body: "my-workspace" });
      expect(instances[0]?.show).toHaveBeenCalledOnce();
    });

    it("leaves the OS sound alone — `silent` is the chime's setting, not the toast's", () => {
      boundary.show({ title: "t", body: "b" });

      expect(instances[0]?.options).not.toHaveProperty("silent");
    });

    it("returns null and constructs nothing when the platform has no notifications", () => {
      isSupported.mockReturnValue(false);

      const handle = boundary.show({ title: "t", body: "b" });

      expect(handle).toBeNull();
      expect(instances).toHaveLength(0);
    });

    it("hands out distinct handles for successive notifications", () => {
      const first = boundary.show({ title: "a", body: "1" });
      const second = boundary.show({ title: "b", body: "2" });

      expect(first?.id).not.toBe(second?.id);
    });
  });

  describe("click", () => {
    it("invokes onClick when Electron reports a click", () => {
      const onClick = vi.fn();
      boundary.show({ title: "t", body: "b", onClick });

      instances[0]?.emit("click");

      expect(onClick).toHaveBeenCalledOnce();
    });

    it("registers no click handler when none is supplied", () => {
      boundary.show({ title: "t", body: "b" });

      expect(instances[0]?.handlers.has("click")).toBe(false);
    });

    it("does not close a clicked notification again on closeAll", () => {
      boundary.show({ title: "t", body: "b", onClick: vi.fn() });
      instances[0]?.emit("click");

      boundary.closeAll();

      // The OS already dismissed it on activation; closing it again would be a
      // call into a retired notification.
      expect(instances[0]?.close).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("closes the notification behind a handle", () => {
      const handle = boundary.show({ title: "t", body: "b" });

      boundary.close(handle!);

      expect(instances[0]?.close).toHaveBeenCalledOnce();
    });

    it("is a no-op for an already-closed handle", () => {
      const handle = boundary.show({ title: "t", body: "b" });
      boundary.close(handle!);

      boundary.close(handle!);

      expect(instances[0]?.close).toHaveBeenCalledOnce();
    });

    it("is a no-op for a handle this boundary never issued", () => {
      expect(() =>
        boundary.close({ id: "os-notification-999", __brand: "OsNotificationHandle" })
      ).not.toThrow();
    });
  });

  describe("closeAll", () => {
    it("closes every outstanding notification", () => {
      boundary.show({ title: "a", body: "1" });
      boundary.show({ title: "b", body: "2" });

      boundary.closeAll();

      expect(instances[0]?.close).toHaveBeenCalledOnce();
      expect(instances[1]?.close).toHaveBeenCalledOnce();
    });

    it("skips notifications the OS already dismissed", () => {
      boundary.show({ title: "a", body: "1" });
      boundary.show({ title: "b", body: "2" });
      // Electron reports "close" when the user dismisses it themselves.
      instances[0]?.emit("close");

      boundary.closeAll();

      expect(instances[0]?.close).not.toHaveBeenCalled();
      expect(instances[1]?.close).toHaveBeenCalledOnce();
    });

    it("drops failed notifications so they are not retried", () => {
      boundary.show({ title: "a", body: "1" });
      instances[0]?.emit("failed");

      boundary.closeAll();

      expect(instances[0]?.close).not.toHaveBeenCalled();
    });

    it("is idempotent", () => {
      boundary.show({ title: "a", body: "1" });

      boundary.closeAll();
      boundary.closeAll();

      expect(instances[0]?.close).toHaveBeenCalledOnce();
    });
  });

  describe("isSupported", () => {
    it("reflects Electron's answer", () => {
      expect(boundary.isSupported()).toBe(true);

      isSupported.mockReturnValue(false);

      expect(boundary.isSupported()).toBe(false);
    });
  });
});
