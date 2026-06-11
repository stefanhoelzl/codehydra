/**
 * Integration tests for WindowBoundary using behavioral mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createWindowBoundaryMock, type MockWindowBoundary } from "./window.state-mock";
import { ShellError } from "../../shared/errors/shell-errors";

describe("WindowBoundary (integration)", () => {
  let windowLayer: MockWindowBoundary;

  beforeEach(() => {
    windowLayer = createWindowBoundaryMock();
  });

  describe("createWindow", () => {
    it("creates a window with default options", () => {
      const handle = windowLayer.createWindow({});

      expect(handle.id).toMatch(/^window-\d+$/);
      expect(handle.__brand).toBe("WindowHandle");

      expect(windowLayer).toHaveWindow(handle.id);
    });

    it("creates a window with custom dimensions", () => {
      const handle = windowLayer.createWindow({
        width: 1200,
        height: 800,
        minWidth: 400,
        minHeight: 300,
      });

      expect(windowLayer).toHaveWindowBounds(handle.id, { width: 1200, height: 800 });
    });

    it("creates a window with title", () => {
      const handle = windowLayer.createWindow({ title: "Test Window" });

      expect(windowLayer).toHaveWindowTitle(handle.id, "Test Window");
    });

    it("creates multiple windows with unique IDs", () => {
      const handle1 = windowLayer.createWindow({});
      const handle2 = windowLayer.createWindow({});

      expect(handle1.id).not.toBe(handle2.id);

      expect(windowLayer).toHaveWindowCount(2);
    });
  });

  describe("bounds", () => {
    it("gets content bounds", () => {
      const handle = windowLayer.createWindow({ width: 1024, height: 768 });

      const bounds = windowLayer.getContentBounds(handle);

      expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    });

    it("throws for non-existent window", () => {
      const fakeHandle = { id: "window-999", __brand: "WindowHandle" as const };

      expect(() => windowLayer.getContentBounds(fakeHandle)).toThrow(ShellError);
    });
  });

  describe("maximize", () => {
    it("maximizes a window", () => {
      const handle = windowLayer.createWindow({});

      expect(windowLayer).not.toBeWindowMaximized(handle.id);
      windowLayer.maximize(handle);
      expect(windowLayer).toBeWindowMaximized(handle.id);
    });
  });

  describe("setTitle", () => {
    it("sets the window title", () => {
      const handle = windowLayer.createWindow({ title: "Original" });

      windowLayer.setTitle(handle, "Updated Title");

      expect(windowLayer).toHaveWindowTitle(handle.id, "Updated Title");
    });
  });

  describe("close events", () => {
    it("triggers close callbacks", () => {
      const handle = windowLayer.createWindow({});
      const callback = vi.fn();
      windowLayer.onClose(handle, callback);

      windowLayer.$.triggerClose(handle);

      expect(callback).toHaveBeenCalled();
    });
  });

  describe("resize events", () => {
    it("subscribes to resize events", () => {
      const handle = windowLayer.createWindow({});
      const callback = vi.fn();

      windowLayer.onResize(handle, callback);
      windowLayer.$.triggerResize(handle);

      expect(callback).toHaveBeenCalled();
    });

    it("unsubscribes from resize events", () => {
      const handle = windowLayer.createWindow({});
      const callback = vi.fn();

      const unsubscribe = windowLayer.onResize(handle, callback);
      unsubscribe();
      windowLayer.$.triggerResize(handle);

      expect(callback).not.toHaveBeenCalled();
    });

    it("supports multiple callbacks", () => {
      const handle = windowLayer.createWindow({});
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      windowLayer.onResize(handle, callback1);
      windowLayer.onResize(handle, callback2);
      windowLayer.$.triggerResize(handle);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("maximize/unmaximize events", () => {
    it("triggers maximize callback and updates state", () => {
      const handle = windowLayer.createWindow({});
      const callback = vi.fn();

      windowLayer.onMaximize(handle, callback);
      windowLayer.$.triggerMaximize(handle);

      expect(callback).toHaveBeenCalled();
      expect(windowLayer).toBeWindowMaximized(handle.id);
    });

    it("triggers unmaximize callback and updates state", () => {
      const handle = windowLayer.createWindow({});
      windowLayer.maximize(handle);
      const callback = vi.fn();

      windowLayer.onUnmaximize(handle, callback);
      windowLayer.$.triggerUnmaximize(handle);

      expect(callback).toHaveBeenCalled();
      expect(windowLayer).not.toBeWindowMaximized(handle.id);
    });
  });

  describe("getContentView", () => {
    it("returns a content view", () => {
      const handle = windowLayer.createWindow({});

      const contentView = windowLayer.getContentView(handle);

      expect(contentView).toBeDefined();
      expect(typeof contentView.addChildView).toBe("function");
      expect(typeof contentView.removeChildView).toBe("function");
    });

    it("allows adding child views", () => {
      const handle = windowLayer.createWindow({});
      const contentView = windowLayer.getContentView(handle);
      const fakeView = { id: "fake-view" };

      contentView.addChildView(fakeView);

      expect(contentView.children).toContain(fakeView);
    });

    it("allows removing child views", () => {
      const handle = windowLayer.createWindow({});
      const contentView = windowLayer.getContentView(handle);
      const fakeView = { id: "fake-view" };

      contentView.addChildView(fakeView);
      contentView.removeChildView(fakeView);

      expect(contentView.children).not.toContain(fakeView);
    });
  });

  describe("isDestroyed", () => {
    it("returns false for existing window", () => {
      const handle = windowLayer.createWindow({});

      expect(windowLayer.isDestroyed(handle)).toBe(false);
    });

    it("returns true for non-existent window", () => {
      const fakeHandle = { id: "window-999", __brand: "WindowHandle" as const };

      expect(windowLayer.isDestroyed(fakeHandle)).toBe(true);
    });
  });

  describe("setOverlayIcon", () => {
    it("does not throw for valid window", () => {
      const handle = windowLayer.createWindow({});
      const imageHandle = { id: "image-1", __brand: "ImageHandle" as const };

      expect(() => {
        windowLayer.setOverlayIcon(handle, imageHandle, "Test overlay");
      }).not.toThrow();
    });

    it("accepts null to clear overlay", () => {
      const handle = windowLayer.createWindow({});

      expect(() => {
        windowLayer.setOverlayIcon(handle, null, "");
      }).not.toThrow();
    });
  });
});
