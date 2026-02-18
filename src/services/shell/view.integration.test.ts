/**
 * Integration tests for ViewLayer using behavioral mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createViewLayerMock, type MockViewLayer } from "./view.state-mock";
import { ShellError, isShellErrorWithCode } from "./errors";

describe("ViewLayer (integration)", () => {
  let viewLayer: MockViewLayer;

  beforeEach(() => {
    viewLayer = createViewLayerMock();
  });

  describe("createView", () => {
    it("creates a view with default options", () => {
      const handle = viewLayer.createView({});

      expect(handle.id).toMatch(/^view-\d+$/);
      expect(handle.__brand).toBe("ViewHandle");
      expect(viewLayer).toHaveView(handle.id);
    });

    it("creates a view with background color", () => {
      const handle = viewLayer.createView({ backgroundColor: "#ff0000" });

      expect(viewLayer).toHaveView(handle.id, { backgroundColor: "#ff0000" });
    });

    it("creates multiple views with unique IDs", () => {
      const handle1 = viewLayer.createView({});
      const handle2 = viewLayer.createView({});

      expect(handle1.id).not.toBe(handle2.id);
      expect(viewLayer).toHaveViews([handle1.id, handle2.id]);
    });
  });

  describe("destroy", () => {
    it("destroys an existing view", () => {
      const handle = viewLayer.createView({});

      viewLayer.destroy(handle);

      expect(viewLayer).not.toHaveView(handle.id);
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => viewLayer.destroy(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.destroy(fakeHandle)).toThrow("View view-999 not found");
    });

    it("throws VIEW_NOT_FOUND for already destroyed view", () => {
      const handle = viewLayer.createView({});
      viewLayer.destroy(handle);

      expect(() => viewLayer.destroy(handle)).toThrow(ShellError);
    });
  });

  describe("destroyAll", () => {
    it("destroys all views", () => {
      viewLayer.createView({});
      viewLayer.createView({});
      viewLayer.createView({});

      viewLayer.destroyAll();

      expect(viewLayer).toHaveViews([]);
    });
  });

  describe("loadURL", () => {
    it("sets the URL on the view", async () => {
      const handle = viewLayer.createView({});

      await viewLayer.loadURL(handle, "http://127.0.0.1:8080");

      expect(viewLayer.getURL(handle)).toBe("http://127.0.0.1:8080");
    });

    it("throws VIEW_NOT_FOUND for non-existent view", async () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      await expect(viewLayer.loadURL(fakeHandle, "http://test.com")).rejects.toThrow(ShellError);
    });
  });

  describe("getURL", () => {
    it("returns empty string for view with no URL loaded", () => {
      const handle = viewLayer.createView({});

      expect(viewLayer.getURL(handle)).toBe("");
    });

    it("returns the loaded URL", async () => {
      const handle = viewLayer.createView({});
      await viewLayer.loadURL(handle, "http://127.0.0.1:3000");

      expect(viewLayer.getURL(handle)).toBe("http://127.0.0.1:3000");
    });
  });

  describe("bounds", () => {
    it("sets and gets bounds", () => {
      const handle = viewLayer.createView({});
      const bounds = { x: 10, y: 20, width: 800, height: 600 };

      viewLayer.setBounds(handle, bounds);

      expect(viewLayer.getBounds(handle)).toEqual(bounds);
    });

    it("returns zero bounds for view with no bounds set", () => {
      const handle = viewLayer.createView({});

      expect(viewLayer.getBounds(handle)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => viewLayer.getBounds(fakeHandle)).toThrow(ShellError);
    });
  });

  describe("setBackgroundColor", () => {
    it("sets background color", () => {
      const handle = viewLayer.createView({});

      viewLayer.setBackgroundColor(handle, "#00ff00");

      expect(viewLayer).toHaveView(handle.id, { backgroundColor: "#00ff00" });
    });
  });

  describe("focus", () => {
    it("does not throw for valid view", () => {
      const handle = viewLayer.createView({});

      expect(() => viewLayer.focus(handle)).not.toThrow();
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => viewLayer.focus(fakeHandle)).toThrow(ShellError);
    });
  });

  describe("attachToWindow / detachFromWindow", () => {
    it("attaches view to window", () => {
      const handle = viewLayer.createView({});
      const windowHandle = { id: "window-1", __brand: "WindowHandle" as const };

      viewLayer.attachToWindow(handle, windowHandle);

      expect(viewLayer).toHaveView(handle.id, { attachedTo: "window-1" });
    });

    it("detaches view from window", () => {
      const handle = viewLayer.createView({});
      const windowHandle = { id: "window-1", __brand: "WindowHandle" as const };

      viewLayer.attachToWindow(handle, windowHandle);
      viewLayer.detachFromWindow(handle);

      expect(viewLayer).toHaveView(handle.id, { attachedTo: null });
    });

    it("attach is idempotent", () => {
      const handle = viewLayer.createView({});
      const windowHandle = { id: "window-1", __brand: "WindowHandle" as const };

      viewLayer.attachToWindow(handle, windowHandle);
      viewLayer.attachToWindow(handle, windowHandle);

      expect(viewLayer).toHaveView(handle.id, { attachedTo: "window-1" });
    });

    it("force re-attaches view already at correct index", () => {
      const handle1 = viewLayer.createView({});
      const handle2 = viewLayer.createView({});
      const windowHandle = { id: "window-1", __brand: "WindowHandle" as const };

      // Attach handle1 at index 0, handle2 on top
      viewLayer.attachToWindow(handle1, windowHandle, 0);
      viewLayer.attachToWindow(handle2, windowHandle);

      // Force re-attach handle1 at index 0 (triggers remove+add cycle)
      viewLayer.attachToWindow(handle1, windowHandle, 0, { force: true });

      // handle1 should still be at index 0 and attached
      expect(viewLayer).toHaveView(handle1.id, { attachedTo: "window-1" });
      expect(viewLayer).toHaveView(handle2.id, { attachedTo: "window-1" });
    });

    it("detach is idempotent", () => {
      const handle = viewLayer.createView({});

      // Not attached - should be no-op
      viewLayer.detachFromWindow(handle);

      expect(viewLayer).toHaveView(handle.id, { attachedTo: null });
    });
  });

  describe("onDidFinishLoad", () => {
    it("registers callback", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn();

      viewLayer.onDidFinishLoad(handle, callback);
      viewLayer.$.triggerDidFinishLoad(handle);

      expect(callback).toHaveBeenCalled();
    });

    it("unsubscribes from callback", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn();

      const unsubscribe = viewLayer.onDidFinishLoad(handle, callback);
      unsubscribe();
      viewLayer.$.triggerDidFinishLoad(handle);

      expect(callback).not.toHaveBeenCalled();
    });

    it("supports multiple callbacks", () => {
      const handle = viewLayer.createView({});
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      viewLayer.onDidFinishLoad(handle, callback1);
      viewLayer.onDidFinishLoad(handle, callback2);
      viewLayer.$.triggerDidFinishLoad(handle);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("onDomReady", () => {
    it("registers callback", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn();

      viewLayer.onDomReady(handle, callback);
      viewLayer.$.triggerDomReady(handle);

      expect(callback).toHaveBeenCalled();
    });

    it("unsubscribes from callback", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn();

      const unsubscribe = viewLayer.onDomReady(handle, callback);
      unsubscribe();
      viewLayer.$.triggerDomReady(handle);

      expect(callback).not.toHaveBeenCalled();
    });

    it("supports multiple callbacks", () => {
      const handle = viewLayer.createView({});
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      viewLayer.onDomReady(handle, callback1);
      viewLayer.onDomReady(handle, callback2);
      viewLayer.$.triggerDomReady(handle);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("onWillNavigate", () => {
    it("registers callback with URL", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn().mockReturnValue(true);

      viewLayer.onWillNavigate(handle, callback);
      viewLayer.$.triggerWillNavigate(handle, "http://test.com");

      expect(callback).toHaveBeenCalledWith("http://test.com");
    });

    it("unsubscribes from callback", () => {
      const handle = viewLayer.createView({});
      const callback = vi.fn().mockReturnValue(true);

      const unsubscribe = viewLayer.onWillNavigate(handle, callback);
      unsubscribe();
      viewLayer.$.triggerWillNavigate(handle, "http://test.com");

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("setWindowOpenHandler", () => {
    it("tracks handler state when set", () => {
      const handle = viewLayer.createView({});

      viewLayer.setWindowOpenHandler(handle, () => ({ action: "deny" }));

      expect(viewLayer).toHaveView(handle.id, { hasWindowOpenHandler: true });
    });

    it("tracks handler state when cleared", () => {
      const handle = viewLayer.createView({});

      viewLayer.setWindowOpenHandler(handle, () => ({ action: "deny" }));
      viewLayer.setWindowOpenHandler(handle, null);

      expect(viewLayer).toHaveView(handle.id, { hasWindowOpenHandler: false });
    });
  });

  describe("executeJavaScript", () => {
    it("resolves for valid view", async () => {
      const handle = viewLayer.createView({});

      await expect(viewLayer.executeJavaScript(handle, "1 + 1")).resolves.toBeUndefined();
    });

    it("throws VIEW_NOT_FOUND for non-existent view", async () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      await expect(viewLayer.executeJavaScript(fakeHandle, "1")).rejects.toThrow(ShellError);
    });
  });

  describe("send", () => {
    it("does not throw for valid view", () => {
      const handle = viewLayer.createView({});

      expect(() => {
        viewLayer.send(handle, "test-channel", { data: "test" });
      }).not.toThrow();
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => {
        viewLayer.send(fakeHandle, "test-channel", {});
      }).toThrow(ShellError);
    });
  });

  describe("dispose", () => {
    it("clears all views", async () => {
      viewLayer.createView({});
      viewLayer.createView({});

      await viewLayer.dispose();

      expect(viewLayer).toHaveViews([]);
    });
  });

  describe("error handling consistency", () => {
    it("all methods throw VIEW_NOT_FOUND for invalid handle", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      // Sync methods
      expect(() => viewLayer.destroy(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.getURL(fakeHandle)).toThrow(ShellError);
      expect(() =>
        viewLayer.setBounds(fakeHandle, { x: 0, y: 0, width: 100, height: 100 })
      ).toThrow(ShellError);
      expect(() => viewLayer.getBounds(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.setBackgroundColor(fakeHandle, "#fff")).toThrow(ShellError);
      expect(() => viewLayer.focus(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.onDidFinishLoad(fakeHandle, () => {})).toThrow(ShellError);
      expect(() => viewLayer.onWillNavigate(fakeHandle, () => true)).toThrow(ShellError);
      expect(() => viewLayer.setWindowOpenHandler(fakeHandle, null)).toThrow(ShellError);
      expect(() => viewLayer.send(fakeHandle, "channel", {})).toThrow(ShellError);

      // Verify error code
      try {
        viewLayer.getURL(fakeHandle);
      } catch (error) {
        expect(isShellErrorWithCode(error, "VIEW_NOT_FOUND")).toBe(true);
      }
    });
  });
});
