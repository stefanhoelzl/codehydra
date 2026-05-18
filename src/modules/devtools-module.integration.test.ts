// @vitest-environment node
/**
 * Integration tests for DevtoolsModule.
 *
 * Tests DevTools toggling via shortcut:key-pressed domain event subscription.
 */

import { describe, it, expect, vi } from "vitest";
import { createDevtoolsModule, type DevtoolsModuleDeps } from "./devtools-module";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import type { DevtoolsTarget } from "../boundaries/shell/view-manager-types";

// =============================================================================
// Helpers
// =============================================================================

function createDevtoolsTarget(id: string) {
  let open = false;
  const toggle = vi.fn(() => {
    open = !open;
  });
  const isOpen = vi.fn(() => open);
  const target: DevtoolsTarget & { _setOpen: (v: boolean) => void } = {
    id,
    toggle,
    isOpen,
    _setOpen: (v: boolean) => {
      open = v;
    },
  };
  return target;
}

function createMockDeps() {
  const uiTarget = createDevtoolsTarget("ui-view");
  const wsTarget = createDevtoolsTarget("ws-view");
  let hasActive = true;

  const viewManager = {
    getUIDevtoolsTarget: vi.fn(() => uiTarget),
    getActiveWorkspaceDevtoolsTarget: vi.fn(() => (hasActive ? wsTarget : undefined)),
  };

  return {
    viewManager: viewManager as unknown as DevtoolsModuleDeps["viewManager"],
    uiTarget,
    wsTarget,
    _setActivePath(path: string | null) {
      hasActive = path !== null;
    },
  };
}

async function emitKeyEvent(
  module: ReturnType<typeof createDevtoolsModule>,
  key: string
): Promise<void> {
  const event: ShortcutKeyPressedEvent = {
    type: EVENT_SHORTCUT_KEY_PRESSED,
    payload: { key },
  };
  await module.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);
}

// =============================================================================
// Tests
// =============================================================================

describe("DevtoolsModule", () => {
  it("D toggles UI DevTools open", async () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "d");

    expect(mock.uiTarget.toggle).toHaveBeenCalledTimes(1);
    expect(mock.uiTarget.isOpen()).toBe(true);
  });

  it("D toggles UI DevTools closed when already open", async () => {
    const mock = createMockDeps();
    mock.uiTarget._setOpen(true);
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "d");

    expect(mock.uiTarget.toggle).toHaveBeenCalledTimes(1);
    expect(mock.uiTarget.isOpen()).toBe(false);
  });

  it("W toggles active workspace DevTools open", async () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "w");

    expect(mock.wsTarget.toggle).toHaveBeenCalledTimes(1);
    expect(mock.wsTarget.isOpen()).toBe(true);
  });

  it("W toggles workspace DevTools closed when already open", async () => {
    const mock = createMockDeps();
    mock.wsTarget._setOpen(true);
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "w");

    expect(mock.wsTarget.toggle).toHaveBeenCalledTimes(1);
    expect(mock.wsTarget.isOpen()).toBe(false);
  });

  it("W does nothing when no active workspace", async () => {
    const mock = createMockDeps();
    mock._setActivePath(null);
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "w");

    expect(mock.wsTarget.toggle).not.toHaveBeenCalled();
    expect(mock.uiTarget.toggle).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys", async () => {
    const mock = createMockDeps();
    const module = createDevtoolsModule(mock);

    await emitKeyEvent(module, "up");
    await emitKeyEvent(module, "enter");
    await emitKeyEvent(module, "5");

    expect(mock.uiTarget.toggle).not.toHaveBeenCalled();
    expect(mock.wsTarget.toggle).not.toHaveBeenCalled();
  });
});
