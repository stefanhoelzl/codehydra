/**
 * Integration tests for WebContentsViewManager using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebContentsViewManager,
  type WebContentsViewManagerDeps,
} from "./webcontents-view-manager";
import { SIDEBAR_MINIMIZED_WIDTH } from "./view-manager-types";
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
import type { WindowHandle } from "./types";
import { createMockWindowManager } from "./window-manager.test-utils";

// Mock openUrl for AppBoundary
const mockOpenUrl = vi.fn().mockResolvedValue(undefined);

/**
 * Creates a test window layer with a pre-created window for WebContentsViewManager tests.
 */
function createViewManagerWindowBoundary(): MockWindowBoundaryInternal & {
  _createdWindowHandle: WindowHandle;
} {
  const behavioralLayer = createWindowBoundaryInternalMock();

  // Create a window to get a handle
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

/**
 * Creates WebContentsViewManager deps with behavioral mocks.
 */
function createViewManagerDeps(): WebContentsViewManagerDeps & {
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
    appLayer: { openUrl: mockOpenUrl },
    config: {
      uiPreloadPath: "/path/to/preload.js",
      codeServerPort: 8080,
    },
    logger: SILENT_LOGGER,
  };
}

/**
 * Creates a WebContentsViewManager with two-phase init (constructor + create).
 */
function createViewManager(deps: WebContentsViewManagerDeps): WebContentsViewManager {
  const manager = new WebContentsViewManager(deps);
  manager.create();
  return manager;
}

/**
 * Conformance-test factory: builds a WebContentsViewManager plus a probe
 * that wraps viewLayer.attachToWindow / detachFromWindow to record per-
 * workspace attach/detach order, and inspects window children to decide
 * whether the UI is the top-most attached view.
 */
function makeWebContentsConformanceFactory(): ConformanceFactory {
  return () => {
    const deps = createViewManagerDeps();
    const uiViewHandleId = { current: "" };
    const handleToPath = new Map<string, string>();
    const attachOrder: string[] = [];
    const detachOrder: string[] = [];

    const originalAttach = deps.viewLayer.attachToWindow.bind(deps.viewLayer);
    deps.viewLayer.attachToWindow = (handle, windowHandle, index, options) => {
      const path = handleToPath.get(handle.id);
      if (path !== undefined && handle.id !== uiViewHandleId.current) {
        attachOrder.push(path);
      }
      return originalAttach(handle, windowHandle, index, options);
    };

    const originalDetach = deps.viewLayer.detachFromWindow.bind(deps.viewLayer);
    deps.viewLayer.detachFromWindow = (handle) => {
      const path = handleToPath.get(handle.id);
      if (path !== undefined && handle.id !== uiViewHandleId.current) {
        detachOrder.push(path);
      }
      return originalDetach(handle);
    };

    const manager = new WebContentsViewManager(deps);
    manager.create();
    uiViewHandleId.current = manager.getUIViewHandle().id;

    // Wrap createWorkspaceView so the probe can map handle IDs back to paths.
    const originalCreate = manager.createWorkspaceView.bind(manager);
    manager.createWorkspaceView = (path, url, projectPath, isNew) => {
      const handle = originalCreate(path, url, projectPath, isNew);
      handleToPath.set(handle.id, path);
      return handle;
    };

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
        return children[children.length - 1] === uiViewHandleId.current;
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
  name: "WebContentsViewManager",
  makeFactory: () => makeWebContentsConformanceFactory(),
});

