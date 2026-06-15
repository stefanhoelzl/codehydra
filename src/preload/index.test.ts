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
  // removed. Setup is driven by the main process and the renderer answers via
  // ui:events (agent-selected / setup-retry / setup-quit).
  // ============================================================================

  // ============================================================================
  // Flat API (api: prefixed channels)
  // ============================================================================

  describe("flat API namespaces", () => {
    // Renderer→main gestures (open/switch/wake/hibernate/quit) are ui:events
    // now, not invoke namespaces — there are no command invokes.
    it("exposes on function on api", () => {
      expect(exposedApi.on).toBeDefined();
      expect(typeof exposedApi.on).toBe("function");
    });

    it("does not expose the removed command namespaces", () => {
      expect(exposedApi.projects).toBeUndefined();
      expect(exposedApi.workspaces).toBeUndefined();
      expect(exposedApi.ui).toBeUndefined();
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
