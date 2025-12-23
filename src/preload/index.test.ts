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

  // ============================================================================
  // NOTE: Legacy setup commands (setupReady, setupRetry, setupQuit) and event
  // subscriptions (onSetupProgress, onSetupComplete, onSetupError) have been
  // removed. Setup is now handled via the v2 lifecycle API (lifecycle.getState,
  // lifecycle.setup, lifecycle.quit) and on("setup:progress", ...) events.
  // ============================================================================

  // ============================================================================
  // Flat API (api: prefixed channels)
  // ============================================================================

  describe("flat API namespaces", () => {
    it("exposes projects namespace on api", () => {
      expect(exposedApi.projects).toBeDefined();
      expect(typeof exposedApi.projects).toBe("object");
    });

    it("exposes workspaces namespace on api", () => {
      expect(exposedApi.workspaces).toBeDefined();
      expect(typeof exposedApi.workspaces).toBe("object");
    });

    it("exposes ui namespace on api", () => {
      expect(exposedApi.ui).toBeDefined();
      expect(typeof exposedApi.ui).toBe("object");
    });

    it("exposes lifecycle namespace on api", () => {
      expect(exposedApi.lifecycle).toBeDefined();
      expect(typeof exposedApi.lifecycle).toBe("object");
    });

    it("exposes on function on api", () => {
      expect(exposedApi.on).toBeDefined();
      expect(typeof exposedApi.on).toBe("function");
    });
  });

  describe("projects", () => {
    it("projects.open calls api:project:open with path", async () => {
      const mockProject = {
        id: "my-app-12345678",
        name: "my-app",
        path: "/test",
        workspaces: [],
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockProject);

      const projects = exposedApi.projects as { open: (path: string) => Promise<unknown> };
      const result = await projects.open("/test/path");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:open", {
        path: "/test/path",
      });
      expect(result).toEqual(mockProject);
    });

    it("projects.close calls api:project:close with projectId", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const projects = exposedApi.projects as { close: (projectId: string) => Promise<void> };
      await projects.close("my-app-12345678");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:close", {
        projectId: "my-app-12345678",
      });
    });

    it("projects.list calls api:project:list", async () => {
      const mockProjects = [
        { id: "my-app-12345678", name: "my-app", path: "/test", workspaces: [] },
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockProjects);

      const projects = exposedApi.projects as { list: () => Promise<unknown[]> };
      const result = await projects.list();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:list");
      expect(result).toEqual(mockProjects);
    });

    it("projects.get calls api:project:get with projectId", async () => {
      const mockProject = {
        id: "my-app-12345678",
        name: "my-app",
        path: "/test",
        workspaces: [],
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockProject);

      const projects = exposedApi.projects as { get: (projectId: string) => Promise<unknown> };
      const result = await projects.get("my-app-12345678");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:get", {
        projectId: "my-app-12345678",
      });
      expect(result).toEqual(mockProject);
    });

    it("projects.fetchBases calls api:project:fetch-bases with projectId", async () => {
      const mockBases = { bases: [{ name: "main", isRemote: false }] };
      mockIpcRenderer.invoke.mockResolvedValue(mockBases);

      const projects = exposedApi.projects as {
        fetchBases: (projectId: string) => Promise<unknown>;
      };
      const result = await projects.fetchBases("my-app-12345678");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:fetch-bases", {
        projectId: "my-app-12345678",
      });
      expect(result).toEqual(mockBases);
    });
  });

  describe("workspaces", () => {
    it("workspaces.create calls api:workspace:create", async () => {
      const mockWorkspace = {
        projectId: "my-app-12345678",
        name: "feature",
        branch: "feature",
        path: "/ws/feature",
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockWorkspace);

      const workspaces = exposedApi.workspaces as {
        create: (projectId: string, name: string, base: string) => Promise<unknown>;
      };
      const result = await workspaces.create("my-app-12345678", "feature", "main");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:create", {
        projectId: "my-app-12345678",
        name: "feature",
        base: "main",
      });
      expect(result).toEqual(mockWorkspace);
    });

    it("workspaces.remove calls api:workspace:remove", async () => {
      const mockResult = { branchDeleted: false };
      mockIpcRenderer.invoke.mockResolvedValue(mockResult);

      const workspaces = exposedApi.workspaces as {
        remove: (
          projectId: string,
          workspaceName: string,
          keepBranch?: boolean
        ) => Promise<unknown>;
      };
      const result = await workspaces.remove("my-app-12345678", "feature", true);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:remove", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
        keepBranch: true,
      });
      expect(result).toEqual(mockResult);
    });

    it("workspaces.get calls api:workspace:get", async () => {
      const mockWorkspace = {
        projectId: "my-app-12345678",
        name: "feature",
        branch: "feature",
        path: "/ws/feature",
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockWorkspace);

      const workspaces = exposedApi.workspaces as {
        get: (projectId: string, workspaceName: string) => Promise<unknown>;
      };
      const result = await workspaces.get("my-app-12345678", "feature");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
      });
      expect(result).toEqual(mockWorkspace);
    });

    it("workspaces.getStatus calls api:workspace:get-status", async () => {
      const mockStatus = {
        isDirty: true,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockStatus);

      const workspaces = exposedApi.workspaces as {
        getStatus: (projectId: string, workspaceName: string) => Promise<unknown>;
      };
      const result = await workspaces.getStatus("my-app-12345678", "feature");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get-status", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
      });
      expect(result).toEqual(mockStatus);
    });

    it("workspaces.getOpencodePort should invoke WORKSPACE_GET_OPENCODE_PORT IPC channel", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(12345);

      const workspaces = exposedApi.workspaces as {
        getOpencodePort: (projectId: string, workspaceName: string) => Promise<number | null>;
      };
      await workspaces.getOpencodePort("my-app-12345678", "feature");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get-opencode-port", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
      });
    });

    it("workspaces.getOpencodePort should pass projectId and workspaceName parameters", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(54321);

      const workspaces = exposedApi.workspaces as {
        getOpencodePort: (projectId: string, workspaceName: string) => Promise<number | null>;
      };
      await workspaces.getOpencodePort("other-project-aaaabbbb", "main-workspace");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get-opencode-port", {
        projectId: "other-project-aaaabbbb",
        workspaceName: "main-workspace",
      });
    });

    it("workspaces.getOpencodePort should return IPC result", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(null);

      const workspaces = exposedApi.workspaces as {
        getOpencodePort: (projectId: string, workspaceName: string) => Promise<number | null>;
      };
      const result = await workspaces.getOpencodePort("my-app-12345678", "feature");

      expect(result).toBeNull();
    });

    it("workspaces.setMetadata calls api:workspace:set-metadata", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const workspaces = exposedApi.workspaces as {
        setMetadata: (
          projectId: string,
          workspaceName: string,
          key: string,
          value: string | null
        ) => Promise<void>;
      };
      await workspaces.setMetadata("my-app-12345678", "feature", "note", "test value");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:set-metadata", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
        key: "note",
        value: "test value",
      });
    });

    it("workspaces.getMetadata calls api:workspace:get-metadata and returns parsed result", async () => {
      const mockMetadata = { base: "main", note: "WIP" };
      mockIpcRenderer.invoke.mockResolvedValue(mockMetadata);

      const workspaces = exposedApi.workspaces as {
        getMetadata: (projectId: string, workspaceName: string) => Promise<Record<string, string>>;
      };
      const result = await workspaces.getMetadata("my-app-12345678", "feature");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get-metadata", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
      });
      expect(result).toEqual(mockMetadata);
    });
  });

  describe("ui", () => {
    it("ui.selectFolder calls api:ui:select-folder", async () => {
      mockIpcRenderer.invoke.mockResolvedValue("/selected/path");

      const ui = exposedApi.ui as { selectFolder: () => Promise<string | null> };
      const result = await ui.selectFolder();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:ui:select-folder");
      expect(result).toBe("/selected/path");
    });

    it("ui.getActiveWorkspace calls api:ui:get-active-workspace", async () => {
      const mockRef = {
        projectId: "my-app-12345678",
        workspaceName: "feature",
        path: "/ws/feature",
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockRef);

      const ui = exposedApi.ui as { getActiveWorkspace: () => Promise<unknown> };
      const result = await ui.getActiveWorkspace();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:ui:get-active-workspace");
      expect(result).toEqual(mockRef);
    });

    it("ui.switchWorkspace calls api:ui:switch-workspace", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const ui = exposedApi.ui as {
        switchWorkspace: (
          projectId: string,
          workspaceName: string,
          focus?: boolean
        ) => Promise<void>;
      };
      await ui.switchWorkspace("my-app-12345678", "feature", false);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:ui:switch-workspace", {
        projectId: "my-app-12345678",
        workspaceName: "feature",
        focus: false,
      });
    });

    it("ui.setMode calls api:ui:set-mode", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const ui = exposedApi.ui as { setMode: (mode: string) => Promise<void> };
      await ui.setMode("shortcut");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:ui:set-mode", {
        mode: "shortcut",
      });
    });

    it("onModeChange subscribes to api:ui:mode-changed and returns unsubscribe", () => {
      const callback = vi.fn();

      const onModeChange = exposedApi.onModeChange as (cb: () => void) => () => void;
      const unsubscribe = onModeChange(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("api:ui:mode-changed", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "api:ui:mode-changed",
        expect.any(Function)
      );
    });

    it("onShortcut subscribes to api:shortcut:key and returns unsubscribe", () => {
      const callback = vi.fn();

      const onShortcut = exposedApi.onShortcut as (cb: (key: string) => void) => () => void;
      const unsubscribe = onShortcut(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("api:shortcut:key", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "api:shortcut:key",
        expect.any(Function)
      );
    });
  });

  describe("lifecycle", () => {
    it("lifecycle.getState calls api:lifecycle:get-state", async () => {
      mockIpcRenderer.invoke.mockResolvedValue("ready");

      const lifecycle = exposedApi.lifecycle as { getState: () => Promise<string> };
      const result = await lifecycle.getState();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:lifecycle:get-state");
      expect(result).toBe("ready");
    });

    it("lifecycle.setup calls api:lifecycle:setup", async () => {
      mockIpcRenderer.invoke.mockResolvedValue({ success: true });

      const lifecycle = exposedApi.lifecycle as { setup: () => Promise<unknown> };
      const result = await lifecycle.setup();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:lifecycle:setup");
      expect(result).toEqual({ success: true });
    });

    it("lifecycle.quit calls api:lifecycle:quit", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const lifecycle = exposedApi.lifecycle as { quit: () => Promise<void> };
      await lifecycle.quit();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:lifecycle:quit");
    });
  });

  describe("event subscriptions", () => {
    it("on subscribes to api: prefixed events", () => {
      const callback = vi.fn();

      const on = exposedApi.on as (event: string, cb: () => void) => () => void;
      const unsubscribe = on("project:opened", callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("api:project:opened", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "api:project:opened",
        expect.any(Function)
      );
    });
  });
});
