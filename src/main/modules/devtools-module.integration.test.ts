// @vitest-environment node
/**
 * Integration tests for DevtoolsModule.
 *
 * Tests DevTools toggling via shortcut:key-pressed domain event subscription.
 */

import { describe, it, expect, vi } from "vitest";
import { createDevtoolsModule, type DevtoolsModuleDeps } from "./devtools-module";
import {
  EVENT_SHORTCUT_KEY_PRESSED,
  type ShortcutKeyPressedEvent,
} from "../operations/shortcut-key";
import type { ViewHandle } from "../../services/shell/types";

// =============================================================================
// Helpers
// =============================================================================

function createViewHandle(id: string): ViewHandle {
  return { id, __brand: "ViewHandle" as const };
}

function createMockDeps() {
  const uiHandle = createViewHandle("ui-view");
  const wsHandle = createViewHandle("ws-view");
  let activePath: string | null = "/test/workspace";

  const viewLayer = {
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn().mockReturnValue(false),
  };

  const viewManager = {
    getUIViewHandle: vi.fn().mockReturnValue(uiHandle),
    getWorkspaceView: vi.fn(() => wsHandle),
    getActiveWorkspacePath: vi.fn(() => activePath),
  };

  return {
    viewLayer,
    viewManager: viewManager as unknown as DevtoolsModuleDeps["viewManager"],
    uiHandle,
    wsHandle,
    _setActivePath(path: string | null) {
      activePath = path;
    },
  };
}

function emitKeyEvent(module: ReturnType<typeof createDevtoolsModule>, key: string): void {
  const event: ShortcutKeyPressedEvent = {
    type: EVENT_SHORTCUT_KEY_PRESSED,
    payload: { key },
  };
  module.events![EVENT_SHORTCUT_KEY_PRESSED]!(event);
}

// =============================================================================
// Tests
// =============================================================================

describe("DevtoolsModule", () => {
  it("D toggles UI DevTools open", () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "d");

    expect(mock.viewLayer.openDevTools).toHaveBeenCalledWith(mock.uiHandle, { mode: "detach" });
  });

  it("D toggles UI DevTools closed when already open", () => {
    const mock = createMockDeps();
    mock.viewLayer.isDevToolsOpened.mockReturnValue(true);
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "d");

    expect(mock.viewLayer.closeDevTools).toHaveBeenCalledWith(mock.uiHandle);
    expect(mock.viewLayer.openDevTools).not.toHaveBeenCalled();
  });

  it("W toggles active workspace DevTools open", () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "w");

    expect(mock.viewLayer.openDevTools).toHaveBeenCalledWith(mock.wsHandle, { mode: "detach" });
  });

  it("W toggles workspace DevTools closed when already open", () => {
    const mock = createMockDeps();
    mock.viewLayer.isDevToolsOpened.mockReturnValue(true);
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "w");

    expect(mock.viewLayer.closeDevTools).toHaveBeenCalledWith(mock.wsHandle);
  });

  it("W does nothing when no active workspace", () => {
    const mock = createMockDeps();
    mock._setActivePath(null);
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "w");

    expect(mock.viewLayer.openDevTools).not.toHaveBeenCalled();
    expect(mock.viewLayer.closeDevTools).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys", () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    emitKeyEvent(module, "up");
    emitKeyEvent(module, "enter");
    emitKeyEvent(module, "5");

    expect(mock.viewLayer.openDevTools).not.toHaveBeenCalled();
    expect(mock.viewLayer.closeDevTools).not.toHaveBeenCalled();
  });
});
