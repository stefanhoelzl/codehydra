// @vitest-environment node
/**
 * Integration tests for NotificationManager (a state-holder owned by the
 * presenter, and the state behind notification:show / notification:close). It
 * exposes a snapshot and notifies on every change; the presenter folds
 * getSnapshot() into the ui:state push.
 */

import { describe, it, expect, vi } from "vitest";
import { NotificationManager } from "./sessions";
import { ApiError } from "../../api/errors";
import type { NotificationConfig } from "../../shared/notification-types";

const CONFIG: NotificationConfig = {
  type: "info",
  title: "Test",
  message: "Test message",
  dismissible: true,
};

const QUESTION: NotificationConfig = {
  type: "info",
  title: "Deploy?",
  dismissible: true,
  actions: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
};

function createManager() {
  const notifyChange = vi.fn<() => void>();
  const manager = new NotificationManager(notifyChange);
  return { manager, notifyChange };
}

describe("NotificationManager", () => {
  it("adds a shown notification to the snapshot and notifies", () => {
    const { manager, notifyChange } = createManager();

    const id = manager.show({ config: CONFIG });

    expect(notifyChange).toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual([{ id, config: CONFIG, count: 1 }]);
  });

  it("replaces the config when shown with an id", () => {
    const { manager, notifyChange } = createManager();
    const id = manager.show({ config: CONFIG });
    notifyChange.mockClear();

    const updated: NotificationConfig = { ...CONFIG, title: "Updated" };
    expect(manager.show({ config: updated, id })).toBe(id);

    expect(notifyChange).toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual([{ id, config: updated, count: 1 }]);
  });

  it("fails not-found when updating a card that is not open", () => {
    const { manager } = createManager();
    const id = manager.show({ config: CONFIG });
    manager.close(id);

    let caught: unknown;
    try {
      manager.show({ config: CONFIG, id });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).category).toBe("not-found");
  });

  it("removes a closed notification from the snapshot", () => {
    const { manager } = createManager();
    const transient = manager.show({ config: { ...CONFIG, title: "Transient" } });
    const survivor = manager.show({ config: { ...CONFIG, title: "Survivor" } });

    manager.close(transient);

    expect(manager.getSnapshot()).toEqual([
      { id: survivor, config: { ...CONFIG, title: "Survivor" }, count: 1 },
    ]);
  });

  it("ignores a close of an id that is not open", () => {
    const { manager, notifyChange } = createManager();

    expect(() => manager.close("ntf-99")).not.toThrow();
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("preserves open order in the snapshot", () => {
    const { manager } = createManager();
    const a = manager.show({ config: { ...CONFIG, title: "A" } });
    const b = manager.show({ config: { ...CONFIG, title: "B" } });

    expect(manager.getSnapshot().map((n) => n.id)).toEqual([a, b]);
  });

  it("carries the attached workspace in the snapshot", () => {
    const { manager } = createManager();

    const id = manager.show({ config: CONFIG, workspacePath: "/ws/feat" });

    expect(manager.getSnapshot()).toEqual([
      { id, config: CONFIG, count: 1, workspacePath: "/ws/feat" },
    ]);
  });

  it("closes a card on dismiss with nobody waiting", () => {
    const { manager } = createManager();
    const id = manager.show({ config: CONFIG });

    manager.routeEvent({ notificationId: id, actionId: "dismiss" });

    expect(manager.getSnapshot()).toEqual([]);
  });

  it("does not throw routing to an unknown notification", () => {
    const { manager } = createManager();
    expect(() => manager.routeEvent({ notificationId: "nope", actionId: "x" })).not.toThrow();
  });

  it("ignores an action the card does not have", () => {
    const { manager } = createManager();
    const id = manager.show({ config: QUESTION });

    manager.routeEvent({ notificationId: id, actionId: "maybe" });

    expect(manager.getSnapshot()).toHaveLength(1);
  });

  describe("waiting for an answer", () => {
    it("answers with the clicked button and closes the card", async () => {
      const { manager } = createManager();
      const answer = manager.showAndWait({ config: QUESTION }, {});
      const [card] = manager.getSnapshot();

      manager.routeEvent({ notificationId: card!.id, actionId: "yes" });

      expect(await answer).toBe("yes");
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("answers null on dismiss", async () => {
      const { manager } = createManager();
      const answer = manager.showAndWait({ config: QUESTION }, {});
      const [card] = manager.getSnapshot();

      manager.routeEvent({ notificationId: card!.id, actionId: "dismiss" });

      expect(await answer).toBeNull();
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("answers null on timeout and gives up its hold", async () => {
      vi.useFakeTimers();
      try {
        const { manager } = createManager();
        const answer = manager.showAndWait({ config: QUESTION }, { timeoutMs: 1000 });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await answer).toBeNull();
        expect(manager.getSnapshot()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers null when its waiter is released", async () => {
      const { manager } = createManager();
      const answer = manager.showAndWait({ config: QUESTION }, { waiter: "w1" });

      manager.releaseWaiter("w1");

      expect(await answer).toBeNull();
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("answers every waiter on a collapsed card with the one click", async () => {
      const { manager } = createManager();
      const first = manager.showAndWait({ config: QUESTION }, {});
      const second = manager.showAndWait({ config: QUESTION }, {});
      const [card] = manager.getSnapshot();
      expect(card!.count).toBe(2);

      manager.routeEvent({ notificationId: card!.id, actionId: "no" });

      expect(await first).toBe("no");
      expect(await second).toBe("no");
    });

    it("keeps a shared card up until its last waiter leaves", async () => {
      const { manager } = createManager();
      const first = manager.showAndWait({ config: QUESTION }, { waiter: "w1" });
      const second = manager.showAndWait({ config: QUESTION }, { waiter: "w2" });

      manager.releaseWaiter("w1");
      expect(await first).toBeNull();
      expect(manager.getSnapshot()).toHaveLength(1);

      manager.releaseWaiter("w2");
      expect(await second).toBeNull();
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("takes over an existing card when waiting on its id", async () => {
      const { manager } = createManager();
      // A progress card, held by its producer and collapsed into by a second open.
      const id = manager.show({ config: { type: "spinner", title: "Building" } });
      manager.show({ config: { type: "spinner", title: "Building" } });

      const answer = manager.showAndWait({ config: QUESTION, id }, { waiter: "w1" });
      expect(manager.getSnapshot()).toEqual([{ id, config: QUESTION, count: 1 }]);

      // The card is the waiter's question now: when the waiter goes, so does it.
      manager.releaseWaiter("w1");
      expect(await answer).toBeNull();
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("lets updates reach a card while it waits", async () => {
      const { manager } = createManager();
      const id = manager.show({ config: QUESTION });
      const answer = manager.showAndWait({ config: QUESTION, id }, {});

      manager.show({ config: { ...QUESTION, message: "3 files changed" }, id });
      expect(manager.getSnapshot()[0]!.config.message).toBe("3 files changed");

      manager.routeEvent({ notificationId: id, actionId: "yes" });
      expect(await answer).toBe("yes");
    });

    it("answers null when the card's last hold is closed", async () => {
      const { manager } = createManager();
      const id = manager.show({ config: QUESTION });
      const answer = manager.showAndWait({ config: QUESTION, id }, {});

      manager.close(id);

      expect(await answer).toBeNull();
    });
  });

  describe("attached to a workspace", () => {
    it("closes the workspace's cards and answers their waiters null", async () => {
      const { manager } = createManager();
      const answer = manager.showAndWait({ config: QUESTION, workspacePath: "/ws/a" }, {});
      manager.show({ config: CONFIG, workspacePath: "/ws/a" });
      const other = manager.show({ config: CONFIG, workspacePath: "/ws/b" });
      const global = manager.show({ config: { ...CONFIG, title: "Global" } });

      manager.closeWorkspace("/ws/a");

      expect(await answer).toBeNull();
      expect(manager.getSnapshot().map((n) => n.id)).toEqual([other, global]);
    });

    it("keeps the same text from two workspaces on two cards", () => {
      const { manager } = createManager();

      manager.show({ config: CONFIG, workspacePath: "/ws/a" });
      manager.show({ config: CONFIG, workspacePath: "/ws/b" });

      expect(manager.getSnapshot()).toHaveLength(2);
    });

    it("keeps an attached card apart from the same text unattached", () => {
      const { manager } = createManager();

      manager.show({ config: CONFIG, workspacePath: "/ws/a" });
      manager.show({ config: CONFIG });

      expect(manager.getSnapshot()).toHaveLength(2);
    });
  });

  describe("collapsing repeats", () => {
    it("collapses identical shows into one card with a rising count", () => {
      const { manager } = createManager();

      // The shape that flooded the sidebar: an auto-workspace create failing on
      // the same branch collision once a minute for hours.
      const first = manager.show({ config: CONFIG });
      const again = manager.show({ config: CONFIG });

      expect(again).toBe(first);
      expect(manager.getSnapshot()).toEqual([{ id: first, config: CONFIG, count: 2 }]);
    });

    it("keeps notifications that differ in any visible field apart", () => {
      const { manager } = createManager();

      manager.show({ config: CONFIG });
      manager.show({ config: { ...CONFIG, title: "Other" } });
      manager.show({ config: { ...CONFIG, message: "Other message" } });
      manager.show({ config: { ...CONFIG, type: "error" } });
      manager.show({ config: { ...CONFIG, dismissible: false } });
      manager.show({ config: { ...CONFIG, actions: [{ id: "go", label: "Go" }] } });

      expect(manager.getSnapshot()).toHaveLength(6);
    });

    it("ignores progress, which is a measurement rather than an identity", () => {
      const { manager } = createManager();
      const spinner: NotificationConfig = { type: "spinner", title: "Working" };

      manager.show({ config: { ...spinner, progress: 0.1 } });
      manager.show({ config: { ...spinner, progress: 0.9 } });

      expect(manager.getSnapshot()).toHaveLength(1);
    });

    it("re-files a card on update, so it no longer swallows its original text", () => {
      const { manager } = createManager();
      const moved = manager.show({ config: CONFIG });

      manager.show({ config: { ...CONFIG, title: "Moved on" }, id: moved });
      const fresh = manager.show({ config: CONFIG });

      expect(fresh).not.toBe(moved);
      expect(manager.getSnapshot().map((n) => n.count)).toEqual([1, 1]);
    });

    it("matches a card by what it now says", () => {
      const { manager } = createManager();
      const moved = manager.show({ config: CONFIG });
      manager.show({ config: { ...CONFIG, title: "Moved on" }, id: moved });

      const same = manager.show({ config: { ...CONFIG, title: "Moved on" } });

      expect(same).toBe(moved);
      expect(manager.getSnapshot()).toHaveLength(1);
    });

    it("closes on the last hold, not the first", () => {
      const { manager } = createManager();
      // Two clones of different URLs must not take each other's card down; they
      // stay apart by their text, but a card that did collapse is held by both.
      const id = manager.show({ config: CONFIG });
      manager.show({ config: CONFIG });

      manager.close(id);
      expect(manager.getSnapshot()).toEqual([{ id, config: CONFIG, count: 1 }]);

      manager.close(id);
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("lets a dismiss retire the whole card, however many shows it stands for", () => {
      const { manager } = createManager();
      const id = manager.show({ config: CONFIG });
      manager.show({ config: CONFIG });
      manager.show({ config: CONFIG });

      manager.routeEvent({ notificationId: id, actionId: "dismiss" });

      expect(manager.getSnapshot()).toEqual([]);
    });

    it("opens a fresh card once the collapsed one is gone", () => {
      const { manager } = createManager();
      const first = manager.show({ config: CONFIG });
      manager.close(first);

      const second = manager.show({ config: CONFIG });

      expect(second).not.toBe(first);
      expect(manager.getSnapshot()).toEqual([{ id: second, config: CONFIG, count: 1 }]);
    });
  });
});
