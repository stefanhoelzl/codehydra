/**
 * Integration tests for WindowLayer using behavioral mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createWindowLayerMock, type MockWindowLayer } from "./window.state-mock";
import { ShellError, isShellErrorWithCode } from "./errors";

describe("WindowLayer (integration)", () => {
  let windowLayer: MockWindowLayer;

  beforeEach(() => {
    windowLayer = createWindowLayerMock();
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

      const bounds = windowLayer.getBounds(handle);
      expect(bounds.width).toBe(1200);
      expect(bounds.height).toBe(800);
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

  describe("destroy", () => {
    it("destroys an existing window", () => {
      const handle = windowLayer.createWindow({});
      windowLayer.destroy(handle);

      expect(windowLayer.isDestroyed(handle)).toBe(true);
      expect(windowLayer).toHaveWindowCount(0);
    });

    it("throws WINDOW_NOT_FOUND for non-existent window", () => {
      const fakeHandle = { id: "window-999", __brand: "WindowHandle" as const };

      expect(() => windowLayer.destroy(fakeHandle)).toThrow(ShellError);
      expect(() => windowLayer.destroy(fakeHandle)).toThrow("Window window-999 not found");
    });

    it("throws WINDOW_HAS_ATTACHED_VIEWS when views are attached", () => {
      const handle = windowLayer.createWindow({});
      const viewHandle = { id: "view-1", __brand: "ViewHandle" as const };
      windowLayer.trackAttachedView(handle, viewHandle);

      expect(() => windowLayer.destroy(handle)).toThrow(ShellError);
      try {
        windowLayer.destroy(handle);
      } catch (error) {
        expect(isShellErrorWithCode(error, "WINDOW_HAS_ATTACHED_VIEWS")).toBe(true);
      }
    });

    it("succeeds after views are untracked", () => {
      const handle = windowLayer.createWindow({});
      const viewHandle = { id: "view-1", __brand: "ViewHandle" as const };
      windowLayer.trackAttachedView(handle, viewHandle);
      windowLayer.untrackAttachedView(handle, viewHandle);

      expect(() => windowLayer.destroy(handle)).not.toThrow();
    });
  });

  describe("destroyAll", () => {
    it("destroys all windows", () => {
      windowLayer.createWindow({});
      windowLayer.createWindow({});
      windowLayer.createWindow({});

      windowLayer.destroyAll();

      expect(windowLayer).toHaveWindowCount(0);
    });

    it("throws when any window has attached views", () => {
      const handle1 = windowLayer.createWindow({});
      const handle2 = windowLayer.createWindow({});
      const viewHandle = { id: "view-1", __brand: "ViewHandle" as const };
      windowLayer.trackAttachedView(handle2, viewHandle);

      expect(() => windowLayer.destroyAll()).toThrow(ShellError);

      // Windows should still exist
      expect(windowLayer).toHaveWindow(handle1.id);
      expect(windowLayer).toHaveWindow(handle2.id);
    });
  });

  describe("bounds", () => {
    it("gets window bounds", () => {
      const handle = windowLayer.createWindow({ width: 1024, height: 768 });

      const bounds = windowLayer.getBounds(handle);

      expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    });

    it("gets content bounds", () => {
      const handle = windowLayer.createWindow({ width: 1024, height: 768 });

      const bounds = windowLayer.getContentBounds(handle);

      expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    });

    it("sets window bounds", () => {
      const handle = windowLayer.createWindow({});
      const newBounds = { x: 100, y: 50, width: 800, height: 600 };

      windowLayer.setBounds(handle, newBounds);

      expect(windowLayer.getBounds(handle)).toEqual(newBounds);
    });

    it("throws for non-existent window", () => {
      const fakeHandle = { id: "window-999", __brand: "WindowHandle" as const };

      expect(() => windowLayer.getBounds(fakeHandle)).toThrow(ShellError);
    });
  });

  describe("maximize", () => {
    it("maximizes a window", () => {
      const handle = windowLayer.createWindow({});

      expect(windowLayer.isMaximized(handle)).toBe(false);
      windowLayer.maximize(handle);
      expect(windowLayer.isMaximized(handle)).toBe(true);
    });
  });

  describe("setTitle", () => {
    it("sets the window title", () => {
      const handle = windowLayer.createWindow({ title: "Original" });

      windowLayer.setTitle(handle, "Updated Title");

      expect(windowLayer).toHaveWindowTitle(handle.id, "Updated Title");
    });
  });

  describe("close", () => {
    it("marks window as destroyed", () => {
      const handle = windowLayer.createWindow({});

      windowLayer.close(handle);

      expect(windowLayer.isDestroyed(handle)).toBe(true);
    });

    it("triggers close callbacks before destroying", () => {
      const handle = windowLayer.createWindow({});
      const callback = vi.fn();
      windowLayer.onClose(handle, callback);

      windowLayer.close(handle);

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
      expect(windowLayer.isMaximized(handle)).toBe(true);
    });

    it("triggers unmaximize callback and updates state", () => {
      const handle = windowLayer.createWindow({});
      windowLayer.maximize(handle);
      const callback = vi.fn();

      windowLayer.onUnmaximize(handle, callback);
      windowLayer.$.triggerUnmaximize(handle);

      expect(callback).toHaveBeenCalled();
      expect(windowLayer.isMaximized(handle)).toBe(false);
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

  describe("view tracking", () => {
    it("tracks attached views", () => {
      const handle = windowLayer.createWindow({});
      const viewHandle = { id: "view-1", __brand: "ViewHandle" as const };

      windowLayer.trackAttachedView(handle, viewHandle);

      expect(windowLayer).toHaveAttachedView(handle.id, "view-1");
    });

    it("untracks detached views", () => {
      const handle = windowLayer.createWindow({});
      const viewHandle = { id: "view-1", __brand: "ViewHandle" as const };

      windowLayer.trackAttachedView(handle, viewHandle);
      windowLayer.untrackAttachedView(handle, viewHandle);

      expect(windowLayer).toHaveAttachedViewCount(handle.id, 0);
    });
  });

  describe("isDestroyed", () => {
    it("returns false for existing window", () => {
      const handle = windowLayer.createWindow({});

      expect(windowLayer.isDestroyed(handle)).toBe(false);
    });

    it("returns true for destroyed window", () => {
      const handle = windowLayer.createWindow({});
      windowLayer.destroy(handle);

      expect(windowLayer.isDestroyed(handle)).toBe(true);
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
