// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// Mock Electron and external-url before imports
const {
  mockWindowManager,
  MockWebContentsViewClass,
  mockOpenExternal,
  mockSession,
  mockFromPartition,
} = vi.hoisted(() => {
  const createMockView = () => ({
    setBounds: vi.fn(),
    setBackgroundColor: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve()),
      focus: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
      openDevTools: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setBackgroundThrottling: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(true)),
      session: {
        setPermissionRequestHandler: vi.fn(),
      },
    },
  });

  // We need to create views dynamically for each call
  const createdViews: ReturnType<typeof createMockView>[] = [];

  function MockWebContentsViewClass(
    this: ReturnType<typeof createMockView>
  ): ReturnType<typeof createMockView> {
    const view = createMockView();
    createdViews.push(view);
    return view;
  }

  const mockWindow = {
    getBounds: vi.fn(() => ({ width: 1200, height: 800, x: 0, y: 0 })),
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
      children: [] as ReturnType<typeof createMockView>[],
    },
  };

  const mockWindowManager = {
    getWindow: vi.fn(() => mockWindow),
    getBounds: vi.fn(() => ({ width: 1200, height: 800 })),
    onResize: vi.fn(() => vi.fn()),
  };

  // Mock session for partition storage clearing
  const mockSession = {
    clearStorageData: vi.fn(() => Promise.resolve()),
  };

  const mockFromPartition = vi.fn(() => mockSession);

  return {
    mockWebContentsView: createMockView(),
    mockWindowManager,
    MockWebContentsViewClass: vi.fn(
      MockWebContentsViewClass
    ) as unknown as typeof MockWebContentsViewClass & {
      mock: {
        calls: Array<unknown[]>;
        results: Array<{ value: ReturnType<typeof createMockView> }>;
      };
    },
    createdViews,
    mockOpenExternal: vi.fn().mockResolvedValue(undefined),
    mockSession,
    mockFromPartition,
  };
});

vi.mock("electron", () => ({
  WebContentsView: MockWebContentsViewClass,
  session: {
    fromPartition: mockFromPartition,
  },
}));

vi.mock("../utils/external-url", () => ({
  openExternal: mockOpenExternal,
}));

import { ViewManager, SIDEBAR_MINIMIZED_WIDTH } from "./view-manager";
import type { WindowManager } from "./window-manager";
import { SILENT_LOGGER } from "../../services/logging";

