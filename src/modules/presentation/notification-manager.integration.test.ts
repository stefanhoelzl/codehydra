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
    expect(manager.getSnapshot()).toEqual([{ id: handle.id, config: CONFIG, count: 1 }]);
  });

  it("replaces the config on update", () => {
    const { manager, notifyChange } = createManager();
    const handle = manager.open(CONFIG);
    notifyChange.mockClear();

    const updated: NotificationConfig = { ...CONFIG, title: "Updated" };
    handle.update(updated);

    expect(notifyChange).toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual([{ id: handle.id, config: updated, count: 1 }]);
  });

  it("removes a closed notification from the snapshot", () => {
    const { manager } = createManager();
    const transient = manager.open({ ...CONFIG, title: "Transient" });
    const survivor = manager.open({ ...CONFIG, title: "Survivor" });

    transient.close();

    expect(manager.getSnapshot()).toEqual([
      { id: survivor.id, config: { ...CONFIG, title: "Survivor" }, count: 1 },
    ]);
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

  describe("collapsing repeats", () => {
    it("collapses identical opens into one card with a rising count", () => {
      const { manager } = createManager();

      // The shape that flooded the sidebar: an auto-workspace create failing on
      // the same branch collision once a minute for hours.
      const first = manager.open(CONFIG);
      const again = manager.open(CONFIG);

      expect(again.id).toBe(first.id);
      expect(manager.getSnapshot()).toEqual([{ id: first.id, config: CONFIG, count: 2 }]);
    });

    it("keeps notifications that differ in any visible field apart", () => {
      const { manager } = createManager();

      manager.open(CONFIG);
      manager.open({ ...CONFIG, title: "Other" });
      manager.open({ ...CONFIG, message: "Other message" });
      manager.open({ ...CONFIG, type: "error" });
      manager.open({ ...CONFIG, dismissible: false });
      manager.open({ ...CONFIG, actions: [{ id: "go", label: "Go" }] });

      expect(manager.getSnapshot()).toHaveLength(6);
    });

    it("ignores progress, which is a measurement rather than an identity", () => {
      const { manager } = createManager();
      const spinner: NotificationConfig = { type: "spinner", title: "Working" };

      manager.open({ ...spinner, progress: 0.1 });
      manager.open({ ...spinner, progress: 0.9 });

      expect(manager.getSnapshot()).toHaveLength(1);
    });

    it("re-files a card on update, so it no longer swallows its original text", () => {
      const { manager } = createManager();
      const moved = manager.open(CONFIG);

      moved.update({ ...CONFIG, title: "Moved on" });
      const fresh = manager.open(CONFIG);

      expect(fresh.id).not.toBe(moved.id);
      expect(manager.getSnapshot().map((n) => n.count)).toEqual([1, 1]);
    });

    it("matches a card by what it now says", () => {
      const { manager } = createManager();
      const moved = manager.open(CONFIG);
      moved.update({ ...CONFIG, title: "Moved on" });

      const same = manager.open({ ...CONFIG, title: "Moved on" });

      expect(same.id).toBe(moved.id);
      expect(manager.getSnapshot()).toHaveLength(1);
    });

    it("closes on the last hold, not the first", () => {
      const { manager } = createManager();
      // Two clones of different URLs must not take each other's card down; they
      // stay apart by their text, but a card that did collapse is held by both.
      const a = manager.open(CONFIG);
      manager.open(CONFIG);

      a.close();
      expect(manager.getSnapshot()).toEqual([{ id: a.id, config: CONFIG, count: 1 }]);

      a.close();
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("lets a dismiss retire the whole card, however many opens it stands for", () => {
      const { manager } = createManager();
      const handle = manager.open(CONFIG);
      manager.open(CONFIG);
      manager.open(CONFIG);
      handle.onEvent(() => {
        handle.close();
      });

      manager.routeEvent({ notificationId: handle.id, actionId: "dismiss" });

      expect(manager.getSnapshot()).toEqual([]);
    });

    it("opens a fresh card once the collapsed one is gone", () => {
      const { manager } = createManager();
      const first = manager.open(CONFIG);
      first.close();

      const second = manager.open(CONFIG);

      expect(second.id).not.toBe(first.id);
      expect(manager.getSnapshot()).toEqual([{ id: second.id, config: CONFIG, count: 1 }]);
    });
  });
});
