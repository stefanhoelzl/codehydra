/**
 * Integration tests for ViewManager using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewManager, SIDEBAR_MINIMIZED_WIDTH, type ViewManagerDeps } from "./view-manager";
import type { WindowManager } from "./window-manager";
import { SILENT_LOGGER } from "../../services/logging";
import {
  createBehavioralViewLayer,
  type BehavioralViewLayer,
} from "../../services/shell/view.test-utils";
import { createSessionLayerMock } from "../../services/shell/session.state-mock";
import {
  createWindowLayerInternalMock,
  type MockWindowLayerInternal,
} from "../../services/shell/window.state-mock";
import type { WindowHandle } from "../../services/shell/types";

// Mock ShortcutController before imports
const mockShortcutController = vi.hoisted(() => ({
  registerView: vi.fn(),
  unregisterView: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../shortcut-controller", () => ({
  ShortcutController: vi.fn(function () {
    return mockShortcutController;
  }),
}));

// Mock external-url
const mockOpenExternal = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../utils/external-url", () => ({
  openExternal: mockOpenExternal,
}));

/**
 * Creates a mock WindowManager for testing.
 */
function createMockWindowManager(windowHandle: WindowHandle) {
  return {
    getWindowHandle: vi.fn(() => windowHandle),
    getBounds: vi.fn(() => ({ width: 1200, height: 800 })),
    onResize: vi.fn(() => vi.fn()),
  } as unknown as WindowManager;
}

/**
 * Creates a test window layer with a pre-created window for ViewManager tests.
 *
 * This extends the shared createWindowLayerInternalMock() with:
 * - A pre-created window handle (ViewManager needs an existing window)
 * - A mock _getRawWindow that returns a mock BaseWindow for ShortcutController
 */
function createViewManagerWindowLayer(): MockWindowLayerInternal & {
  _createdWindowHandle: WindowHandle;
} {
  const behavioralLayer = createWindowLayerInternalMock();

  // Create a window to get a handle
  const windowHandle = behavioralLayer.createWindow({
    width: 1200,
    height: 800,
    title: "Test Window",
    show: false,
  });

  // Override _getRawWindow to return a mock BaseWindow for ShortcutController
  // Use 'unknown' cast since we're mocking for tests
  const extended = Object.assign(behavioralLayer, {
    _getRawWindow: () =>
      ({
        // Mock BaseWindow for ShortcutController
        webContents: {
          on: vi.fn(),
          off: vi.fn(),
        },
      }) as unknown as import("electron").BaseWindow,
    _createdWindowHandle: windowHandle,
  });

  return extended as unknown as MockWindowLayerInternal & { _createdWindowHandle: WindowHandle };
}

/**
 * Creates ViewManager deps with behavioral mocks.
 */
function createViewManagerDeps(): ViewManagerDeps & {
  viewLayer: BehavioralViewLayer;
  windowLayer: MockWindowLayerInternal & { _createdWindowHandle: WindowHandle };
} {
  const windowLayer = createViewManagerWindowLayer();
  const viewLayer = createBehavioralViewLayer();
  const sessionLayer = createSessionLayerMock();
  const windowManager = createMockWindowManager(windowLayer._createdWindowHandle);

  return {
    windowManager,
    windowLayer,
    viewLayer,
    sessionLayer,
    config: {
      uiPreloadPath: "/path/to/preload.js",
      codeServerPort: 8080,
    },
    logger: SILENT_LOGGER,
  };
}