describe("WebContentsViewManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("SIDEBAR_MINIMIZED_WIDTH constant", () => {
    it("equals 20", () => {
      expect(SIDEBAR_MINIMIZED_WIDTH).toBe(20);
    });
  });

  describe("create", () => {
    it("creates a WebContentsViewManager instance", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      expect(manager).toBeInstanceOf(WebContentsViewManager);
    });

    it("creates UI layer view with security settings", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const uiHandle = manager.getUIViewHandle();
      expect(uiHandle.id).toMatch(/^view-\d+$/);
      expect(deps.viewLayer.isAvailable(uiHandle)).toBe(true);
    });

    it("sets transparent background on UI layer", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, { backgroundColor: "#00000000" });
    });

    it("attaches UI layer to window", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, {
        attachedTo: deps.windowLayer._createdWindowHandle.id,
      });
    });

    it("subscribes to window resize events", () => {
      const deps = createViewManagerDeps();
      createViewManager(deps);

      expect(deps.windowManager.onResize).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("getUIViewHandle", () => {
    it("returns the UI layer ViewHandle", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const handle = manager.getUIViewHandle();

      expect(handle.id).toMatch(/^view-\d+$/);
      expect(handle.__brand).toBe("ViewHandle");
    });
  });

  describe("createWorkspaceView", () => {
    it("creates a workspace view (not attached)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Workspace view should exist
      expect(deps.viewLayer.isAvailable(wsHandle)).toBe(true);

      // Workspace view should NOT be attached
      expect(deps.viewLayer).toHaveView(wsHandle.id, { attachedTo: null });
    });

    it("does not load URL on creation (lazy loading)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // URL should be null (not loaded yet)
      expect(deps.viewLayer).toHaveView(wsHandle.id, { url: null });
    });

    it("stores view accessible via getWorkspaceView", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const createdHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const retrievedHandle = manager.getWorkspaceView("/path/to/workspace");
      expect(retrievedHandle).toBeDefined();
      expect(retrievedHandle?.id).toBe(createdHandle.id);
    });

    it("sets transparent background so the window backdrop shows through", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      expect(deps.viewLayer).toHaveView(wsHandle.id, { backgroundColor: "#00000000" });
    });

    it("sets full-size bounds on detached view at creation time", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Detached view should have workspace bounds so code-server renders correctly
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: null,
        bounds: { x: 20, y: 0, width: 1180, height: 800 },
      });
    });

    it("returns a ViewHandle", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const handle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      expect(handle.id).toMatch(/^view-\d+$/);
      expect(handle.__brand).toBe("ViewHandle");
    });

    it("loads URL on first activation", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate workspace
      manager.setActiveWorkspace("/path/to/workspace");

      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        url: "http://127.0.0.1:8080/?folder=/path",
      });
    });

    it("does not reload URL on subsequent activations", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const ws1Handle = manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project"
      );

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Switch to second
      manager.setActiveWorkspace("/path/to/workspace2");

      // Switch back to first - URL should still be the same (not reloaded)
      manager.setActiveWorkspace("/path/to/workspace1");

      expect(deps.viewLayer).toHaveView(ws1Handle.id, {
        url: "http://127.0.0.1:8080/?folder=/path1",
      });
    });
  });

  describe("preloadWorkspaceUrl", () => {
    it("loads URL but keeps view detached during background preload", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.preloadWorkspaceUrl("/path/to/workspace");

      // URL should be loaded, view stays detached until activated
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        url: "http://127.0.0.1:8080/?folder=/path",
        attachedTo: null,
      });
    });

    it("is idempotent - multiple calls only load URL once", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Call preload multiple times
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");

      // Should still work (idempotent)
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        url: "http://127.0.0.1:8080/?folder=/path",
      });
    });

    it("does nothing for nonexistent workspace", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Should not throw
      expect(() => manager.preloadWorkspaceUrl("/nonexistent/workspace")).not.toThrow();
    });
  });

  describe("shared session model", () => {
    it("all workspaces share the same session (same SessionHandle.id)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project1"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project2"
      );
      manager.createWorkspaceView(
        "/path/to/workspace3",
        "http://127.0.0.1:8080/?folder=/path3",
        "/path/to/project1" // Same project as workspace1
      );

      // All workspaces should share the same session (only one session created)
      expect(deps.sessionLayer).toHaveSessionCount(1);
      expect(deps.sessionLayer).toHaveSession("session-1", {
        partition: "persist:codehydra-global",
      });
    });

    it("session data persists after workspace deletion", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Create two workspaces
      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project"
      );

      // Delete workspace1
      await manager.destroyWorkspaceView("/path/to/workspace1");

      // Session should still exist (workspace2 still needs the shared session)
      expect(deps.sessionLayer).toHaveSessionCount(1);
      expect(deps.sessionLayer).toHaveSession("session-1", {
        partition: "persist:codehydra-global",
      });
    });

    it("uses global partition constant for all workspaces", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Create workspaces in different projects
      manager.createWorkspaceView(
        "/path/to/project-a/workspace1",
        "http://127.0.0.1:8080/?folder=/path-a",
        "/path/to/project-a"
      );
      manager.createWorkspaceView(
        "/path/to/project-b/workspace2",
        "http://127.0.0.1:8080/?folder=/path-b",
        "/path/to/project-b"
      );

      // Verify the partition name is the global constant
      const session = deps.sessionLayer.$.sessions.get("session-1");
      expect(session?.partition).toBe("persist:codehydra-global");
    });
  });

  describe("destroyWorkspaceView", () => {
    it("removes view from internal map", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      await manager.destroyWorkspaceView("/path/to/workspace");

      expect(manager.getWorkspaceView("/path/to/workspace")).toBeUndefined();
    });

    it("clears active workspace path when destroying active workspace", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/workspace");

      await manager.destroyWorkspaceView("/path/to/workspace");

      expect(manager.getActiveWorkspacePath()).toBeNull();
    });

    it("is idempotent - multiple calls don't throw", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      await manager.destroyWorkspaceView("/path/to/workspace");
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();
    });

    it("handles workspace that never existed", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      await expect(manager.destroyWorkspaceView("/nonexistent/workspace")).resolves.not.toThrow();
    });

    it("returns a Promise", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const result = manager.destroyWorkspaceView("/path/to/workspace");

      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it("does not clear session storage (shared across workspaces)", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Get the session handle id before destroying
      const sessions = [...deps.sessionLayer.$.sessions.entries()];
      const globalSessionId = sessions.find(
        ([, s]) => s.partition === "persist:codehydra-global"
      )?.[0];
      expect(globalSessionId).toBeDefined();

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Session should still exist (data preserved for shared session)
      expect(deps.sessionLayer).toHaveSession(globalSessionId!);
    });
  });

  describe("getWorkspaceView", () => {
    it("returns the view handle for existing workspace", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const createdHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const retrievedHandle = manager.getWorkspaceView("/path/to/workspace");

      expect(retrievedHandle?.id).toBe(createdHandle.id);
    });

    it("returns undefined for non-existent workspace", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const view = manager.getWorkspaceView("/path/to/nonexistent");

      expect(view).toBeUndefined();
    });
  });

  describe("updateBounds", () => {
    it("only updates active workspace bounds (O(1) not O(n))", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = createViewManager(deps);

      const ws1Handle = manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project"
      );
      const ws2Handle = manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project"
      );

      // Activate workspace1
      manager.setActiveWorkspace("/path/to/workspace1");
      manager.updateBounds();

      // Active workspace should have bounds set
      expect(deps.viewLayer).toHaveView(ws1Handle.id, {
        bounds: {
          x: SIDEBAR_MINIMIZED_WIDTH,
          y: 0,
          width: 1400 - SIDEBAR_MINIMIZED_WIDTH,
          height: 900,
        },
      });
      // Inactive workspace has creation-time bounds (set at creation, not updated by updateBounds)
      expect(deps.viewLayer).toHaveView(ws2Handle.id, {
        bounds: { x: 20, y: 0, width: 1380, height: 900 },
      });
    });

    it("sets UI layer bounds to full window", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = createViewManager(deps);

      manager.updateBounds();

      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, {
        bounds: { x: 0, y: 0, width: 1400, height: 900 },
      });
    });

    it("sets active workspace bounds with sidebar offset", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        bounds: {
          x: SIDEBAR_MINIMIZED_WIDTH,
          y: 0,
          width: 1400 - SIDEBAR_MINIMIZED_WIDTH,
          height: 900,
        },
      });
    });

    it("clamps bounds at minimum window size", () => {
      const deps = createViewManagerDeps();
      // Smaller than minimum 800x600
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 600, height: 400 });
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      // Should use clamped values (min 800x600)
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        bounds: {
          x: SIDEBAR_MINIMIZED_WIDTH,
          y: 0,
          width: 800 - SIDEBAR_MINIMIZED_WIDTH,
          height: 600,
        },
      });
    });

    it("updates loading (detached) workspace bounds on resize", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew — loading
      );
      manager.setActiveWorkspace("/path/to/workspace");

      // Simulate resize
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1600, height: 1000 });
      manager.updateBounds();

      // Detached loading workspace should have updated bounds
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: null,
        bounds: {
          x: SIDEBAR_MINIMIZED_WIDTH,
          y: 0,
          width: 1600 - SIDEBAR_MINIMIZED_WIDTH,
          height: 1000,
        },
      });
    });
  });

  describe("setActiveWorkspace", () => {
    it("loads URL and attaches view on first activation (when not loading)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Mark workspace as loaded (not in loading state)
      manager.setWorkspaceLoaded("/path/to/workspace");

      manager.setActiveWorkspace("/path/to/workspace");

      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        url: "http://127.0.0.1:8080/?folder=/path",
        attachedTo: deps.windowLayer._createdWindowHandle.id,
      });
    });

    it("detaches previous workspace when switching", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const ws1Handle = manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project"
      );
      const ws2Handle = manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project"
      );

      // Mark both as loaded
      manager.setWorkspaceLoaded("/path/to/workspace1");
      manager.setWorkspaceLoaded("/path/to/workspace2");

      // Activate first
      manager.setActiveWorkspace("/path/to/workspace1");

      // Switch to second
      manager.setActiveWorkspace("/path/to/workspace2");

      // First should be detached, second should be attached
      expect(deps.viewLayer).toHaveView(ws1Handle.id, { attachedTo: null });
      expect(deps.viewLayer).toHaveView(ws2Handle.id, {
        attachedTo: deps.windowLayer._createdWindowHandle.id,
      });
    });

    it("is idempotent - same workspace doesn't re-attach", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Activate twice
      manager.setActiveWorkspace("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      // Should still be attached (no error)
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: deps.windowLayer._createdWindowHandle.id,
      });
    });

    it("keeps UI view at index 0 in workspace mode (below workspace view)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      // UI view sits at the bottom; the window's own backgroundColor is the backdrop.
      const uiHandle = manager.getUIViewHandle();
      const children = deps.viewLayer.$.windowChildren.get(windowId);
      expect(children?.[0]).toBe(uiHandle.id);
    });

    it("null workspace detaches current", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      manager.setActiveWorkspace(null);

      expect(deps.viewLayer).toHaveView(wsHandle.id, { attachedTo: null });
      expect(manager.getActiveWorkspacePath()).toBeNull();
    });

    it("focuses UI when setting active workspace to null", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      // Set active to null (simulates closing last workspace)
      manager.setActiveWorkspace(null);

      // UI should be focused to receive keyboard events
      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });

    it("updates active workspace path", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      expect(manager.getActiveWorkspacePath()).toBe("/path/to/workspace");
    });
  });

  describe("focus", () => {
    it("focuses UI when no active workspace", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.focus();

      // UI should be focused as fallback
      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });

    it("focuses UI during loading (workspace is detached)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew — loading
      );
      manager.setActiveWorkspace("/path/to/workspace");

      // UI view should be focused — loading workspace is detached,
      // Alt+X detection works via UI view's before-input-event
      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });

    it("focuses UI in shortcut mode even when workspace is attached", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.setMode("shortcut");

      manager.focus();

      const uiHandle = manager.getUIViewHandle();
      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });

    it("is no-op in dialog mode", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.setMode("dialog");

      // Should not throw
      expect(() => manager.focus()).not.toThrow();
    });
  });

  describe("setMode", () => {
    it("changes mode from workspace to shortcut", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      expect(manager.getMode()).toBe("workspace");

      manager.setMode("shortcut");

      expect(manager.getMode()).toBe("shortcut");
    });

    it("is idempotent - same mode is no-op", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const callback = vi.fn();
      manager.onModeChange(callback);
      callback.mockClear();

      manager.setMode("workspace"); // Same as initial

      expect(callback).not.toHaveBeenCalled();
    });

    it("emits mode change event", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const callback = vi.fn();
      manager.onModeChange(callback);

      manager.setMode("shortcut");

      expect(callback).toHaveBeenCalledWith({
        mode: "shortcut",
        previousMode: "workspace",
      });
    });
  });

  describe("getMode", () => {
    it("returns current mode", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      expect(manager.getMode()).toBe("workspace");

      manager.setMode("dialog");
      expect(manager.getMode()).toBe("dialog");
    });
  });

  describe("onModeChange", () => {
    it("returns unsubscribe function", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const callback = vi.fn();
      const unsubscribe = manager.onModeChange(callback);

      unsubscribe();

      manager.setMode("shortcut");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("onWorkspaceChange", () => {
    it("is called when active workspace changes", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const callback = vi.fn();
      manager.onWorkspaceChange(callback);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      expect(callback).toHaveBeenCalledWith("/path/to/workspace");
    });

    it("is called with null when workspace deactivated", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const callback = vi.fn();
      manager.onWorkspaceChange(callback);

      manager.setActiveWorkspace(null);

      expect(callback).toHaveBeenCalledWith(null);
    });
  });

  describe("isWorkspaceLoading", () => {
    it("returns true for newly created workspace with isNew=true", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(true);
    });

    it("returns false for workspace with isNew=false (default)", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });

    it("returns false after setWorkspaceLoaded called", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });
  });

  describe("setWorkspaceLoaded", () => {
    it("attaches detached view at full bounds when active workspace finishes loading", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew - starts loading
      );

      // Activate — view stays detached with full-size bounds
      manager.setActiveWorkspace("/path/to/workspace");
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: null,
        bounds: { x: 20, y: 0, width: 1180, height: 800 },
      });

      // Mark as loaded — view gets attached at full bounds
      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: windowId,
        bounds: { x: 20, y: 0, width: 1180, height: 800 },
      });
    });

    it("is idempotent", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true
      );

      // Call multiple times
      expect(() => {
        manager.setWorkspaceLoaded("/path/to/workspace");
        manager.setWorkspaceLoaded("/path/to/workspace");
        manager.setWorkspaceLoaded("/path/to/workspace");
      }).not.toThrow();
    });

    it("keeps loading workspace detached with full-size bounds", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      manager.setActiveWorkspace("/path/to/workspace");

      // Loading workspace stays detached — not in window children
      const children = deps.viewLayer.$.windowChildren.get(windowId);
      expect(children).not.toContain(wsHandle.id);

      // Full-size bounds set on detached view so code-server renders correctly
      expect(deps.viewLayer).toHaveView(wsHandle.id, {
        attachedTo: null,
        bounds: { x: 20, y: 0, width: 1180, height: 800 },
      });

      // Z-order: only UI attached (workspace is detached)
      expect(children).toHaveLength(1);
    });

    it("setMode to workspace during loading preserves z-order", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      manager.setMode("dialog");

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.setMode("workspace");

      // Loading workspace is detached — only UI attached
      const children = deps.viewLayer.$.windowChildren.get(windowId);
      expect(children).toHaveLength(1);
    });

    it("background preload does not disrupt active workspace z-order", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      // Active loaded workspace
      const activeHandle = manager.createWorkspaceView(
        "/path/to/active",
        "http://127.0.0.1:8080/?folder=/active",
        "/path/to/project",
        false
      );
      manager.setActiveWorkspace("/path/to/active");

      // Background preload
      const bgHandle = manager.createWorkspaceView(
        "/path/to/bg",
        "http://127.0.0.1:8080/?folder=/bg",
        "/path/to/project",
        true
      );
      manager.preloadWorkspaceUrl("/path/to/bg");

      // Preloaded view stays detached — not in window children
      const children = deps.viewLayer.$.windowChildren.get(windowId);
      expect(children).not.toContain(bgHandle.id);

      // Active workspace still on top
      const uiId = manager.getUIViewHandle().id;
      expect(children![children!.length - 1]).toBe(activeHandle.id);
      expect(children).toContain(uiId);
    });

    it("keeps inactive view detached when workspace finishes loading", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Preload (not activate) — view stays detached
      manager.preloadWorkspaceUrl("/path/to/workspace");

      // Mark as loaded — view should remain detached
      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(deps.viewLayer).toHaveView(wsHandle.id, { attachedTo: null });
    });

    it("switching workspaces while loading maintains correct z-order", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);
      const windowId = deps.windowLayer._createdWindowHandle.id;

      // Create two loading workspaces
      const ws1Handle = manager.createWorkspaceView(
        "/path/to/ws1",
        "http://127.0.0.1:8080/?folder=/ws1",
        "/path/to/project",
        true
      );
      const ws2Handle = manager.createWorkspaceView(
        "/path/to/ws2",
        "http://127.0.0.1:8080/?folder=/ws2",
        "/path/to/project",
        true
      );

      // Activate first, then switch to second
      manager.setActiveWorkspace("/path/to/ws1");
      manager.setActiveWorkspace("/path/to/ws2");

      const children = deps.viewLayer.$.windowChildren.get(windowId);

      // Both loading workspaces stay detached — only UI attached
      expect(children).not.toContain(ws1Handle.id);
      expect(children).not.toContain(ws2Handle.id);
      expect(children).toHaveLength(1);
    });

    it("restores focus to UI view when workspace finishes loading in dialog mode", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew - starts loading
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.setMode("dialog");

      const uiHandle = manager.getUIViewHandle();

      // Workspace finishes loading — focus must stay on UI for dialog's focus trap
      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });

    it("restores focus to UI view when switching workspaces in dialog mode", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://127.0.0.1:8080/?folder=/ws1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/ws2",
        "http://127.0.0.1:8080/?folder=/ws2",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/ws1");
      manager.setMode("dialog");

      const uiHandle = manager.getUIViewHandle();

      // Switch workspace while dialog is open — focus must stay on UI
      manager.setActiveWorkspace("/path/to/ws2");

      expect(deps.viewLayer).toHaveView(uiHandle.id, { focused: true });
    });
  });

  describe("onLoadingChange", () => {
    it("is called when workspace starts loading", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const callback = vi.fn();
      manager.onLoadingChange(callback);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(callback).toHaveBeenCalledWith("/path/to/workspace", true);
    });

    it("is called when workspace finishes loading", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      const callback = vi.fn();
      manager.onLoadingChange(callback);

      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(callback).toHaveBeenCalledWith("/path/to/workspace", false);
    });

    it("emits loading=false for already-loaded workspaces when callback is wired", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Create workspace that finishes loading BEFORE callback is wired
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew - starts in loading state
      );

      // Simulate workspace finished loading (timeout fires)
      await vi.advanceTimersByTimeAsync(10001);
      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);

      // Wire callback AFTER workspace is already loaded
      const callback = vi.fn();
      manager.onLoadingChange(callback);

      // Verify callback receives loading=false for already-loaded workspace
      expect(callback).toHaveBeenCalledWith("/path/to/workspace", false);

      vi.useRealTimers();
    });
  });

  describe("updateCodeServerPort", () => {
    it("updates the port", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Should not throw
      expect(() => manager.updateCodeServerPort(9090)).not.toThrow();
    });
  });

  describe("destroy", () => {
    it("destroys all views", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://127.0.0.1:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://127.0.0.1:8080/?folder=/path2",
        "/path/to/project"
      );

      manager.destroy();

      // Views should be destroyed (this is async internally, but we check state)
      expect(manager.getWorkspaceView("/path/to/workspace1")).toBeUndefined();
      expect(manager.getWorkspaceView("/path/to/workspace2")).toBeUndefined();
    });
  });

  describe("reloadAllViews", () => {
    it("reloads views with urlLoaded === true", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://127.0.0.1:8080/?folder=/ws1",
        "/path/to/project"
      );

      // Activate to trigger URL load
      manager.setActiveWorkspace("/path/to/ws1");

      // Spy on loadURL to verify reload is called
      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockClear();

      manager.reloadAllViews();

      const ws1Handle = manager.getWorkspaceView("/path/to/ws1")!;
      expect(loadURLSpy).toHaveBeenCalledWith(ws1Handle, "http://127.0.0.1:8080/?folder=/ws1");
    });

    it("skips views with urlLoaded === false", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Create but do NOT activate (URL not loaded)
      const wsHandle = manager.createWorkspaceView(
        "/path/to/ws1",
        "http://127.0.0.1:8080/?folder=/ws1",
        "/path/to/project"
      );

      manager.reloadAllViews();

      // URL should still be null (never loaded)
      expect(deps.viewLayer).toHaveView(wsHandle.id, { url: null });
    });

    it("skips workspaces in loading state", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Create as new (loading state)
      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://127.0.0.1:8080/?folder=/ws1",
        "/path/to/project",
        true // isNew = loading state
      );

      // Activate to trigger URL load, but workspace is still loading
      manager.setActiveWorkspace("/path/to/ws1");
      expect(manager.isWorkspaceLoading("/path/to/ws1")).toBe(true);

      // Spy on loadURL to track calls during reloadAllViews
      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockClear();

      manager.reloadAllViews();

      // loadURL should not have been called (loading workspace skipped)
      expect(loadURLSpy).not.toHaveBeenCalled();
    });

    it("is a no-op when no workspaces exist", () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      // Should not throw
      expect(() => manager.reloadAllViews()).not.toThrow();
    });
  });

  describe("URL load retry", () => {
    it("retries on main-frame did-fail-load after URL is loaded", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate to trigger URL load
      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockClear();

      // Trigger load failure
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      // Advance past first retry delay (1s)
      await vi.advanceTimersByTimeAsync(1000);

      expect(loadURLSpy).toHaveBeenCalledWith(wsHandle, "http://127.0.0.1:8080/?folder=/path");

      vi.useRealTimers();
    });

    it("ignores sub-frame failures", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockClear();

      // Trigger sub-frame failure
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: false,
      });

      await vi.advanceTimersByTimeAsync(5000);

      // No retry should have been scheduled
      expect(loadURLSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("uses exponential backoff delays", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");

      // First failure: 1s delay
      loadURLSpy.mockClear();
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(loadURLSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadURLSpy).toHaveBeenCalledTimes(1);

      // Second failure: 2s delay
      loadURLSpy.mockClear();
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(loadURLSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadURLSpy).toHaveBeenCalledTimes(1);

      // Third failure: 5s delay
      loadURLSpy.mockClear();
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect(loadURLSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadURLSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("caps at 10s delay and retries indefinitely", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");

      // Burn through 1s, 2s, 5s, 10s delays
      const delays = [1000, 2000, 5000, 10000];
      for (const delay of delays) {
        loadURLSpy.mockClear();
        deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
          errorCode: -21,
          errorDescription: "ERR_NETWORK_CHANGED",
          isMainFrame: true,
        });
        await vi.advanceTimersByTimeAsync(delay);
        expect(loadURLSpy).toHaveBeenCalledTimes(1);
      }

      // Further failures should still retry at 10s (not stop)
      for (let i = 0; i < 3; i++) {
        loadURLSpy.mockClear();
        deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
          errorCode: -21,
          errorDescription: "ERR_NETWORK_CHANGED",
          isMainFrame: true,
        });
        await vi.advanceTimersByTimeAsync(9999);
        expect(loadURLSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(loadURLSpy).toHaveBeenCalledTimes(1);
      }

      vi.useRealTimers();
    });

    it("resets retry count on successful load", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");

      // Trigger failure (retry count becomes 1)
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });
      await vi.advanceTimersByTimeAsync(1000);

      // Successful load resets retry count
      deps.viewLayer.$.triggerDidFinishLoad(wsHandle);

      // Next failure should use base delay (1s), not 2s
      loadURLSpy.mockClear();
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(loadURLSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadURLSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("cleans up retry timer on destroyWorkspaceView", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");

      // Trigger failure to schedule retry
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      // Destroy before retry fires
      await manager.destroyWorkspaceView("/path/to/workspace");

      // destroyWorkspaceView navigates to about:blank, so clear the spy after destroy
      loadURLSpy.mockClear();

      // Advance past retry delay - should not attempt loadURL for the workspace
      await vi.advanceTimersByTimeAsync(5000);
      expect(loadURLSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("reloadAllViews resets retry state", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      const wsHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      // Trigger two failures to increment retry count
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });
      await vi.advanceTimersByTimeAsync(1000);
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });
      await vi.advanceTimersByTimeAsync(2000);

      // reloadAllViews resets retry state
      manager.reloadAllViews();

      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockClear();

      // Next failure should use base delay (1s), confirming retry count was reset
      deps.viewLayer.$.triggerDidFailLoad(wsHandle, {
        errorCode: -21,
        errorDescription: "ERR_NETWORK_CHANGED",
        isMainFrame: true,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(loadURLSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadURLSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe("loadURL rejection handling", () => {
    it("does not produce unhandled rejection when loadURL rejects during activation", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Mock loadURL to reject (simulating network error)
      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockRejectedValue(new Error("ERR_NETWORK_CHANGED"));

      // Activate workspace — triggers fire-and-forget loadURL
      manager.setActiveWorkspace("/path/to/workspace");

      // Flush microtasks so the rejection propagates
      await vi.waitFor(() => {
        expect(loadURLSpy).toHaveBeenCalled();
      });

      // Test passing = no unhandled rejection (vitest would fail the test)
    });

    it("does not produce unhandled rejection when reloadAllViews loadURL rejects", async () => {
      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate to mark URL as loaded
      manager.setActiveWorkspace("/path/to/workspace");

      // Now mock loadURL to reject
      const loadURLSpy = vi.spyOn(deps.viewLayer, "loadURL");
      loadURLSpy.mockRejectedValue(new Error("ERR_NETWORK_IO_SUSPENDED"));

      manager.reloadAllViews();

      await vi.waitFor(() => {
        expect(loadURLSpy).toHaveBeenCalled();
      });

      // Test passing = no unhandled rejection
    });
  });

  describe("loading timeout", () => {
    it("marks workspace as loaded after timeout", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = createViewManager(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(true);

      // Advance past timeout (10 seconds)
      await vi.advanceTimersByTimeAsync(10001);

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);

      vi.useRealTimers();
    });
  });
});
