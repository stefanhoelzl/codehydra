// @vitest-environment node
/**
 * Integration tests for UiViewManager with behavioral boundary mocks.
 *
 * Covers: UI webContents adoption (the window's own page, window-open
 * handler), session handler wiring, mode state + change notifications,
 * mode-routed focus, renderer-hook-driven capture, and destroy.
 */

import { describe, it, expect, vi } from "vitest";
import { UiViewManager, type UiViewManagerDeps } from "./ui-view-manager";
import { createViewBoundaryMock } from "./view.state-mock";
import { createSessionBoundaryMock } from "./session.state-mock";
import { createMockWindowManager } from "./window-manager.test-utils";
import type { WindowBoundary } from "./window";
import type { WindowManager } from "./window-manager";
import type { AppBoundary } from "./app";

function createDeps() {
  const viewLayer = createViewBoundaryMock();
  const sessionLayer = createSessionBoundaryMock();
  const windowManager = createMockWindowManager();
  const windowLayer = {
    isDestroyed: vi.fn(() => false),
  } as unknown as WindowBoundary;
  const appLayer: Pick<AppBoundary, "openUrl"> = {
    openUrl: vi.fn().mockResolvedValue(undefined),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    silly: vi.fn(),
  };

  const deps = {
    windowManager: windowManager as unknown as WindowManager,
    windowLayer,
    viewLayer,
    sessionLayer,
    appLayer,
    logger,
  } as unknown as UiViewManagerDeps;

  return { deps, viewLayer, sessionLayer, windowManager, appLayer, logger };
}

function createManager() {
  const ctx = createDeps();
  const manager = new UiViewManager(ctx.deps);
  manager.create();
  return { manager, ...ctx };
}

