/**
 * Integration tests for IframeViewManager using behavioral mocks.
 *
 * Runs the shared IViewManager conformance suite against the iframe impl,
 * then adds iframe-specific tests for behavior not covered by the suite
 * (host-iframe lifecycle, shouldAttachWhileLoading semantics, child-frame
 * focus tracker installation).
 */

import { describe, it, expect, vi } from "vitest";
import { IframeViewManager, type IframeViewManagerDeps } from "./iframe-view-manager";
import {
  runViewManagerConformance,
  type ConformanceFactory,
  type ConformanceProbe,
} from "./view-manager.conformance";
import type { WindowManager } from "./window-manager";
import { SILENT_LOGGER } from "../platform/logging";
import { createViewBoundaryMock, type MockViewBoundary } from "./view.state-mock";
import { createSessionBoundaryMock, type MockSessionBoundary } from "./session.state-mock";
import {
  createWindowBoundaryInternalMock,
  type MockWindowBoundaryInternal,
} from "./window.state-mock";
import type { ViewHandle, WindowHandle } from "./types";
import { createMockWindowManager } from "./window-manager.test-utils";

function createViewManagerWindowBoundary(): MockWindowBoundaryInternal & {
  _createdWindowHandle: WindowHandle;
} {
  const behavioralLayer = createWindowBoundaryInternalMock();
  const windowHandle = behavioralLayer.createWindow({
    width: 1200,
    height: 800,
    title: "Test Window",
    show: false,
  });
  return Object.assign(behavioralLayer, {
    _createdWindowHandle: windowHandle,
  }) as unknown as MockWindowBoundaryInternal & { _createdWindowHandle: WindowHandle };
}

function createIframeDeps(): IframeViewManagerDeps & {
  viewLayer: MockViewBoundary;
  windowLayer: MockWindowBoundaryInternal & { _createdWindowHandle: WindowHandle };
  sessionLayer: MockSessionBoundary;
} {
  const windowLayer = createViewManagerWindowBoundary();
  const viewLayer = createViewBoundaryMock();
  const sessionLayer = createSessionBoundaryMock();
  const windowManager = createMockWindowManager({
    windowHandle: windowLayer._createdWindowHandle,
  }) as unknown as WindowManager;

  return {
    windowManager,
    windowLayer,
    viewLayer,
    sessionLayer,
    appLayer: { openUrl: () => Promise.resolve() },
    config: {
      uiPreloadPath: "/path/to/preload.js",
      codeServerPort: 8080,
      workspaceHostHtmlPath: "/path/to/workspace-host.html",
    },
    logger: SILENT_LOGGER,
  };
}

/**
 * Parses `window.__host.show('/path')` / `window.__host.hide('/path')`
 * from an injected JS string, returning the kind and path. Returns null
 * if the script isn't a show/hide call.
 */
function parseHostCall(code: string): { kind: "show" | "hide"; path: string } | null {
  const m = code.match(/window\.__host\.(show|hide)\('((?:\\.|[^'\\])*)'\)/);
  if (!m) return null;
  const path = m[2]!.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  return { kind: m[1] as "show" | "hide", path };
}

/**
 * Fires the host view's did-finish-load callbacks so the iframe view
 * manager's pending hostExec queue drains synchronously. Must be called
 * AFTER manager.create() but before any setActiveWorkspace.
 */
function flushHostReady(viewLayer: MockViewBoundary, hostHandle: ViewHandle): void {
  viewLayer.$.triggerDidFinishLoad(hostHandle);
}

function makeIframeConformanceFactory(): ConformanceFactory {
  return () => {
    const deps = createIframeDeps();
    const attachOrder: string[] = [];
    const detachOrder: string[] = [];

    const manager = new IframeViewManager(deps);
    manager.create();

    const hostHandle = manager.getWorkspaceHostHandle();
    const uiViewHandleId = manager.getUIViewHandle().id;

    // Intercept executeJavaScript on the host handle to record show/hide
    // calls into the probe's attach/detach order. The interception runs
    // synchronously before the (mock-resolved) promise — hostExec is
    // synchronous through to this call once the host is ready.
    const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
    deps.viewLayer.executeJavaScript = (handle, code) => {
      if (handle.id === hostHandle.id) {
        const call = parseHostCall(code);
        if (call?.kind === "show") attachOrder.push(call.path);
        else if (call?.kind === "hide") detachOrder.push(call.path);
      }
      return originalExec(handle, code);
    };

    // Drain queued hostExec calls synchronously so subsequent test
    // actions hit the executeJavaScript interceptor without microtask
    // delay.
    flushHostReady(deps.viewLayer, hostHandle);

    const windowId = deps.windowLayer._createdWindowHandle.id;
    const probe: ConformanceProbe = {
      get attachOrder() {
        return attachOrder;
      },
      get detachOrder() {
        return detachOrder;
      },
      uiIsTop() {
        const children = deps.viewLayer.$.windowChildren.get(windowId) ?? [];
        if (children.length === 0) return false;
        return children[children.length - 1] === uiViewHandleId;
      },
      reset() {
        attachOrder.length = 0;
        detachOrder.length = 0;
      },
    };

    return { manager, probe };
  };
}

