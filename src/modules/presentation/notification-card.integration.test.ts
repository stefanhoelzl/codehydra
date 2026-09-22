// @vitest-environment node
/**
 * Integration tests for the producer-side helpers over notification:show /
 * notification:close, run against the real operations and manager.
 */

import { describe, it, expect } from "vitest";
import { NotificationCard, notify } from "./notification-card";
import { createMockNotificationManager } from "./notification-manager.state-mock";
import type { NotificationConfig } from "../../shared/notification-types";

const spinner = (progress: number): NotificationConfig => ({
  type: "spinner",
  title: "Cloning",
  progress,
});

const QUESTION: NotificationConfig = {
  type: "info",
  title: "Update ready",
  actions: [{ id: "restart", label: "Restart Now" }],
};

describe("notify", () => {
  it("raises a one-shot card", async () => {
    const cards = createMockNotificationManager();

    notify(cards.dispatcher, { type: "error", title: "Hook failed", dismissible: true });
    await cards.settle();

    expect(cards.notifications).toHaveLength(1);
    expect(cards.lastNotification!.opened.title).toBe("Hook failed");
  });
});

describe("NotificationCard", () => {
  it("lands a burst of updates on the one card it opened, in order", async () => {
    const cards = createMockNotificationManager();
    const card = new NotificationCard(cards.dispatcher);

    // Made back to back, before the first dispatch has returned an id — the
    // shape clone progress events arrive in.
    card.show(spinner(0.1));
    card.show(spinner(0.5));
    card.show(spinner(0.9));
    await cards.settle();

    expect(cards.notifications).toHaveLength(1);
    expect(cards.lastNotification!.updates.map((c) => c.progress)).toEqual([0.5, 0.9]);
  });

  it("releases the card on close", async () => {
    const cards = createMockNotificationManager();
    const card = new NotificationCard(cards.dispatcher);

    card.show(spinner(0.1));
    card.close();
    await cards.settle();

    expect(cards.lastNotification!.closed).toBe(true);
  });

  it("answers ask with the clicked button, and the next show opens a fresh card", async () => {
    const cards = createMockNotificationManager();
    const card = new NotificationCard(cards.dispatcher);

    const answer = card.ask(QUESTION);
    await cards.settle();
    cards.emitEvent(0, { actionId: "restart" });

    expect(await answer).toBe("restart");
    card.show(spinner(0));
    await cards.settle();
    expect(cards.notifications).toHaveLength(2);
    expect(cards.notifications[0]!.closed).toBe(true);
  });

  it("turns an open card into the question in place", async () => {
    const cards = createMockNotificationManager();
    const card = new NotificationCard(cards.dispatcher);

    card.show(spinner(1));
    const answer = card.ask(QUESTION);
    await cards.settle();

    expect(cards.notifications).toHaveLength(1);
    expect(cards.lastNotification!.latestConfig).toEqual(QUESTION);
    cards.emitEvent(0, { actionId: "dismiss" });
    expect(await answer).toBeNull();
  });

  it("reopens a card the user dismissed when it is shown again", async () => {
    const cards = createMockNotificationManager();
    const card = new NotificationCard(cards.dispatcher);

    card.show({ type: "error", title: "Clone failed", dismissible: true });
    await cards.settle();
    cards.emitEvent(0, { actionId: "dismiss" });

    card.show({ type: "error", title: "Clone failed again", dismissible: true });
    await cards.settle();

    expect(cards.notifications).toHaveLength(2);
    expect(cards.notifications[1]!.opened.title).toBe("Clone failed again");
  });
});
