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
    send: vi.fn(),
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

      const projects = exposedApi.projects as { open: (path?: string) => Promise<unknown> };
      const result = await projects.open("/test/path");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:open", {
        path: "/test/path",
      });
      expect(result).toEqual(mockProject);
    });

    it("projects.close calls api:project:close with projectPath", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const projects = exposedApi.projects as { close: (projectPath: string) => Promise<void> };
      await projects.close("/test/my-app");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:project:close", {
        projectPath: "/test/my-app",
      });
    });
  });

  describe("workspaces", () => {
    it("workspaces.remove calls api:workspace:remove", async () => {
      const mockResult = { started: true };
      mockIpcRenderer.invoke.mockResolvedValue(mockResult);

      const workspaces = exposedApi.workspaces as {
        remove: (
          workspacePath: string,
          options?: { keepBranch?: boolean; blockingPids?: readonly number[] }
        ) => Promise<unknown>;
      };
      const result = await workspaces.remove("/test/.worktrees/feature", { keepBranch: true });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:remove", {
        workspacePath: "/test/.worktrees/feature",
        keepBranch: true,
      });
      expect(result).toEqual(mockResult);
    });

    it("workspaces.getStatus calls api:workspace:get-status", async () => {
      const mockStatus = {
        isDirty: true,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };
      mockIpcRenderer.invoke.mockResolvedValue(mockStatus);

      const workspaces = exposedApi.workspaces as {
        getStatus: (workspacePath: string) => Promise<unknown>;
      };
      const result = await workspaces.getStatus("/test/.worktrees/feature");

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:workspace:get-status", {
        workspacePath: "/test/.worktrees/feature",
      });
      expect(result).toEqual(mockStatus);
    });
  });

  describe("ui", () => {
    it("ui.switchWorkspace calls api:ui:switch-workspace", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const ui = exposedApi.ui as {
        switchWorkspace: (workspacePath: string, focus?: boolean) => Promise<void>;
      };
      await ui.switchWorkspace("/test/.worktrees/feature", false);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:ui:switch-workspace", {
        workspacePath: "/test/.worktrees/feature",
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
    // Note: lifecycle.getState and lifecycle.setup tests removed - migrated to app:setup intent

    it("lifecycle.quit calls api:lifecycle:quit", async () => {
      mockIpcRenderer.invoke.mockResolvedValue(undefined);

      const lifecycle = exposedApi.lifecycle as { quit: () => Promise<void> };
      await lifecycle.quit();

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("api:lifecycle:quit");
    });
  });

  describe("emitEvent", () => {
    it("sends ui:event IPC event with the UiEvent payload", () => {
      const emitEvent = exposedApi.emitEvent as (event: unknown) => void;
      const event = { kind: "log", level: "info", logger: "ui", message: "hi" };
      emitEvent(event);

      expect(mockIpcRenderer.send).toHaveBeenCalledWith("api:ui:event", event);
    });
  });

  describe("sendDialogEvent", () => {
    it("sends dialog:event IPC event with dialog user event payload", () => {
      const sendDialogEvent = exposedApi.sendDialogEvent as (event: unknown) => void;
      const event = { dialogId: "dlg-1", actionId: "retry" };
      sendDialogEvent(event);

      expect(mockIpcRenderer.send).toHaveBeenCalledWith("api:dialog:event", event);
    });

    it("forwards a flat field-values data payload verbatim", () => {
      const sendDialogEvent = exposedApi.sendDialogEvent as (event: unknown) => void;
      const event = {
        dialogId: "dlg-2",
        actionId: "confirm",
        data: { agent: "claude", description: "hi" },
      };
      sendDialogEvent(event);

      expect(mockIpcRenderer.send).toHaveBeenCalledWith("api:dialog:event", event);
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