describe("ViewManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock's result tracking
    MockWebContentsViewClass.mock.results = [];
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
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(manager).toBeInstanceOf(ViewManager);
    });

    it("creates UI layer WebContentsView with security settings", () => {
      ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(MockWebContentsViewClass).toHaveBeenCalledWith({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: "/path/to/preload.js",
        },
      });
    });

    it("adds UI layer to window", () => {
      ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalled();
    });

    it("sets transparent background on UI layer", () => {
      ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      expect(uiView?.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    });

    it("subscribes to window resize events", () => {
      ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(mockWindowManager.onResize).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("getUIView", () => {
    it("returns the UI layer WebContentsView", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const uiView = manager.getUIView();
      const createdUIView = MockWebContentsViewClass.mock.results[0]?.value;

      expect(uiView).toBe(createdUIView);
    });
  });

  describe("createWorkspaceView", () => {
    it("createWorkspaceView-not-attached: view created but NOT added to contentView", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Clear calls from create (UI view)
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Workspace view should NOT be added to contentView (detached by default)
      expect(mockWindowManager.getWindow().contentView.addChildView).not.toHaveBeenCalled();
    });

    it("createWorkspaceView-url-not-loaded: loadURL not called on creation", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      // loadURL should NOT be called during creation (deferred to first activation)
      expect(workspaceView?.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("createWorkspaceView-stored: view accessible via getWorkspaceView", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // View should be stored in map and retrievable
      const view = manager.getWorkspaceView("/path/to/workspace");
      expect(view).toBeDefined();
      expect(view).toBe(MockWebContentsViewClass.mock.results[1]?.value);
    });

    it("creates WebContentsView with security settings (no preload)", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Second call should be for workspace view - no preload script, but has partition
      expect(MockWebContentsViewClass.mock.calls[1]?.[0]).toEqual({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: expect.stringMatching(/^persist:project-[a-f0-9]+\/workspace$/),
        },
      });
    });

    it("loads the code-server URL on first activation (lazy loading)", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // URL is NOT loaded on creation (lazy loading)
      expect(workspaceView?.webContents.loadURL).not.toHaveBeenCalled();

      // URL is loaded on first activation
      manager.setActiveWorkspace("/path/to/workspace");
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledWith(
        "http://localhost:8080/?folder=/path"
      );
    });

    it("does not reload URL on subsequent activations", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      const workspaceView1 = MockWebContentsViewClass.mock.results[1]?.value;

      // First activation - URL should be loaded
      manager.setActiveWorkspace("/path/to/workspace1");
      expect(workspaceView1?.webContents.loadURL).toHaveBeenCalledTimes(1);

      // Switch to another workspace
      manager.setActiveWorkspace("/path/to/workspace2");

      // Clear loadURL call count
      workspaceView1?.webContents.loadURL.mockClear();

      // Re-activate first workspace - URL should NOT be reloaded
      manager.setActiveWorkspace("/path/to/workspace1");
      expect(workspaceView1?.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("attaches workspace view to window on activation (when not loading)", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Clear calls from UI view creation
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // View is NOT added on creation (starts detached and loading)
      expect(mockWindowManager.getWindow().contentView.addChildView).not.toHaveBeenCalled();

      // Mark workspace as loaded first
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Clear calls from setWorkspaceLoaded (no active workspace yet)
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // View is added on activation when not loading
      manager.setActiveWorkspace("/path/to/workspace");
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("configures window open handler", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(workspaceView?.webContents.setWindowOpenHandler).toHaveBeenCalled();
    });

    it("returns the created view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const view = manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const expectedView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(view).toBe(expectedView);
    });
  });

  describe("preloadWorkspaceUrl", () => {
    it("preloadWorkspaceUrl-loads-url: loads URL without attaching view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Clear calls from create (UI view)
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.loadURL.mockClear();

      manager.preloadWorkspaceUrl("/path/to/workspace");

      // URL should be loaded
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledWith(
        "http://localhost:8080/?folder=/path"
      );
      // View should NOT be attached (still detached)
      expect(mockWindowManager.getWindow().contentView.addChildView).not.toHaveBeenCalled();
    });

    it("preloadWorkspaceUrl-idempotent: multiple calls only load URL once", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.loadURL.mockClear();

      // Call preload multiple times
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");
      manager.preloadWorkspaceUrl("/path/to/workspace");

      // URL should only be loaded once (idempotent)
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledTimes(1);
    });

    it("preloadWorkspaceUrl-then-activate: setActiveWorkspace after preload doesn't reload URL", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Preload first
      manager.preloadWorkspaceUrl("/path/to/workspace");
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledTimes(1);

      // Clear and activate
      workspaceView?.webContents.loadURL.mockClear();
      manager.setActiveWorkspace("/path/to/workspace");

      // URL should NOT be reloaded (already loaded by preload)
      expect(workspaceView?.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("preloadWorkspaceUrl-nonexistent: does nothing for nonexistent workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Should not throw
      expect(() => manager.preloadWorkspaceUrl("/nonexistent/workspace")).not.toThrow();
    });
  });

  describe("destroyWorkspaceView", () => {
    it("destroyWorkspaceView-detached: destroying detached view doesn't throw", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create view (detached by default)
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Destroy detached view - should not throw
      expect(() => manager.destroyWorkspaceView("/path/to/workspace")).not.toThrow();
    });

    it("destroyWorkspaceView-active: clears activeWorkspacePath and attachedWorkspacePath", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate the workspace (attaches it)
      manager.setActiveWorkspace("/path/to/workspace");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/workspace");

      // Destroy the active workspace
      manager.destroyWorkspaceView("/path/to/workspace");

      // Should clear active and attached state
      expect(manager.getActiveWorkspacePath()).toBeNull();
    });

    it("destroyWorkspaceView-url-cleanup: removes URL from workspaceUrls map", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.destroyWorkspaceView("/path/to/workspace");

      // View should be gone
      expect(manager.getWorkspaceView("/path/to/workspace")).toBeUndefined();

      // If we recreate a view with same path, it should work (URL map was cleaned)
      expect(() => {
        manager.createWorkspaceView(
          "/path/to/workspace",
          "http://localhost:8080/?folder=/path2",
          "/path/to/project"
        );
      }).not.toThrow();
    });

    it("destroyWorkspaceView-loaded-cleanup: clears loadedWorkspaces tracking", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace (this loads the URL)
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledTimes(1);

      // Destroy the workspace
      manager.destroyWorkspaceView("/path/to/workspace");

      // Recreate workspace with same path
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const newWorkspaceView = MockWebContentsViewClass.mock.results[2]?.value;

      // URL should be NOT loaded yet (lazy loading)
      expect(newWorkspaceView?.webContents.loadURL).not.toHaveBeenCalled();

      // Activate - URL should be loaded (loadedWorkspaces was cleaned up)
      manager.setActiveWorkspace("/path/to/workspace");
      expect(newWorkspaceView?.webContents.loadURL).toHaveBeenCalledTimes(1);
    });

    it("removes view from window", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.destroyWorkspaceView("/path/to/workspace");

      expect(mockWindowManager.getWindow().contentView.removeChildView).toHaveBeenCalled();
    });

    it("closes webContents", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      await manager.destroyWorkspaceView("/path/to/workspace");

      expect(workspaceView?.webContents.close).toHaveBeenCalled();
    });

    it("removes view from internal map", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.destroyWorkspaceView("/path/to/workspace");

      expect(manager.getWorkspaceView("/path/to/workspace")).toBeUndefined();
    });

    it("does not throw when view is already destroyed", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate the view being already destroyed (e.g., window closing)
      workspaceView.webContents.isDestroyed = vi.fn(() => true);

      // Should not throw
      expect(() => manager.destroyWorkspaceView("/path/to/workspace")).not.toThrow();
    });

    it("skips webContents.close when already destroyed", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate the view being already destroyed
      workspaceView.webContents.isDestroyed = vi.fn(() => true);
      workspaceView.webContents.close.mockClear();

      manager.destroyWorkspaceView("/path/to/workspace");

      // close() should NOT be called on destroyed webContents
      expect(workspaceView.webContents.close).not.toHaveBeenCalled();
    });

    it("handles errors gracefully when view operations fail", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate the view throwing when accessing webContents (destroyed state)
      workspaceView.webContents.isDestroyed = vi.fn(() => {
        throw new Error("Object has been destroyed");
      });

      // Should not throw - error should be caught
      expect(() => manager.destroyWorkspaceView("/path/to/workspace")).not.toThrow();

      // Should still remove from internal map
      expect(manager.getWorkspaceView("/path/to/workspace")).toBeUndefined();
    });

    it("skips removeChildView when window is destroyed", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const mockWindow = mockWindowManager.getWindow();

      // Simulate window being destroyed
      mockWindow.isDestroyed = vi.fn(() => true);
      mockWindow.contentView.removeChildView.mockClear();

      // Should not throw
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();

      // removeChildView should NOT be called on destroyed window
      expect(mockWindow.contentView.removeChildView).not.toHaveBeenCalled();

      // Reset for other tests
      mockWindow.isDestroyed = vi.fn(() => false);
    });

    it("destroyWorkspaceView-async: returns a Promise", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const result = manager.destroyWorkspaceView("/path/to/workspace");

      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it("destroyWorkspaceView-about-blank: navigates to about:blank before close", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.loadURL.mockClear();

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Should navigate to about:blank before closing
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledWith("about:blank");
      expect(workspaceView?.webContents.close).toHaveBeenCalled();
    });

    it("destroyWorkspaceView-about-blank-order: about:blank called before close", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Track call order
      const callOrder: string[] = [];
      workspaceView?.webContents.loadURL.mockImplementation(() => {
        callOrder.push("loadURL");
        return Promise.resolve();
      });
      workspaceView?.webContents.close.mockImplementation(() => {
        callOrder.push("close");
      });

      await manager.destroyWorkspaceView("/path/to/workspace");

      // loadURL (about:blank) should be called before close
      expect(callOrder).toEqual(["loadURL", "close"]);
    });

    it("destroyWorkspaceView-timeout: continues after navigation timeout", async () => {
      vi.useFakeTimers();
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Make loadURL hang (never resolve)
      workspaceView?.webContents.loadURL.mockImplementation(() => new Promise(() => {}));

      // Start destroy
      const destroyPromise = manager.destroyWorkspaceView("/path/to/workspace");

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(3000);

      // Should complete despite loadURL hanging
      await destroyPromise;

      // Close should still be called after timeout
      expect(workspaceView?.webContents.close).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("destroyWorkspaceView-skip-about-blank-destroyed: skips about:blank when view is destroyed", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate the view being already destroyed
      workspaceView.webContents.isDestroyed = vi.fn(() => true);
      workspaceView.webContents.loadURL.mockClear();

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Should NOT try to load about:blank on destroyed view
      expect(workspaceView.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("destroyWorkspaceView-clear-storage: calls session.clearStorageData()", async () => {
      mockFromPartition.mockClear();
      mockSession.clearStorageData.mockClear();

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Should get session for the partition and clear its storage
      expect(mockFromPartition).toHaveBeenCalledWith(
        expect.stringMatching(/^persist:project-[a-f0-9]+\/workspace$/)
      );
      expect(mockSession.clearStorageData).toHaveBeenCalled();
    });

    it("destroyWorkspaceView-clear-storage-error: handles clearStorageData errors gracefully", async () => {
      mockFromPartition.mockClear();
      mockSession.clearStorageData.mockClear();
      mockSession.clearStorageData.mockRejectedValueOnce(new Error("Storage busy"));

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Should not throw even if clearStorageData fails
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();
    });

    it("destroyWorkspaceView-partition-map-cleanup: cleans up partition name map", async () => {
      mockFromPartition.mockClear();
      mockSession.clearStorageData.mockClear();

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Now create a new workspace with the same path - should work (partition map was cleaned)
      mockFromPartition.mockClear();
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Should be called again for the new view
      expect(mockFromPartition).toHaveBeenCalled();
    });

    it("destroyWorkspaceView-idempotent: multiple calls are no-op", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // First destroy
      await manager.destroyWorkspaceView("/path/to/workspace");

      // Second destroy should be no-op (no throw)
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();

      // Third destroy should also be no-op
      await expect(manager.destroyWorkspaceView("/path/to/workspace")).resolves.not.toThrow();
    });

    it("destroyWorkspaceView-idempotent-never-existed: no throw for workspace that never existed", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Destroy workspace that was never created
      await expect(manager.destroyWorkspaceView("/nonexistent/workspace")).resolves.not.toThrow();
    });

    it("destroyWorkspaceView-map-cleanup-order: map cleanup happens before async operations", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Get view before destroy
      const view = manager.getWorkspaceView("/path/to/workspace");
      expect(view).toBeDefined();

      // Start destroy but don't await
      const destroyPromise = manager.destroyWorkspaceView("/path/to/workspace");

      // Map should be cleared immediately (before async operations complete)
      expect(manager.getWorkspaceView("/path/to/workspace")).toBeUndefined();

      await destroyPromise;
    });
  });

  describe("getWorkspaceView", () => {
    it("returns the view for existing workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const view = manager.getWorkspaceView("/path/to/workspace");

      const expectedView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(view).toBe(expectedView);
    });

    it("returns undefined for non-existent workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const view = manager.getWorkspaceView("/path/to/nonexistent");

      expect(view).toBeUndefined();
    });
  });

  describe("updateBounds", () => {
    it("updateBounds-only-active: only active workspace bounds updated", () => {
      mockWindowManager.getBounds.mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      const workspaceView1 = MockWebContentsViewClass.mock.results[1]?.value;
      const workspaceView2 = MockWebContentsViewClass.mock.results[2]?.value;

      // Activate workspace1
      manager.setActiveWorkspace("/path/to/workspace1");

      // Clear all setBounds calls
      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      uiView?.setBounds.mockClear();
      workspaceView1?.setBounds.mockClear();
      workspaceView2?.setBounds.mockClear();

      // Update bounds
      manager.updateBounds();

      // Only UI view and active workspace should have setBounds called (O(1) not O(n))
      expect(uiView?.setBounds).toHaveBeenCalled();
      expect(workspaceView1?.setBounds).toHaveBeenCalled();
      // Inactive workspace should NOT have setBounds called (it's detached)
      expect(workspaceView2?.setBounds).not.toHaveBeenCalled();
    });

    it("updateBounds-detached-no-call: detached workspaces skip setBounds", () => {
      mockWindowManager.getBounds.mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create workspaces but don't activate any
      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      const workspaceView1 = MockWebContentsViewClass.mock.results[1]?.value;
      const workspaceView2 = MockWebContentsViewClass.mock.results[2]?.value;

      // Clear all setBounds calls
      workspaceView1?.setBounds.mockClear();
      workspaceView2?.setBounds.mockClear();

      // Update bounds with no active workspace
      manager.updateBounds();

      // No workspace views should have setBounds called (all are detached)
      expect(workspaceView1?.setBounds).not.toHaveBeenCalled();
      expect(workspaceView2?.setBounds).not.toHaveBeenCalled();
    });

    it("sets UI layer bounds to full window width", () => {
      mockWindowManager.getBounds.mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.updateBounds();

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      expect(uiView?.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1400,
        height: 900,
      });
    });

    it("sets active workspace bounds to content area", () => {
      mockWindowManager.getBounds.mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(workspaceView?.setBounds).toHaveBeenCalledWith({
        x: SIDEBAR_MINIMIZED_WIDTH,
        y: 0,
        width: 1400 - SIDEBAR_MINIMIZED_WIDTH,
        height: 900,
      });
    });

    it("skips setBounds for inactive (detached) workspaces", () => {
      mockWindowManager.getBounds.mockReturnValue({ width: 1400, height: 900 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace1");

      const inactiveView = MockWebContentsViewClass.mock.results[2]?.value;
      inactiveView?.setBounds.mockClear();

      manager.updateBounds();

      // Inactive workspace is detached, so setBounds is NOT called (not zero bounds)
      expect(inactiveView?.setBounds).not.toHaveBeenCalled();
    });

    it("clamps bounds at minimum window size", () => {
      // Smaller than minimum 800x600
      mockWindowManager.getBounds.mockReturnValue({ width: 600, height: 400 });
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      // Should use clamped values
      expect(workspaceView?.setBounds).toHaveBeenCalledWith({
        x: SIDEBAR_MINIMIZED_WIDTH,
        y: 0,
        width: 800 - SIDEBAR_MINIMIZED_WIDTH,
        height: 600,
      });
    });

    it("updateBounds-destroyed-window: skips bounds update when window is destroyed", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const mockWindow = mockWindowManager.getWindow();
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      const uiView = MockWebContentsViewClass.mock.results[0]?.value;

      // Clear calls from setup
      workspaceView?.setBounds.mockClear();
      uiView?.setBounds.mockClear();

      // Simulate window being destroyed
      mockWindow.isDestroyed = vi.fn(() => true);

      // Should not throw
      expect(() => manager.updateBounds()).not.toThrow();

      // setBounds should NOT be called on any view
      expect(workspaceView?.setBounds).not.toHaveBeenCalled();
      expect(uiView?.setBounds).not.toHaveBeenCalled();

      // Reset for other tests
      mockWindow.isDestroyed = vi.fn(() => false);
    });
  });

  describe("setActiveWorkspace", () => {
    it("setActiveWorkspace-first-activation: loads URL and attaches view when not loading", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Mark workspace as loaded first
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Clear calls from create
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.setActiveWorkspace("/path/to/workspace");

      // URL should be loaded on first activation
      expect(workspaceView?.webContents.loadURL).toHaveBeenCalledWith(
        "http://localhost:8080/?folder=/path"
      );
      // View should be attached (workspace is loaded)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("setActiveWorkspace-attach-before-detach: new view attached before old detached (when not loading)", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      const workspaceView1 = MockWebContentsViewClass.mock.results[1]?.value;
      const workspaceView2 = MockWebContentsViewClass.mock.results[2]?.value;

      // Mark both workspaces as loaded
      manager.setWorkspaceLoaded("/path/to/workspace1");
      manager.setWorkspaceLoaded("/path/to/workspace2");

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Clear calls to track order
      mockWindowManager.getWindow().contentView.addChildView.mockClear();
      mockWindowManager.getWindow().contentView.removeChildView.mockClear();

      // Track call order
      const callOrder: string[] = [];
      mockWindowManager.getWindow().contentView.addChildView.mockImplementation(() => {
        callOrder.push("add");
      });
      mockWindowManager.getWindow().contentView.removeChildView.mockImplementation(() => {
        callOrder.push("remove");
      });

      // Switch to second workspace
      manager.setActiveWorkspace("/path/to/workspace2");

      // Verify: add (new view) before remove (old view)
      expect(callOrder).toEqual(["add", "remove"]);
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView2
      );
      expect(mockWindowManager.getWindow().contentView.removeChildView).toHaveBeenCalledWith(
        workspaceView1
      );
    });

    it("setActiveWorkspace-detaches-previous: previous active gets removeChildView", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );
      const workspaceView1 = MockWebContentsViewClass.mock.results[1]?.value;

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Clear calls from activation
      mockWindowManager.getWindow().contentView.removeChildView.mockClear();

      // Switch to second workspace
      manager.setActiveWorkspace("/path/to/workspace2");

      // Previous view should be detached
      expect(mockWindowManager.getWindow().contentView.removeChildView).toHaveBeenCalledWith(
        workspaceView1
      );
    });

    it("setActiveWorkspace-same-noop: same workspace doesn't detach/reattach", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Activate workspace
      manager.setActiveWorkspace("/path/to/workspace");

      // Clear calls
      mockWindowManager.getWindow().contentView.addChildView.mockClear();
      mockWindowManager.getWindow().contentView.removeChildView.mockClear();

      // Activate same workspace again
      manager.setActiveWorkspace("/path/to/workspace");

      // Should not call addChildView or removeChildView
      expect(mockWindowManager.getWindow().contentView.addChildView).not.toHaveBeenCalled();
      expect(mockWindowManager.getWindow().contentView.removeChildView).not.toHaveBeenCalled();
    });

    it("setActiveWorkspace-null-detaches: null workspace detaches current", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Activate workspace
      manager.setActiveWorkspace("/path/to/workspace");

      // Clear calls
      mockWindowManager.getWindow().contentView.removeChildView.mockClear();

      // Set null workspace
      manager.setActiveWorkspace(null);

      // Current view should be detached
      expect(mockWindowManager.getWindow().contentView.removeChildView).toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("setActiveWorkspace-attach-error: handles addChildView error gracefully", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Mark workspace as loaded so view can attach
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Make addChildView throw only once
      mockWindowManager.getWindow().contentView.addChildView.mockImplementationOnce(() => {
        throw new Error("addChildView failed");
      });

      // Should not throw
      expect(() => manager.setActiveWorkspace("/path/to/workspace")).not.toThrow();
    });

    it("setActiveWorkspace-detach-error: handles removeChildView error gracefully", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );

      // Mark workspaces as loaded so views can attach
      manager.setWorkspaceLoaded("/path/to/workspace1");
      manager.setWorkspaceLoaded("/path/to/workspace2");

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Make removeChildView throw only once
      mockWindowManager.getWindow().contentView.removeChildView.mockImplementationOnce(() => {
        throw new Error("removeChildView failed");
      });

      // Should not throw
      expect(() => manager.setActiveWorkspace("/path/to/workspace2")).not.toThrow();
    });

    it("setActiveWorkspace-dialog-mode-zorder: UI stays on top when in dialog mode", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );
      const uiView = MockWebContentsViewClass.mock.results[0]?.value;

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );

      // Mark workspaces as loaded so views can attach
      manager.setWorkspaceLoaded("/path/to/workspace1");
      manager.setWorkspaceLoaded("/path/to/workspace2");

      // Enable dialog mode
      manager.setMode("dialog");

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Clear calls
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Switch workspace while in dialog mode
      manager.setActiveWorkspace("/path/to/workspace2");

      // UI layer should be re-added to top (setMode("dialog") maintains z-order)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(uiView);
    });

    it("updates active workspace path", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setActiveWorkspace("/path/to/workspace");
      manager.updateBounds();

      // Active workspace should get content bounds
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      const setBoundsCalls = workspaceView?.setBounds.mock.calls ?? [];
      const lastCall = setBoundsCalls[setBoundsCalls.length - 1];
      expect(lastCall?.[0].width).toBeGreaterThan(0);
    });

    it("handles null active workspace (detaches view)", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      // Clear mocks to track detach
      mockWindowManager.getWindow().contentView.removeChildView.mockClear();

      manager.setActiveWorkspace(null);

      // Workspace should be detached (removeChildView called)
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.removeChildView).toHaveBeenCalledWith(
        workspaceView
      );
      expect(manager.getActiveWorkspacePath()).toBeNull();
    });

    it("focuses the workspace view by default", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(workspaceView?.webContents.focus).toHaveBeenCalled();
    });

    it("skips focus when focus parameter is false", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.focus.mockClear();

      manager.setActiveWorkspace("/path/to/workspace", false);

      expect(workspaceView?.webContents.focus).not.toHaveBeenCalled();
    });

    it("does not focus when workspace path is null", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.focus.mockClear();

      manager.setActiveWorkspace(null);

      expect(workspaceView?.webContents.focus).not.toHaveBeenCalled();
    });
  });

  describe("focusActiveWorkspace", () => {
    it("focuses the active workspace view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace", false); // Set active without focusing
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.focus.mockClear();

      manager.focusActiveWorkspace();

      expect(workspaceView?.webContents.focus).toHaveBeenCalled();
    });

    it("does nothing when no active workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Should not throw
      expect(() => manager.focusActiveWorkspace()).not.toThrow();
    });
  });

  describe("focusUI", () => {
    it("focuses the UI layer view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.focusUI();

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      expect(uiView?.webContents.focus).toHaveBeenCalled();
    });
  });

  describe("window open handler", () => {
    it("calls openExternal for external URLs", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      const handler = workspaceView?.webContents.setWindowOpenHandler.mock
        .calls[0]?.[0] as (details: { url: string }) => { action: string };

      const result = handler({ url: "https://external.com" });

      expect(mockOpenExternal).toHaveBeenCalledWith("https://external.com");
      expect(result).toEqual({ action: "deny" });
    });
  });

  describe("will-navigate handler", () => {
    it("prevents navigation away from code-server URL", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Find the will-navigate handler
      const onCalls = workspaceView?.webContents.on.mock.calls ?? [];
      const willNavigateCall = onCalls.find((call: unknown[]) => call[0] === "will-navigate") as
        | [string, (event: { preventDefault: () => void }, url: string) => void]
        | undefined;

      expect(willNavigateCall).toBeDefined();

      const handler = willNavigateCall?.[1];
      const mockEvent = { preventDefault: vi.fn() };

      // External URL should be prevented and opened externally
      handler?.(mockEvent, "https://external.com");
      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockOpenExternal).toHaveBeenCalledWith("https://external.com");
    });

    it("allows navigation within code-server origin", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;

      // Find the will-navigate handler
      const onCalls = workspaceView?.webContents.on.mock.calls ?? [];
      const willNavigateCall = onCalls.find((call: unknown[]) => call[0] === "will-navigate") as
        | [string, (event: { preventDefault: () => void }, url: string) => void]
        | undefined;

      const handler = willNavigateCall?.[1];
      const mockEvent = { preventDefault: vi.fn() };

      // Clear previous calls
      mockOpenExternal.mockClear();

      // Code-server URL should be allowed
      handler?.(mockEvent, "http://localhost:8080/other-path");
      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("unsubscribes from resize events", () => {
      const unsubscribe = vi.fn();
      mockWindowManager.onResize.mockReturnValue(unsubscribe);

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.destroy();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it("destroys all workspace views", async () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );

      const workspaceView1 = MockWebContentsViewClass.mock.results[1]!.value;
      const workspaceView2 = MockWebContentsViewClass.mock.results[2]!.value;

      manager.destroy();

      // destroy() fires-and-forgets async cleanup, wait for it to complete
      await vi.waitFor(() => {
        expect(workspaceView1.webContents.close).toHaveBeenCalled();
        expect(workspaceView2.webContents.close).toHaveBeenCalled();
      });
    });

    it("closes UI view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const uiView = MockWebContentsViewClass.mock.results[0]!.value;

      manager.destroy();

      expect(uiView.webContents.close).toHaveBeenCalled();
    });

    it("does not throw when views are already destroyed", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const uiView = MockWebContentsViewClass.mock.results[0]!.value;
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate views being already destroyed (e.g., window closing)
      uiView.webContents.isDestroyed = vi.fn(() => true);
      workspaceView.webContents.isDestroyed = vi.fn(() => true);

      // Should not throw
      expect(() => manager.destroy()).not.toThrow();
    });

    it("skips close on already destroyed UI view", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const uiView = MockWebContentsViewClass.mock.results[0]!.value;

      // Simulate UI view being already destroyed
      uiView.webContents.isDestroyed = vi.fn(() => true);
      uiView.webContents.close.mockClear();

      manager.destroy();

      // close() should NOT be called on destroyed webContents
      expect(uiView.webContents.close).not.toHaveBeenCalled();
    });

    it("handles errors gracefully when view operations fail during cleanup", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const uiView = MockWebContentsViewClass.mock.results[0]!.value;
      const workspaceView = MockWebContentsViewClass.mock.results[1]!.value;

      // Simulate views throwing when accessing webContents (destroyed state)
      uiView.webContents.isDestroyed = vi.fn(() => {
        throw new Error("Object has been destroyed");
      });
      workspaceView.webContents.isDestroyed = vi.fn(() => {
        throw new Error("Object has been destroyed");
      });

      // Should not throw - errors should be caught
      expect(() => manager.destroy()).not.toThrow();
    });

    it("handles window being destroyed during cleanup", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const mockWindow = mockWindowManager.getWindow();
      // Simulate window being destroyed
      mockWindow.isDestroyed = vi.fn(() => true);

      // Should not throw
      expect(() => manager.destroy()).not.toThrow();

      // Reset for other tests
      mockWindow.isDestroyed = vi.fn(() => false);
    });
  });

  describe("ShortcutController integration", () => {
    beforeEach(() => {
      // Reset ShortcutController mock
      mockShortcutController.registerView.mockClear();
      mockShortcutController.unregisterView.mockClear();
      mockShortcutController.dispose.mockClear();
    });

    it("viewmanager-creates-controller: creates ShortcutController in factory", async () => {
      const { ShortcutController } = (await import("../shortcut-controller")) as unknown as {
        ShortcutController: ReturnType<typeof vi.fn>;
      };

      ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(ShortcutController).toHaveBeenCalledWith(mockWindowManager.getWindow(), {
        focusUI: expect.any(Function),
        getUIWebContents: expect.any(Function),
        setMode: expect.any(Function),
        getMode: expect.any(Function),
        onShortcut: expect.any(Function),
      });
    });

    it("viewmanager-registers-controller: createWorkspaceView registers with controller", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      expect(mockShortcutController.registerView).toHaveBeenCalled();
    });

    it("viewmanager-unregisters-controller: destroyWorkspaceView unregisters from controller", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.destroyWorkspaceView("/path/to/workspace");

      expect(mockShortcutController.unregisterView).toHaveBeenCalled();
    });

    it("viewmanager-disposes-controller: destroy calls controller.dispose", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.destroy();

      expect(mockShortcutController.dispose).toHaveBeenCalled();
    });

    it("viewmanager-no-preload: workspace views created without preload script", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Second call is for workspace view - should NOT have preload
      const workspaceViewConfig = MockWebContentsViewClass.mock.calls[1]?.[0] as {
        webPreferences?: { preload?: string };
      };
      expect(workspaceViewConfig.webPreferences?.preload).toBeUndefined();
    });
  });

  describe("setMode", () => {
    it("setMode-workspace-zindex: sets z-index to 0", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Set to dialog first to ensure we're changing state
      manager.setMode("dialog");
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.setMode("workspace");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      // Should be called with index 0 (adds to bottom)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        uiView,
        0
      );
    });

    it("setMode-workspace-focus: focuses active workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      workspaceView?.webContents.focus.mockClear();

      // Set to shortcut first, then back to workspace
      manager.setMode("shortcut");
      workspaceView?.webContents.focus.mockClear();

      manager.setMode("workspace");

      expect(workspaceView?.webContents.focus).toHaveBeenCalled();
    });

    it("setMode-shortcut-zindex: sets z-index to top so overlay is visible", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.setMode("shortcut");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      // Should move UI to top (addChildView without index = add to end = top)
      // This ensures the shortcut overlay is visible above workspace views
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(uiView);
    });

    it("setMode-shortcut-focuses-ui: focuses UI layer for keyboard event handling", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      uiView?.webContents.focus.mockClear();
      workspaceView?.webContents.focus.mockClear();

      manager.setMode("shortcut");

      // Should focus UI layer - it's always attached (never detached) so it reliably
      // receives before-input-event for Alt release detection. Workspace views can be
      // detached during navigation, which would cause Alt keyUp to be missed.
      expect(uiView?.webContents.focus).toHaveBeenCalled();
      expect(workspaceView?.webContents.focus).not.toHaveBeenCalled();
    });

    it("setMode-dialog-zindex: sets z-index to top", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.setMode("dialog");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      // Should be called without index parameter (adds to end = top)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(uiView);
    });

    it("setMode-dialog-no-focus-change: does not change focus", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      uiView?.webContents.focus.mockClear();
      workspaceView?.webContents.focus.mockClear();

      manager.setMode("dialog");

      // Should NOT call focus on either UI or workspace (no focus change)
      expect(uiView?.webContents.focus).not.toHaveBeenCalled();
      expect(workspaceView?.webContents.focus).not.toHaveBeenCalled();
    });

    it("setMode-idempotent: same mode is no-op (no event emitted)", () => {
      const onModeChange = vi.fn();
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );
      manager.onModeChange(onModeChange);

      // Set to shortcut
      manager.setMode("shortcut");
      expect(onModeChange).toHaveBeenCalledTimes(1);

      // Set to shortcut again
      manager.setMode("shortcut");
      // Should NOT emit again
      expect(onModeChange).toHaveBeenCalledTimes(1);
    });

    it("setMode-emits-event: emits event with mode and previousMode", () => {
      const onModeChange = vi.fn();
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );
      manager.onModeChange(onModeChange);

      manager.setMode("shortcut");

      expect(onModeChange).toHaveBeenCalledWith({
        mode: "shortcut",
        previousMode: "workspace",
      });
    });

    it("getMode-returns-current: returns current mode", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      expect(manager.getMode()).toBe("workspace");

      manager.setMode("shortcut");
      expect(manager.getMode()).toBe("shortcut");

      manager.setMode("dialog");
      expect(manager.getMode()).toBe("dialog");

      manager.setMode("hover");
      expect(manager.getMode()).toBe("hover");
    });

    it("setMode-hover-zindex: sets z-index to top", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      manager.setMode("hover");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      // Should be called without index parameter (adds to end = top)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(uiView);
    });

    it("setMode-hover-no-focus-change: does not change focus", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/workspace");

      const uiView = MockWebContentsViewClass.mock.results[0]?.value;
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      uiView?.webContents.focus.mockClear();
      workspaceView?.webContents.focus.mockClear();

      manager.setMode("hover");

      // Should NOT call focus on either UI or workspace (no focus change)
      expect(uiView?.webContents.focus).not.toHaveBeenCalled();
      expect(workspaceView?.webContents.focus).not.toHaveBeenCalled();
    });

    it("setActiveWorkspace-hover-mode-zorder: UI stays on top when in hover mode", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );
      const uiView = MockWebContentsViewClass.mock.results[0]?.value;

      manager.createWorkspaceView(
        "/path/to/workspace1",
        "http://localhost:8080/?folder=/path1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/workspace2",
        "http://localhost:8080/?folder=/path2",
        "/path/to/project"
      );

      // Enable hover mode
      manager.setMode("hover");

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/workspace1");

      // Clear calls
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Switch workspace while in hover mode
      manager.setActiveWorkspace("/path/to/workspace2");

      // UI layer should be re-added to top (hover mode maintains z-order)
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(uiView);
    });
  });

  describe("View Detachment Integration Tests", () => {
    it("integration-full-flow: create project → workspaces → switch → destroy", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create multiple workspaces (all detached by default)
      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://localhost:8080/?folder=/ws1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/ws2",
        "http://localhost:8080/?folder=/ws2",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/ws3",
        "http://localhost:8080/?folder=/ws3",
        "/path/to/project"
      );

      // Verify all views exist
      expect(manager.getWorkspaceView("/path/to/ws1")).toBeDefined();
      expect(manager.getWorkspaceView("/path/to/ws2")).toBeDefined();
      expect(manager.getWorkspaceView("/path/to/ws3")).toBeDefined();

      // Activate first workspace
      manager.setActiveWorkspace("/path/to/ws1");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws1");

      // Switch to second workspace
      manager.setActiveWorkspace("/path/to/ws2");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws2");

      // Destroy first workspace (now detached)
      manager.destroyWorkspaceView("/path/to/ws1");
      expect(manager.getWorkspaceView("/path/to/ws1")).toBeUndefined();
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws2"); // Still active

      // Destroy active workspace
      manager.destroyWorkspaceView("/path/to/ws2");
      expect(manager.getActiveWorkspacePath()).toBeNull();

      // Remaining workspace still accessible
      expect(manager.getWorkspaceView("/path/to/ws3")).toBeDefined();

      // Clean up
      manager.destroy();
    });

    it("integration-dialog-mode: dialog overlay works with detached workspaces", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create and activate workspace
      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://localhost:8080/?folder=/ws1",
        "/path/to/project"
      );
      manager.setActiveWorkspace("/path/to/ws1");

      // Enter dialog mode
      manager.setMode("dialog");

      // Verify workspace is still accessible
      expect(manager.getWorkspaceView("/path/to/ws1")).toBeDefined();

      // Create another workspace while in dialog mode
      manager.createWorkspaceView(
        "/path/to/ws2",
        "http://localhost:8080/?folder=/ws2",
        "/path/to/project"
      );

      // Switch workspace while in dialog mode
      manager.setActiveWorkspace("/path/to/ws2");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws2");

      // Exit dialog mode
      manager.setMode("workspace");

      // Workspace still works
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws2");

      manager.destroy();
    });

    it("integration-rapid-switching: multiple workspace switches in sequence", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create workspaces
      for (let i = 0; i < 5; i++) {
        manager.createWorkspaceView(
          `/path/to/ws${i}`,
          `http://localhost:8080/?folder=/ws${i}`,
          "/path/to/project"
        );
      }

      // Rapid switching - 10 times
      const paths = [
        "/path/to/ws0",
        "/path/to/ws3",
        "/path/to/ws1",
        "/path/to/ws4",
        "/path/to/ws2",
      ];
      for (let i = 0; i < 10; i++) {
        const path = paths[i % paths.length]!;
        manager.setActiveWorkspace(path);
        expect(manager.getActiveWorkspacePath()).toBe(path);
      }

      // Final state should be correct
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws2");

      // All views should still be accessible
      for (let i = 0; i < 5; i++) {
        expect(manager.getWorkspaceView(`/path/to/ws${i}`)).toBeDefined();
      }

      manager.destroy();
    });

    it("integration-multiple-cycles: view survives multiple attach/detach cycles", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/ws1",
        "http://localhost:8080/?folder=/ws1",
        "/path/to/project"
      );
      manager.createWorkspaceView(
        "/path/to/ws2",
        "http://localhost:8080/?folder=/ws2",
        "/path/to/project"
      );

      // Cycle between workspaces many times
      for (let i = 0; i < 20; i++) {
        const path = i % 2 === 0 ? "/path/to/ws1" : "/path/to/ws2";
        manager.setActiveWorkspace(path);
        expect(manager.getActiveWorkspacePath()).toBe(path);
      }

      // Both views should still exist
      expect(manager.getWorkspaceView("/path/to/ws1")).toBeDefined();
      expect(manager.getWorkspaceView("/path/to/ws2")).toBeDefined();

      // Deactivate all
      manager.setActiveWorkspace(null);
      expect(manager.getActiveWorkspacePath()).toBeNull();

      // Re-activate should still work
      manager.setActiveWorkspace("/path/to/ws1");
      expect(manager.getActiveWorkspacePath()).toBe("/path/to/ws1");

      manager.destroy();
    });
  });

  describe("onWorkspaceChange", () => {
    it("onWorkspaceChange-fires-on-change: callback called when workspace changes", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const onWorkspaceChange = vi.fn();
      manager.onWorkspaceChange(onWorkspaceChange);

      manager.setActiveWorkspace("/path/to/workspace");

      expect(onWorkspaceChange).toHaveBeenCalledTimes(1);
      expect(onWorkspaceChange).toHaveBeenCalledWith("/path/to/workspace");
    });

    it("onWorkspaceChange-fires-null: callback called with null when set to null", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // First activate a workspace
      manager.setActiveWorkspace("/path/to/workspace");

      const onWorkspaceChange = vi.fn();
      manager.onWorkspaceChange(onWorkspaceChange);

      // Then set to null
      manager.setActiveWorkspace(null);

      expect(onWorkspaceChange).toHaveBeenCalledTimes(1);
      expect(onWorkspaceChange).toHaveBeenCalledWith(null);
    });

    it("onWorkspaceChange-no-op: callback NOT fired when same workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      manager.setActiveWorkspace("/path/to/workspace");

      const onWorkspaceChange = vi.fn();
      manager.onWorkspaceChange(onWorkspaceChange);

      // Set to same workspace again
      manager.setActiveWorkspace("/path/to/workspace");

      expect(onWorkspaceChange).not.toHaveBeenCalled();
    });

    it("onWorkspaceChange-unsubscribe: unsubscribed callback not called", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const onWorkspaceChange = vi.fn();
      const unsubscribe = manager.onWorkspaceChange(onWorkspaceChange);

      // Unsubscribe before activation
      unsubscribe();

      manager.setActiveWorkspace("/path/to/workspace");

      expect(onWorkspaceChange).not.toHaveBeenCalled();
    });

    it("onWorkspaceChange-multiple: multiple callbacks all called", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      manager.onWorkspaceChange(callback1);
      manager.onWorkspaceChange(callback2);
      manager.onWorkspaceChange(callback3);

      manager.setActiveWorkspace("/path/to/workspace");

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledWith("/path/to/workspace");
      expect(callback2).toHaveBeenCalledWith("/path/to/workspace");
      expect(callback3).toHaveBeenCalledWith("/path/to/workspace");
    });

    it("onWorkspaceChange-error-handling: continues with other callbacks if one throws", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      const callback1 = vi.fn();
      const callback2 = vi.fn(() => {
        throw new Error("Test error");
      });
      const callback3 = vi.fn();

      manager.onWorkspaceChange(callback1);
      manager.onWorkspaceChange(callback2);
      manager.onWorkspaceChange(callback3);

      // Should not throw
      expect(() => manager.setActiveWorkspace("/path/to/workspace")).not.toThrow();

      // All callbacks should be called despite error
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();
    });
  });

  describe("Loading State", () => {
    it("isWorkspaceLoading-returns-false: existing workspace not loading by default", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Default: isNew = false (existing workspace loaded on startup)
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });

    it("isWorkspaceLoading-returns-true: new workspace is loading after creation", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(true);
    });

    it("existing-workspace-attaches-immediately: existing workspace attaches on activation", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Default: isNew = false (existing workspace loaded on startup)
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project"
      );

      // Clear calls from creation
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Activate existing workspace
      manager.setActiveWorkspace("/path/to/workspace");

      // View should be attached immediately (not loading)
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("isWorkspaceLoading-returns-false: workspace not loading after setWorkspaceLoaded", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });

    it("setWorkspaceLoaded-idempotent: safe to call multiple times", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Should not throw
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setWorkspaceLoaded("/path/to/workspace");
      manager.setWorkspaceLoaded("/path/to/workspace");

      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);
    });

    it("setWorkspaceLoaded-unknown-workspace: safe to call for non-loading workspace", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Should not throw
      expect(() => manager.setWorkspaceLoaded("/nonexistent")).not.toThrow();
    });

    it("loading-workspace-stays-detached: loading workspace stays detached when activated", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Clear calls from creation
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Activate workspace while loading
      manager.setActiveWorkspace("/path/to/workspace");

      // View should NOT be attached yet (workspace is loading)
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.addChildView).not.toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("loading-workspace-attaches-when-loaded: view attaches when setWorkspaceLoaded called", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Activate workspace while loading
      manager.setActiveWorkspace("/path/to/workspace");

      // Clear calls
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Mark as loaded
      manager.setWorkspaceLoaded("/path/to/workspace");

      // View should now be attached
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView
      );
    });

    it("loading-timeout: view attaches after timeout", async () => {
      vi.useFakeTimers();

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Activate workspace while loading
      manager.setActiveWorkspace("/path/to/workspace");

      // Clear calls
      mockWindowManager.getWindow().contentView.addChildView.mockClear();

      // Verify workspace is loading
      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(true);

      // Advance past timeout (10 seconds)
      await vi.advanceTimersByTimeAsync(11000);

      // Workspace should no longer be loading
      expect(manager.isWorkspaceLoading("/path/to/workspace")).toBe(false);

      // View should be attached
      const workspaceView = MockWebContentsViewClass.mock.results[1]?.value;
      expect(mockWindowManager.getWindow().contentView.addChildView).toHaveBeenCalledWith(
        workspaceView
      );

      vi.useRealTimers();
    });

    it("onLoadingChange-callback-fires: callback fires on loading state change", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const callback = vi.fn();
      manager.onLoadingChange(callback);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Should have been called with loading=true on creation
      expect(callback).toHaveBeenCalledWith("/path/to/workspace", true);

      callback.mockClear();

      manager.setWorkspaceLoaded("/path/to/workspace");

      // Should be called with loading=false on loaded
      expect(callback).toHaveBeenCalledWith("/path/to/workspace", false);
    });

    it("onLoadingChange-unsubscribe: unsubscribed callback not called", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const callback = vi.fn();
      const unsubscribe = manager.onLoadingChange(callback);

      unsubscribe();

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew - would trigger callback, but it was unsubscribed
      );

      expect(callback).not.toHaveBeenCalled();
    });

    it("onLoadingChange-ipc-payload: callback fires with correct payload for IPC emission", () => {
      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Track callback arguments to verify IPC payload structure
      const callbackArgs: Array<{ path: string; loading: boolean }> = [];
      manager.onLoadingChange((path, loading) => {
        callbackArgs.push({ path, loading });
      });

      // Create workspace - should trigger loading=true
      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      // Verify first callback has correct payload for IPC
      expect(callbackArgs).toHaveLength(1);
      expect(callbackArgs[0]).toEqual({
        path: "/path/to/workspace",
        loading: true,
      });

      // Set workspace loaded - should trigger loading=false
      manager.setWorkspaceLoaded("/path/to/workspace");

      // Verify second callback has correct payload for IPC
      expect(callbackArgs).toHaveLength(2);
      expect(callbackArgs[1]).toEqual({
        path: "/path/to/workspace",
        loading: false,
      });
    });

    it("multiple-workspace-switches-preserve-loading: loading states preserved independently", () => {
      vi.useFakeTimers();

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      // Create two workspaces (both start in loading state)
      manager.createWorkspaceView(
        "/path/to/workspaceA",
        "http://localhost:8080/?folder=/pathA",
        "/path/to/project",
        true // isNew
      );
      manager.createWorkspaceView(
        "/path/to/workspaceB",
        "http://localhost:8080/?folder=/pathB",
        "/path/to/project",
        true // isNew
      );

      // Both should be loading
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(true);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Activate workspace A (keep loading)
      manager.setActiveWorkspace("/path/to/workspaceA");
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(true);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Switch to workspace B (keep loading)
      manager.setActiveWorkspace("/path/to/workspaceB");
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(true);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Mark only workspace A as loaded
      manager.setWorkspaceLoaded("/path/to/workspaceA");
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(false);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Switch back to workspace A
      manager.setActiveWorkspace("/path/to/workspaceA");
      // A should still be not loading, B should still be loading
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(false);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Switch back to B
      manager.setActiveWorkspace("/path/to/workspaceB");
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(false);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(true);

      // Mark B as loaded
      manager.setWorkspaceLoaded("/path/to/workspaceB");
      expect(manager.isWorkspaceLoading("/path/to/workspaceA")).toBe(false);
      expect(manager.isWorkspaceLoading("/path/to/workspaceB")).toBe(false);

      vi.useRealTimers();
    });

    it("destroyWorkspaceView-clears-loading: loading state cleared on destroy", async () => {
      vi.useFakeTimers();

      const manager = ViewManager.create(
        mockWindowManager as unknown as WindowManager,
        {
          uiPreloadPath: "/path/to/preload.js",
          codeServerPort: 8080,
        },
        SILENT_LOGGER
      );

      const callback = vi.fn();
      manager.onLoadingChange(callback);

      manager.createWorkspaceView(
        "/path/to/workspace",
        "http://localhost:8080/?folder=/path",
        "/path/to/project",
        true // isNew
      );

      expect(callback).toHaveBeenCalledWith("/path/to/workspace", true);
      callback.mockClear();

      await manager.destroyWorkspaceView("/path/to/workspace");

      // Should fire loading=false callback
      expect(callback).toHaveBeenCalledWith("/path/to/workspace", false);

      // Advance time past timeout - should not cause errors (timeout was cleared)
      await vi.advanceTimersByTimeAsync(15000);

      vi.useRealTimers();
    });
  });
});
