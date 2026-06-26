// @vitest-environment node
/**
 * Integration tests for NotificationManager (a state-holder owned by the
 * presenter). It exposes a render-ready snapshot and notifies on every change;
 * the presenter folds getSnapshot() into the ui:state push.
 */

import { describe, it, expect, vi } from "vitest";
import { NotificationManager } from "./sessions";
import type { NotificationConfig, NotificationUserEvent } from "../../shared/notification-types";

const CONFIG: NotificationConfig = {
  type: "info",
  title: "Test",
  message: "Test message",
  dismissible: true,
};

function createManager() {
  const notifyChange = vi.fn<() => void>();
  const manager = new NotificationManager(notifyChange);
  return { manager, notifyChange };
}

describe("NotificationManager", () => {
  it("adds an opened notification to the snapshot and notifies", () => {
    const { manager, notifyChange } = createManager();

    const handle = manager.open(CONFIG);

    expect(notifyChange).toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual([{ id: handle.id, config: CONFIG }]);
  });

  it("replaces the config on update", () => {
    const { manager, notifyChange } = createManager();
    const handle = manager.open(CONFIG);
    notifyChange.mockClear();

    const updated: NotificationConfig = { ...CONFIG, title: "Updated" };
    handle.update(updated);

    expect(notifyChange).toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual([{ id: handle.id, config: updated }]);
  });

  it("removes a closed notification from the snapshot", () => {
    const { manager } = createManager();
    const transient = manager.open(CONFIG);
    const survivor = manager.open(CONFIG);

    transient.close();

    expect(manager.getSnapshot()).toEqual([{ id: survivor.id, config: CONFIG }]);
  });

  it("does nothing after close", () => {
    const { manager, notifyChange } = createManager();
    const handle = manager.open(CONFIG);
    handle.close();
    notifyChange.mockClear();

    handle.update({ ...CONFIG, title: "After close" });

    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("preserves open order in the snapshot", () => {
    const { manager } = createManager();
    const a = manager.open({ ...CONFIG, title: "A" });
    const b = manager.open({ ...CONFIG, title: "B" });

    expect(manager.getSnapshot().map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it("routes user events to the owning handle", () => {
    const { manager } = createManager();
    const handle = manager.open(CONFIG);
    const listener = vi.fn();
    handle.onEvent(listener);

    const event: NotificationUserEvent = { notificationId: handle.id, actionId: "dismiss" };
    manager.routeEvent(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it("does not throw routing to an unknown notification", () => {
    const { manager } = createManager();
    expect(() => manager.routeEvent({ notificationId: "nope", actionId: "x" })).not.toThrow();
  });
});
