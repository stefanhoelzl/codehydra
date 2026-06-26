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
    // The surface is exactly two channels now: emitEvent (api:ui:event, up) and
    // onState (api:ui:state, down). No command invokes, no per-feature events,
    // no theme channel, no generic on().
    it("exposes exactly emitEvent + onState", () => {
      expect(typeof exposedApi.emitEvent).toBe("function");
      expect(typeof exposedApi.onState).toBe("function");
      expect(Object.keys(exposedApi).sort()).toEqual(["emitEvent", "onState"]);
    });

    it("does not expose removed surface (commands, on, onTheme)", () => {
      expect(exposedApi.projects).toBeUndefined();
      expect(exposedApi.workspaces).toBeUndefined();
      expect(exposedApi.ui).toBeUndefined();
      expect(exposedApi.on).toBeUndefined();
      expect(exposedApi.onTheme).toBeUndefined();
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

  describe("event subscriptions", () => {
    it("onState subscribes to the api:ui:state snapshot channel", () => {
      const callback = vi.fn();

      const onState = exposedApi.onState as (cb: () => void) => () => void;
      const unsubscribe = onState(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith("api:ui:state", expect.any(Function));
      expect(unsubscribe).toBeInstanceOf(Function);

      unsubscribe();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        "api:ui:state",
        expect.any(Function)
      );
    });
  });
});