describe("ViewManager", () => {
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
    it("creates a ViewManager instance", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      expect(manager).toBeInstanceOf(ViewManager);
    });

    it("creates UI layer view with security settings", () => {
      const deps = createViewManagerDeps();
      ViewManager.create(deps);

      const state = deps.viewLayer._getState();
      expect(state.views.size).toBe(1);

      // Check that the UI view was created (first view)
      const uiViewId = [...state.views.keys()][0]!;
      expect(uiViewId).toMatch(/^view-\d+$/);
    });

    it("sets transparent background on UI layer", () => {
      const deps = createViewManagerDeps();
      ViewManager.create(deps);

      const state = deps.viewLayer._getState();
      const uiView = [...state.views.values()][0];
      expect(uiView?.backgroundColor).toBe("#00000000");
    });

    it("attaches UI layer to window", () => {
      const deps = createViewManagerDeps();
      ViewManager.create(deps);

      const state = deps.viewLayer._getState();
      const uiView = [...state.views.values()][0];
      expect(uiView?.attachedTo).toBe(deps.windowLayer._createdWindowHandle.id);
    });

    it("subscribes to window resize events", () => {
      const deps = createViewManagerDeps();
      ViewManager.create(deps);

      expect(deps.windowManager.onResize).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("getUIViewHandle", () => {
    it("returns the UI layer ViewHandle", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      const handle = manager.getUIViewHandle();

      expect(handle.id).toMatch(/^view-\d+$/);
      expect(handle.__brand).toBe("ViewHandle");
    });
  });

  describe("createWorkspaceView", () => {
    it("creates a workspace view (not attached)", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const state = deps.viewLayer._getState();
      // Should have 2 views: UI + workspace
      expect(state.views.size).toBe(2);

      // Workspace view should NOT be attached
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.attachedTo).toBeNull();
    });

    it("does not load URL on creation (lazy loading)", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      // URL should be null (not loaded yet)
      expect(workspaceView?.url).toBeNull();
    });

    it("stores view accessible via getWorkspaceView", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      const createdHandle = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const retrievedHandle = manager.getWorkspaceView("/path/to/workspace");
      expect(retrievedHandle).toBeDefined();
      expect(retrievedHandle?.id).toBe(createdHandle.id);
    });

    it("sets dark background color", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.backgroundColor).toBe("#1e1e1e");
    });

    it("returns a ViewHandle", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate workspace
      manager.setActiveWorkspace("/path/to/workspace");

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.url).toBe("http://127.0.0.1:8080/?folder=/path");
    });

    it("does not reload URL on subsequent activations", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Switch to second
      manager.setActiveWorkspace("/path/to/workspace2");

      // Switch back to first - URL should still be the same (not reloaded)
      manager.setActiveWorkspace("/path/to/workspace1");

      const state = deps.viewLayer._getState();
      const workspace1View = [...state.views.values()][1];
      expect(workspace1View?.url).toBe("http://127.0.0.1:8080/?folder=/path1");
    });
  });

  describe("preloadWorkspaceUrl", () => {
    it("loads URL without attaching view", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.preloadWorkspaceUrl("/path/to/workspace");

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      // URL should be loaded
      expect(workspaceView?.url).toBe("http://127.0.0.1:8080/?folder=/path");
      // But still not attached
      expect(workspaceView?.attachedTo).toBeNull();
    });

    it("is idempotent - multiple calls only load URL once", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Call preload multiple times
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");

      // Should still work (idempotent)
      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.url).toBe("http://127.0.0.1:8080/?folder=/path");
    });

    it("does nothing for nonexistent workspace", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      // Should not throw
      expect(() => manager.preloadWorkspaceUrl("/nonexistent/workspace")).not.toThrow();
    });
  });

  describe("destroyWorkspaceView", () => {
    it("removes view from internal map", async () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

      await expect(manager.destroyWorkspaceView("/nonexistent/workspace")).resolves.not.toThrow();
    });

    it("returns a Promise", async () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      const result = manager.destroyWorkspaceView("/path/to/workspace");

      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe("getWorkspaceView", () => {
    it("returns the view handle for existing workspace", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

      const view = manager.getWorkspaceView("/path/to/nonexistent");

      expect(view).toBeUndefined();
    });
  });

  describe("updateBounds", () => {
    it("only updates active workspace bounds (O(1) not O(n))", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(deps);

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

      // Activate workspace1
      manager.setActiveWorkspace("/path/to/workspace1");
      manager.updateBounds();

      const state = deps.viewLayer._getState();
      const workspace1View = [...state.views.values()][1];
      const workspace2View = [...state.views.values()][2];

      // Active workspace should have bounds set
      expect(workspace1View?.bounds).not.toBeNull();
      // Inactive workspace should NOT have bounds set (it's detached)
      expect(workspace2View?.bounds).toBeNull();
    });

    it("sets UI layer bounds to full window", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(deps);

      manager.updateBounds();

      const state = deps.viewLayer._getState();
      const uiView = [...state.views.values()][0];
      expect(uiView?.bounds).toEqual({
        x: 0,
        y: 0,
        width: 1400,
        height: 900,
      });
    });

    it("sets active workspace bounds with sidebar offset", () => {
      const deps = createViewManagerDeps();
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.bounds).toEqual({
        x: SIDEBAR_MINIMIZED_WIDTH,
        y: 0,
        width: 1400 - SIDEBAR_MINIMIZED_WIDTH,
        height: 900,
      });
    });

    it("clamps bounds at minimum window size", () => {
      const deps = createViewManagerDeps();
      // Smaller than minimum 800x600
      vi.mocked(deps.windowManager.getBounds).mockReturnValue({ width: 600, height: 400 });
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      // Should use clamped values (min 800x600)
      expect(workspaceView?.bounds).toEqual({
        x: SIDEBAR_MINIMIZED_WIDTH,
        y: 0,
        width: 800 - SIDEBAR_MINIMIZED_WIDTH,
        height: 600,
      });
    });
  });

  describe("setActiveWorkspace", () => {
    it("loads URL and attaches view on first activation (when not loading)", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      // Mark workspace as loaded (not in loading state)
      manager.setWorkspaceLoaded("/path/to/workspace");

      manager.setActiveWorkspace("/path/to/workspace");

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      // URL should be loaded
      expect(workspaceView?.url).toBe("http://127.0.0.1:8080/?folder=/path");
      // View should be attached
      expect(workspaceView?.attachedTo).toBe(deps.windowLayer._createdWindowHandle.id);
    });

    it("detaches previous workspace when switching", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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

      // Mark both as loaded
      manager.setWorkspaceLoaded("/path/to/workspace1");
      manager.setWorkspaceLoaded("/path/to/workspace2");

      // Activate first
      manager.setActiveWorkspace("/path/to/workspace1");

      // Switch to second
      manager.setActiveWorkspace("/path/to/workspace2");

      const state = deps.viewLayer._getState();
      const workspace1View = [...state.views.values()][1];
      const workspace2View = [...state.views.values()][2];

      // First should be detached
      expect(workspace1View?.attachedTo).toBeNull();
      // Second should be attached
      expect(workspace2View?.attachedTo).toBe(deps.windowLayer._createdWindowHandle.id);
    });

    it("is idempotent - same workspace doesn't re-attach", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Activate twice
      manager.setActiveWorkspace("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      // Should still be attached (no error)
      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.attachedTo).toBe(deps.windowLayer._createdWindowHandle.id);
    });

    it("null workspace detaches current", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");

      manager.setActiveWorkspace(null);

      const state = deps.viewLayer._getState();
      const workspaceView = [...state.views.values()][1];
      expect(workspaceView?.attachedTo).toBeNull();
      expect(manager.getActiveWorkspacePath()).toBeNull();
    });

    it("updates active workspace path", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      expect(manager.getActiveWorkspacePath()).toBe("/path/to/workspace");
    });
  });

  describe("focusActiveWorkspace", () => {
    it("does nothing when no active workspace", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      // Should not throw
      expect(() => manager.focusActiveWorkspace()).not.toThrow();
    });
  });

  describe("focusUI", () => {
    it("does not throw", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      // Should not throw (focus is a no-op in behavioral mock)
      expect(() => manager.focusUI()).not.toThrow();
    });
  });

  describe("setMode", () => {
    it("changes mode from workspace to shortcut", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      expect(manager.getMode()).toBe("workspace");

      manager.setMode("shortcut");

      expect(manager.getMode()).toBe("shortcut");
    });

    it("is idempotent - same mode is no-op", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      const callback = vi.fn();
      manager.onModeChange(callback);
      callback.mockClear();

      manager.setMode("workspace"); // Same as initial

      expect(callback).not.toHaveBeenCalled();
    });

    it("emits mode change event", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

      expect(manager.getMode()).toBe("workspace");

      manager.setMode("dialog");
      expect(manager.getMode()).toBe("dialog");
    });
  });

  describe("onModeChange", () => {
    it("returns unsubscribe function", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

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

    it("returns unsubscribe function", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      const callback = vi.fn();
      const unsubscribe = manager.onWorkspaceChange(callback);

      unsubscribe();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("isWorkspaceLoading", () => {
    it("returns true for newly created workspace with isNew=true", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project"
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });

    it("returns false after setWorkspaceLoaded called", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
    it("attaches view if workspace is active", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew - starts loading
      );

      // Activate (won't attach because loading)
      manager.setActiveWorkspace("/path/to/workspace");

      let state = deps.viewLayer._getState();
      let workspaceView = [...state.views.values()][1];
      expect(workspaceView?.attachedTo).toBeNull(); // Not attached during loading

      // Mark as loaded
      manager.setWorkspaceLoaded("/path/to/workspace");

      state = deps.viewLayer._getState();
      workspaceView = [...state.views.values()][1];
      expect(workspaceView?.attachedTo).toBe(deps.windowLayer._createdWindowHandle.id);
    });

    it("is idempotent", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
  });

  describe("onLoadingChange", () => {
    it("is called when workspace starts loading", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
      const manager = ViewManager.create(deps);

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

    it("returns unsubscribe function", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      const callback = vi.fn();
      const unsubscribe = manager.onLoadingChange(callback);

      unsubscribe();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://127.0.0.1:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("updateCodeServerPort", () => {
    it("updates the port", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      // Should not throw
      expect(() => manager.updateCodeServerPort(9090)).not.toThrow();
    });
  });

  describe("destroy", () => {
    it("destroys all views", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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

    it("disposes shortcut controller", () => {
      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

      manager.destroy();

      expect(mockShortcutController.dispose).toHaveBeenCalled();
    });
  });

  describe("loading timeout", () => {
    it("marks workspace as loaded after timeout", async () => {
      vi.useFakeTimers();

      const deps = createViewManagerDeps();
      const manager = ViewManager.create(deps);

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
