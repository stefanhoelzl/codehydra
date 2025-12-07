/**
 * Tests for the preload API.
 *
 * Note: These tests mock the Electron modules since they're not available
 * in the test environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to create mocks that are available during module hoisting
const { mockIpcRenderer, mockContextBridge } = vi.hoisted(() => ({
  mockIpcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  mockContextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcRenderer: mockIpcRenderer,
  contextBridge: mockContextBridge,
}));

// Import after mocking - this triggers the preload which calls exposeInMainWorld
import "../preload/index";

// Capture the API that was exposed during import (before any tests run)
const [exposedName, exposedApi] = mockContextBridge.exposeInMainWorld.mock.calls[0] as [
  string,
  Record<string, unknown>,
];

describe("preload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes api on window.api", () => {
    expect(exposedName).toBe("api");
    expect(exposedApi).toBeDefined();
  });

  describe("commands", () => {
    it("selectFolder calls ipcRenderer.invoke with project:select-folder", async () => {
      mockIpcRenderer.invoke.mockResolvedValue("/some/path");

      const selectFolder = exposedApi.selectFolder as () => Promise<string | null>;
      const result = await selectFolder();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("project:select-folder");
      expect(result).toBe("/some/path");
    });

    it("openProject calls ipcRenderer.invoke with channel and path", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const openProject = exposedApi.openProject as (path: string) => Promise<void>;
      await openProject("/project/path");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("project:open", {
        path: "/project/path",
      });
    });

    it("closeProject calls ipcRenderer.invoke with channel and path", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const closeProject = exposedApi.closeProject as (path: string) => Promise<void>;
      await closeProject("/project/path");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("project:close", {
        path: "/project/path",
      });
    });

    it("listProjects calls ipcRenderer.invoke with project:list", async () => {
      const mockProjects = [{ path: "/test", name: "test", workspaces: [] }];
      mockIpcRenderer.invoke.mockResolvedValue(mockProjects);

      const listProjects = exposedApi.listProjects as () => Promise<unknown[]>;
      const result = await listProjects();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("project:list");
      expect(result).toEqual(mockProjects);
    });

    it("createWorkspace calls ipcRenderer.invoke with correct payload", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const createWorkspace = exposedApi.createWorkspace as (
        projectPath: string,
        name: string,
        baseBranch: string
      ) => Promise<void>;
      await createWorkspace("/project", "feature-1", "main");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:create", {
        projectPath: "/project",
        name: "feature-1",
        baseBranch: "main",
      });
    });

    it("removeWorkspace calls ipcRenderer.invoke with correct payload", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const removeWorkspace = exposedApi.removeWorkspace as (
        workspacePath: string,
        deleteBranch: boolean
      ) => Promise<void>;
      await removeWorkspace("/project/.worktrees/feature-1", true);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:remove", {
        workspacePath: "/project/.worktrees/feature-1",
        deleteBranch: true,
      });
    });

    it("switchWorkspace calls ipcRenderer.invoke with workspacePath and default focus", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const switchWorkspace = exposedApi.switchWorkspace as (
        workspacePath: string,
        focusWorkspace?: boolean
      ) => Promise<void>;
      await switchWorkspace("/project/.worktrees/feature-1");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:switch", {
        workspacePath: "/project/.worktrees/feature-1",
        focusWorkspace: undefined,
      });
    });

    it("switchWorkspace passes focusWorkspace=false when specified", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const switchWorkspace = exposedApi.switchWorkspace as (
        workspacePath: string,
        focusWorkspace?: boolean
      ) => Promise<void>;
      await switchWorkspace("/project/.worktrees/feature-1", false);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:switch", {
        workspacePath: "/project/.worktrees/feature-1",
        focusWorkspace: false,
      });
    });

    it("listBases calls ipcRenderer.invoke with projectPath", async () => {
      const mockBases = [{ name: "main", isRemote: false }];
      mockIpcRenderer.invoke.mockResolvedValue(mockBases);

      const listBases = exposedApi.listBases as (projectPath: string) => Promise<unknown[]>;
      const result = await listBases("/project");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:list-bases", {
        projectPath: "/project",
      });
      expect(result).toEqual(mockBases);
    });

    it("updateBases calls ipcRenderer.invoke with projectPath", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const updateBases = exposedApi.updateBases as (projectPath: string) => Promise<void>;
      await updateBases("/project");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:update-bases", {
        projectPath: "/project",
      });
    });

    it("isWorkspaceDirty calls ipcRenderer.invoke with workspacePath", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(true);

      const isWorkspaceDirty = exposedApi.isWorkspaceDirty as (
        workspacePath: string
      ) => Promise<boolean>;
      const result = await isWorkspaceDirty("/project/.worktrees/feature-1");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("workspace:is-dirty", {
        workspacePath: "/project/.worktrees/feature-1",
      });
      expect(result).toBe(true);
    });

    it("setDialogMode calls ipcRenderer.invoke with correct channel and payload", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const setDialogMode = exposedApi.setDialogMode as (isOpen: boolean) => Promise<void>;
      await setDialogMode(true);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("ui:set-dialog-mode", { isOpen: true });
    });

    it("focusActiveWorkspace calls ipcRenderer.invoke with correct channel", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const focusActiveWorkspace = exposedApi.focusActiveWorkspace as () => Promise<void>;
      await focusActiveWorkspace();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("ui:focus-active-workspace");
    });
  });

  describe("event subscriptions", () => {
    it("onProjectOpened subscribes to project:opened and returns unsubscribe", () => {
      const callback = vi.fn();

      const onProjectOpened = exposedApi.onProjectOpened as (cb: () => void) => () => void;
      const unsubscribe = onProjectOpened(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("project:opened", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      // Test unsubscribe removes listener
      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "project:opened",
        expect.any(Function)
      );
    });

    it("onProjectClosed subscribes to project:closed and returns unsubscribe", () => {
      const callback = vi.fn();

      const onProjectClosed = exposedApi.onProjectClosed as (cb: () => void) => () => void;
      const unsubscribe = onProjectClosed(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("project:closed", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "project:closed",
        expect.any(Function)
      );
    });

    it("onWorkspaceCreated subscribes and returns unsubscribe", () => {
      const callback = vi.fn();

      const onWorkspaceCreated = exposedApi.onWorkspaceCreated as (cb: () => void) => () => void;
      const unsubscribe = onWorkspaceCreated(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("workspace:created", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "workspace:created",
        expect.any(Function)
      );
    });

    it("onWorkspaceRemoved subscribes and returns unsubscribe", () => {
      const callback = vi.fn();

      const onWorkspaceRemoved = exposedApi.onWorkspaceRemoved as (cb: () => void) => () => void;
      const unsubscribe = onWorkspaceRemoved(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("workspace:removed", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "workspace:removed",
        expect.any(Function)
      );
    });

    it("onWorkspaceSwitched subscribes and returns unsubscribe", () => {
      const callback = vi.fn();

      const onWorkspaceSwitched = exposedApi.onWorkspaceSwitched as (cb: () => void) => () => void;
      const unsubscribe = onWorkspaceSwitched(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("workspace:switched", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "workspace:switched",
        expect.any(Function)
      );
    });

    it("event callbacks receive data from IPC event", () => {
      const callback = vi.fn();
      const mockEventData = { project: { path: "/test", name: "test", workspaces: [] } };

      // Capture the handler passed to ipcRenderer.on
      mockIpcRenderer.on.mockImplementation((_channel, handler) => {
        // Simulate IPC event
        handler({}, mockEventData);
      });

      const onProjectOpened = exposedApi.onProjectOpened as (
        cb: (data: unknown) => void
      ) => () => void;
      onProjectOpened(callback);

      expect(callback).toHaveBeenCalledWith(mockEventData);
    });

    describe("onShortcutEnable", () => {
      it("preload-subscription-exists: onShortcutEnable exists on exposed API", () => {
        expect(exposedApi.onShortcutEnable).toBeDefined();
        expect(typeof exposedApi.onShortcutEnable).toBe("function");
      });

      it("preload-subscription-cleanup: returns cleanup function", () => {
        const callback = vi.fn();
        const onShortcutEnable = exposedApi.onShortcutEnable as (cb: () => void) => () => void;
        const unsubscribe = onShortcutEnable(callback);

        expect(mockIpcRenderer.on).toHaveBeenCalledWith("shortcut:enable", expect.any(Function));
        expect(unsubscribe).toBeInstanceOf(Function);

        unsubscribe();
        expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
          "shortcut:enable",
          expect.any(Function)
        );
      });

      it("preload-subscription-callback: callback invoked on event with no arguments", () => {
        const callback = vi.fn();

        // Capture the handler passed to ipcRenderer.on
        mockIpcRenderer.on.mockImplementation((_channel, handler) => {
          // Simulate IPC event with no data
          handler({});
        });

        const onShortcutEnable = exposedApi.onShortcutEnable as (cb: () => void) => () => void;
        onShortcutEnable(callback);

        // Callback should be invoked with no arguments
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(undefined);
      });
    });
  });

  describe("error handling", () => {
    it("api functions propagate IPC errors to caller", async () => {
      const error = new Error("IPC error");
      mockIpcRenderer.invoke.mockRejectedValue(error);

      const openProject = exposedApi.openProject as (path: string) => Promise<void>;
      await expect(openProject("/project")).rejects.toThrow("IPC error");
    });
  });
});
