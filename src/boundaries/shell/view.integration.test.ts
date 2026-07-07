/**
 * Integration tests for ViewBoundary using behavioral mock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createViewBoundaryMock, type MockViewBoundary } from "./view.state-mock";
import { ShellError, isShellErrorWithCode } from "../../shared/errors/shell-errors";

const windowHandle = { id: "window-1", __brand: "WindowHandle" as const };

describe("ViewBoundary (integration)", () => {
  let viewLayer: MockViewBoundary;

  beforeEach(() => {
    viewLayer = createViewBoundaryMock();
  });

  describe("adoptWindowWebContents", () => {
    it("adopts a window's webContents as a view", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      expect(handle.id).toMatch(/^view-\d+$/);
      expect(handle.__brand).toBe("ViewHandle");
      expect(viewLayer).toHaveView(handle.id, { attachedTo: "window-1" });
    });

    it("creates multiple views with unique IDs", () => {
      const handle1 = viewLayer.adoptWindowWebContents(windowHandle);
      const handle2 = viewLayer.adoptWindowWebContents(windowHandle);

      expect(handle1.id).not.toBe(handle2.id);
      expect(viewLayer).toHaveViews([handle1.id, handle2.id]);
    });
  });

  describe("destroy", () => {
    it("destroys an existing view", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      viewLayer.destroy(handle);

      expect(viewLayer).not.toHaveView(handle.id);
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => viewLayer.destroy(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.destroy(fakeHandle)).toThrow("View view-999 not found");
    });

    it("throws VIEW_NOT_FOUND for already destroyed view", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);
      viewLayer.destroy(handle);

      expect(() => viewLayer.destroy(handle)).toThrow(ShellError);
    });
  });

  describe("destroyAll", () => {
    it("destroys all views", () => {
      viewLayer.adoptWindowWebContents(windowHandle);
      viewLayer.adoptWindowWebContents(windowHandle);
      viewLayer.adoptWindowWebContents(windowHandle);

      viewLayer.destroyAll();

      expect(viewLayer).toHaveViews([]);
    });
  });

  describe("loadURL", () => {
    it("sets the URL on the view", async () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      await viewLayer.loadURL(handle, "http://127.0.0.1:8080");

      expect(viewLayer).toHaveView(handle.id, { url: "http://127.0.0.1:8080" });
    });

    it("throws VIEW_NOT_FOUND for non-existent view", async () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      await expect(viewLayer.loadURL(fakeHandle, "http://test.com")).rejects.toThrow(ShellError);
    });
  });

  describe("focus", () => {
    it("does not throw for valid view", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      expect(() => viewLayer.focus(handle)).not.toThrow();
    });

    it("throws VIEW_NOT_FOUND for non-existent view", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      expect(() => viewLayer.focus(fakeHandle)).toThrow(ShellError);
    });
  });

  describe("setWindowOpenHandler", () => {
    it("tracks handler state when set", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      viewLayer.setWindowOpenHandler(handle, () => ({ action: "deny" }));

      expect(viewLayer).toHaveView(handle.id, { hasWindowOpenHandler: true });
    });

    it("tracks handler state when cleared", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      viewLayer.setWindowOpenHandler(handle, () => ({ action: "deny" }));
      viewLayer.setWindowOpenHandler(handle, null);

      expect(viewLayer).toHaveView(handle.id, { hasWindowOpenHandler: false });
    });
  });

  describe("executeJavaScript", () => {
    it("resolves for valid view", async () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

      await expect(viewLayer.executeJavaScript(handle, "1 + 1")).resolves.toBeUndefined();
    });

    it("throws VIEW_NOT_FOUND for non-existent view", async () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      await expect(viewLayer.executeJavaScript(fakeHandle, "1")).rejects.toThrow(ShellError);
    });
  });

  describe("send", () => {
    it("does not throw for valid view", () => {
      const handle = viewLayer.adoptWindowWebContents(windowHandle);

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
      viewLayer.adoptWindowWebContents(windowHandle);
      viewLayer.adoptWindowWebContents(windowHandle);

      await viewLayer.dispose();

      expect(viewLayer).toHaveViews([]);
    });
  });

  describe("error handling consistency", () => {
    it("all methods throw VIEW_NOT_FOUND for invalid handle", () => {
      const fakeHandle = { id: "view-999", __brand: "ViewHandle" as const };

      // Sync methods
      expect(() => viewLayer.destroy(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.focus(fakeHandle)).toThrow(ShellError);
      expect(() => viewLayer.setWindowOpenHandler(fakeHandle, null)).toThrow(ShellError);
      expect(() => viewLayer.send(fakeHandle, "channel", {})).toThrow(ShellError);

      // Verify error code
      try {
        viewLayer.destroy(fakeHandle);
      } catch (error) {
        expect(isShellErrorWithCode(error, "VIEW_NOT_FOUND")).toBe(true);
      }
    });
  });
});