describe("UiViewManager", () => {
  describe("create", () => {
    it("adopts the window's own webContents (no child view to size) and wires the window-open handler", () => {
      const { manager, viewLayer } = createManager();

      const handle = manager.getUIViewHandle();
      const snapshot = viewLayer.$.getViewSnapshot(handle.id);
      // The UI is the window's own page — it auto-fills the window, so there is
      // no bounds/backdrop on the adopted handle; it is associated with the
      // window it adopted.
      expect(snapshot).toMatchObject({
        attachedTo: "test-window-1",
        bounds: null,
        backgroundColor: null,
        hasWindowOpenHandler: true,
      });
    });

    it("wires header + permission handlers on the shared session", () => {
      const { sessionLayer } = createManager();

      const sessions = [...sessionLayer.$.sessions.values()];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        partition: "persist:codehydra-global",
        hasHeadersReceivedHandler: true,
        hasPermissionRequestHandler: true,
        hasPermissionCheckHandler: true,
      });
    });

    it("is idempotent", () => {
      const { manager } = createManager();
      const handle = manager.getUIViewHandle();
      manager.create();
      expect(manager.getUIViewHandle()).toBe(handle);
    });

    it("throws when accessed before create()", () => {
      const { deps } = createDeps();
      const manager = new UiViewManager(deps);
      expect(() => manager.getUIViewHandle()).toThrow("create() has not been called");
    });
  });

  // Note: the UI view no longer tracks window resize or theme by re-sizing /
  // re-coloring a child view — the window's own page auto-fills the window and
  // the renderer paints its own background. See view-module for maximize.

  describe("focus routing", () => {
    it("focuses the view and asks the renderer to focus the active frame", () => {
      const { manager, viewLayer } = createManager();
      const exec = vi.spyOn(viewLayer, "executeJavaScript");

      manager.focus();

      expect(viewLayer.$.getViewSnapshot(manager.getUIViewHandle().id)?.focused).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        manager.getUIViewHandle(),
        expect.stringContaining("__chFocusActiveFrame")
      );
    });
  });

  describe("reloadFrames", () => {
    it("asks the renderer to reload its workspace frames", () => {
      const { manager, viewLayer } = createManager();
      const exec = vi.spyOn(viewLayer, "executeJavaScript");

      manager.reloadFrames();

      expect(exec).toHaveBeenCalledWith(
        manager.getUIViewHandle(),
        expect.stringContaining("__chReloadFrames")
      );
    });

    it("swallows a rejected executeJavaScript (UI mid-load)", async () => {
      const { manager, viewLayer } = createManager();
      vi.spyOn(viewLayer, "executeJavaScript").mockRejectedValue(new Error("page gone"));

      expect(() => manager.reloadFrames()).not.toThrow();
      // Let the rejected promise settle without an unhandled rejection
      await Promise.resolve();
    });
  });

  describe("captureActiveWorkspaceView", () => {
    it("clips the capture to the active frame rect reported by the renderer", async () => {
      const { manager, viewLayer } = createManager();
      const rect = { x: 20, y: 0, width: 1180, height: 800 };
      vi.spyOn(viewLayer, "executeJavaScript").mockResolvedValue(rect);
      const capture = vi.spyOn(viewLayer, "capturePNG");

      const png = await manager.captureActiveWorkspaceView();

      expect(png).not.toBeNull();
      expect(capture).toHaveBeenCalledWith(manager.getUIViewHandle(), rect);
    });

    it("returns null when no active frame is visible", async () => {
      const { manager, viewLayer } = createManager();
      vi.spyOn(viewLayer, "executeJavaScript").mockResolvedValue(null);

      expect(await manager.captureActiveWorkspaceView()).toBeNull();
    });

    it("returns null when the rect lookup throws", async () => {
      const { manager, viewLayer } = createManager();
      vi.spyOn(viewLayer, "executeJavaScript").mockRejectedValue(new Error("page gone"));

      expect(await manager.captureActiveWorkspaceView()).toBeNull();
    });
  });

  describe("capability targets", () => {
    it("devtools target toggles devtools on the UI view", () => {
      const { manager } = createManager();
      const target = manager.getUIDevtoolsTarget();

      expect(target.id).toBe(manager.getUIViewHandle().id);
      expect(target.isOpen()).toBe(false);
      target.toggle();
      expect(target.isOpen()).toBe(true);
      target.toggle();
      expect(target.isOpen()).toBe(false);
    });

    it("keyboard target subscribes to before-input on the UI view", () => {
      const { manager, viewLayer } = createManager();
      const target = manager.getUIKeyboardTarget();
      const callback = vi.fn();
      target.onBeforeInput(callback);

      viewLayer.$.triggerBeforeInputEvent(manager.getUIViewHandle(), {
        type: "keyDown",
        key: "Alt",
        isAutoRepeat: false,
        control: false,
        shift: false,
        alt: true,
        meta: false,
      });

      expect(callback).toHaveBeenCalled();
    });
  });

  describe("sendToUI", () => {
    it("drops sends before create() without throwing", () => {
      const { deps } = createDeps();
      const manager = new UiViewManager(deps);
      expect(() => manager.sendToUI("api:test", 1)).not.toThrow();
    });
  });

  describe("onFromUI", () => {
    it("buffers subscriptions made before create() and delivers once wired", () => {
      const { deps, viewLayer } = createDeps();
      const manager = new UiViewManager(deps);
      const received: unknown[] = [];

      // Subscribe before the view exists.
      manager.onFromUI("api:ui:event", (payload) => received.push(payload));

      manager.create();
      const handle = manager.getUIViewHandle();
      viewLayer.$.triggerIpc(handle, "api:ui:event", { kind: "ui-connected" });

      expect(received).toEqual([{ kind: "ui-connected" }]);
    });

    it("delivers the message arguments (Electron event swallowed)", () => {
      const { manager, viewLayer } = createManager();
      const received: unknown[][] = [];
      manager.onFromUI("api:ui:event", (...args) => received.push(args));

      const handle = manager.getUIViewHandle();
      viewLayer.$.triggerIpc(handle, "api:ui:event", { kind: "hover", region: null });

      expect(received).toEqual([[{ kind: "hover", region: null }]]);
    });

    it("stops delivering after unsubscribe", () => {
      const { manager, viewLayer } = createManager();
      const received: unknown[] = [];
      const unsubscribe = manager.onFromUI("api:ui:event", (p) => received.push(p));
      const handle = manager.getUIViewHandle();

      unsubscribe();
      viewLayer.$.triggerIpc(handle, "api:ui:event", { kind: "ui-connected" });

      expect(received).toEqual([]);
    });

    it("re-wires the listener onto the new view after a recreate", () => {
      const { deps, viewLayer } = createDeps();
      const manager = new UiViewManager(deps);
      const received: unknown[] = [];
      manager.onFromUI("api:ui:event", (p) => received.push(p));

      manager.create();
      manager.destroy();
      manager.create();

      const handle = manager.getUIViewHandle();
      viewLayer.$.triggerIpc(handle, "api:ui:event", { kind: "ui-connected" });

      expect(received).toEqual([{ kind: "ui-connected" }]);
    });
  });

  describe("destroy", () => {
    it("destroys the UI view and is idempotent", () => {
      const { manager } = createManager();
      manager.destroy();
      expect(manager.isUIAvailable()).toBe(false);
      expect(() => manager.destroy()).not.toThrow();
    });
  });
});