runViewManagerConformance({
  name: "IframeViewManager",
  makeFactory: () => makeIframeConformanceFactory(),
});

describe("IframeViewManager", () => {
  describe("host view lifecycle", () => {
    it("creates a single workspace-host view and reuses its handle for every workspace", () => {
      const deps = createIframeDeps();
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);

      // Track distinct view handles attached to the window across workspaces.
      const seenHandles = new Set<string>([host.id]);
      const originalAttach = deps.viewLayer.attachToWindow.bind(deps.viewLayer);
      deps.viewLayer.attachToWindow = (handle, win, idx, opts) => {
        seenHandles.add(handle.id);
        return originalAttach(handle, win, idx, opts);
      };

      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.createWorkspaceView("/b", "http://127.0.0.1/?b", "/p");
      manager.createWorkspaceView("/c", "http://127.0.0.1/?c", "/p");

      // Only host + UI view should ever be attached — workspaces are iframes
      // inside the host, not separate WebContentsViews.
      expect(seenHandles.size).toBeLessThanOrEqual(2);
      expect(seenHandles.has(host.id)).toBe(true);
    });

    it("installs the child-frame focus tracker on the host view", () => {
      const deps = createIframeDeps();
      let installedOn: string | null = null;
      let installedScript: string | null = null;
      const originalInstall = deps.viewLayer.installChildFrameScript.bind(deps.viewLayer);
      deps.viewLayer.installChildFrameScript = (handle, script) => {
        installedOn = handle.id;
        installedScript = script;
        return originalInstall(handle, script);
      };

      const manager = new IframeViewManager(deps);
      manager.create();

      const host = manager.getWorkspaceHostHandle();
      expect(installedOn).toBe(host.id);
      expect(installedScript).toContain("__chFocusTracker");
      expect(installedScript).toContain("focusin");
    });
  });

  describe("shouldAttachWhileLoading", () => {
    it("attaches new workspaces immediately even while they are loading", () => {
      const deps = createIframeDeps();
      const showCalls: string[] = [];
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);

      const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
      deps.viewLayer.executeJavaScript = (handle, code) => {
        if (handle.id === host.id) {
          const call = parseHostCall(code);
          if (call?.kind === "show") showCalls.push(call.path);
        }
        return originalExec(handle, code);
      };

      manager.createWorkspaceView("/loading", "http://127.0.0.1/?l", "/p", /* isNew */ true);
      expect(manager.isWorkspaceLoading("/loading")).toBe(true);

      manager.setActiveWorkspace("/loading");

      // Despite being in the loading set, the iframe was shown.
      expect(showCalls).toContain("/loading");
    });
  });

  describe("host detach when no iframes remain", () => {
    it("detaches the workspace-host view after destroying the last workspace so the UI overlay is visible", async () => {
      const deps = createIframeDeps();
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.setActiveWorkspace("/a");

      // Host is attached while a workspace is active.
      expect(deps.viewLayer.$.windowChildren.get(windowId)).toContain(host.id);

      await manager.destroyWorkspaceView("/a");

      // Host must be detached so the UI view (at z-bottom) is no longer
      // covered by the host's dark body. This is the symptom from PostHog
      // issue 019e3bd1: HibernatedOverlay invisible behind the host.
      expect(deps.viewLayer.$.windowChildren.get(windowId)).not.toContain(host.id);
    });

    it("removes the iframe from the host page on destroy, so wake re-adds a fresh iframe", async () => {
      const deps = createIframeDeps();
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);

      const hostCalls: string[] = [];
      const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
      deps.viewLayer.executeJavaScript = (handle, code) => {
        if (handle.id === host.id) hostCalls.push(code);
        return originalExec(handle, code);
      };

      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.setActiveWorkspace("/a");

      // Hibernation calls destroyWorkspaceView — the iframe must actually be
      // removed from the host page (regression: previously the reverse-
      // lookup failed because the base deleted the state from the map
      // first, so __host.remove silently no-op'd and the iframe survived).
      hostCalls.length = 0;
      await manager.destroyWorkspaceView("/a");
      expect(hostCalls.some((c) => c.includes("window.__host.remove('/a')"))).toBe(true);

      // Wake: re-create + re-load — must add the iframe back via __host.add.
      hostCalls.length = 0;
      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.setActiveWorkspace("/a");
      expect(
        hostCalls.some((c) => c.includes("window.__host.add('/a', 'http://127.0.0.1/?a')"))
      ).toBe(true);
    });

    it("keeps the workspace-host view attached when other workspaces remain", async () => {
      const deps = createIframeDeps();
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.createWorkspaceView("/b", "http://127.0.0.1/?b", "/p");
      manager.setActiveWorkspace("/a");
      expect(deps.viewLayer.$.windowChildren.get(windowId)).toContain(host.id);

      // Destroying one of two workspaces must NOT detach the host — there
      // is still another iframe to show.
      await manager.destroyWorkspaceView("/a");
      expect(deps.viewLayer.$.windowChildren.get(windowId)).toContain(host.id);
    });
  });

  describe("DirectComposition re-composite on workspace switch", () => {
    it("force-re-attaches the workspace-host view when swapping the active iframe", () => {
      const deps = createIframeDeps();
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();
      flushHostReady(deps.viewLayer, host);

      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.createWorkspaceView("/b", "http://127.0.0.1/?b", "/p");
      manager.setActiveWorkspace("/a");

      // Record host attachments with `force: true` after switching workspaces.
      const forceAttachCalls: ViewHandle[] = [];
      const originalAttach = deps.viewLayer.attachToWindow.bind(deps.viewLayer);
      deps.viewLayer.attachToWindow = (handle, win, idx, opts) => {
        if (opts?.force === true && handle.id === host.id) {
          forceAttachCalls.push(handle);
        }
        return originalAttach(handle, win, idx, opts);
      };

      manager.setActiveWorkspace("/b");

      // The host must be re-attached with `{ force: true }` after the swap
      // to force a DirectComposition re-composite. Without this the newly-
      // revealed iframe can come back blank on Windows.
      expect(forceAttachCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("did-fail-load retry on subframe failure", () => {
    it("schedules an exponential-backoff retry when an iframe URL fails to load", () => {
      vi.useFakeTimers();
      try {
        const deps = createIframeDeps();
        const manager = new IframeViewManager(deps);
        manager.create();
        const host = manager.getWorkspaceHostHandle();
        flushHostReady(deps.viewLayer, host);

        manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
        manager.setActiveWorkspace("/a");

        // Capture `__host.add(..., { force: true })` retry calls.
        const retryAddCalls: string[] = [];
        const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
        deps.viewLayer.executeJavaScript = (handle, code) => {
          if (
            handle.id === host.id &&
            code.includes("__host.add") &&
            code.includes("force: true")
          ) {
            retryAddCalls.push(code);
          }
          return originalExec(handle, code);
        };

        // Simulate a subframe load failure for /a's URL.
        deps.viewLayer.$.triggerDidFailLoad(host, {
          errorCode: -21,
          errorDescription: "ERR_NETWORK_CHANGED",
          isMainFrame: false,
          validatedURL: "http://127.0.0.1/?a",
        });

        // No retry should have fired yet (delay is 1s).
        expect(retryAddCalls).toHaveLength(0);

        // After 1s the first retry fires with `force: true`.
        vi.advanceTimersByTime(1000);
        expect(retryAddCalls).toHaveLength(1);
        expect(retryAddCalls[0]).toContain("/a");
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores main-frame failures (the host page itself) and unknown URLs", () => {
      vi.useFakeTimers();
      try {
        const deps = createIframeDeps();
        const manager = new IframeViewManager(deps);
        manager.create();
        const host = manager.getWorkspaceHostHandle();
        flushHostReady(deps.viewLayer, host);

        manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
        manager.setActiveWorkspace("/a");

        const retryCalls: string[] = [];
        const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
        deps.viewLayer.executeJavaScript = (handle, code) => {
          if (
            handle.id === host.id &&
            code.includes("__host.add") &&
            code.includes("force: true")
          ) {
            retryCalls.push(code);
          }
          return originalExec(handle, code);
        };

        // Main-frame failure: ignored.
        deps.viewLayer.$.triggerDidFailLoad(host, {
          errorCode: -21,
          errorDescription: "ERR_NETWORK_CHANGED",
          isMainFrame: true,
          validatedURL: "file:///path/to/workspace-host.html",
        });
        // Subframe failure for a URL we don't recognize: ignored.
        deps.viewLayer.$.triggerDidFailLoad(host, {
          errorCode: -21,
          errorDescription: "ERR_NETWORK_CHANGED",
          isMainFrame: false,
          validatedURL: "http://example.test/unknown",
        });

        vi.advanceTimersByTime(20000);
        expect(retryCalls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("hostExec queue", () => {
    it("queues calls made before host did-finish-load and drains them in order on ready", () => {
      const deps = createIframeDeps();
      const execCalls: string[] = [];
      const manager = new IframeViewManager(deps);
      manager.create();
      const host = manager.getWorkspaceHostHandle();

      const originalExec = deps.viewLayer.executeJavaScript.bind(deps.viewLayer);
      deps.viewLayer.executeJavaScript = (handle, code) => {
        if (handle.id === host.id) execCalls.push(code);
        return originalExec(handle, code);
      };

      // Host hasn't fired did-finish-load yet — calls should queue.
      manager.createWorkspaceView("/a", "http://127.0.0.1/?a", "/p");
      manager.setActiveWorkspace("/a");
      expect(execCalls).toHaveLength(0);

      // Fire did-finish-load → queue drains in order.
      flushHostReady(deps.viewLayer, host);
      expect(execCalls.length).toBeGreaterThan(0);
      // First two queued calls should be add + show for /a (in that order).
      const firstAdd = execCalls.findIndex((c) => c.includes("__host.add") && c.includes("/a"));
      const firstShow = execCalls.findIndex((c) => c.includes("__host.show") && c.includes("/a"));
      expect(firstAdd).toBeGreaterThanOrEqual(0);
      expect(firstShow).toBeGreaterThan(firstAdd);
    });
  });
});
