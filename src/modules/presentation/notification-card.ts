/**
 * Producer-side helpers over `notification:show` / `notification:close`.
 *
 * Sidebar cards are raised only through those intents; these helpers are the
 * in-process spelling of the two shapes producers need:
 *
 * - `notify()` — a one-shot card nobody touches again (most error cards). The
 *   user dismisses it and it closes itself.
 * - `NotificationCard` — one card a producer keeps changing (clone progress,
 *   the update flow). It remembers the card's id and orders its dispatches, so
 *   an update can never overtake the show that opens the card it updates.
 *
 * Neither holds any card state: the presenter's NotificationManager does.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { NotificationConfig } from "../../shared/notification-types";
import {
  INTENT_SHOW_NOTIFICATION,
  notificationIdOf,
  type ShowNotificationIntent,
} from "../../intents/show-notification";
import {
  INTENT_CLOSE_NOTIFICATION,
  type CloseNotificationIntent,
} from "../../intents/close-notification";
import type { WorkspacePath } from "../../intents/contract";

type Dispatch = Pick<Dispatcher, "dispatch">;

/**
 * Raise a one-shot card and forget it.
 *
 * A failed dispatch is already logged by the dispatcher, and a card that could
 * not be shown has no one left to tell, so the rejection is absorbed here.
 */
export function notify(
  dispatcher: Dispatch,
  config: NotificationConfig,
  workspacePath?: WorkspacePath
): void {
  void dispatcher
    .dispatch<ShowNotificationIntent>({
      type: INTENT_SHOW_NOTIFICATION,
      payload: {
        config,
        ...(workspacePath !== undefined && { workspacePath }),
      },
    })
    .catch(() => undefined);
}

/**
 * One card a producer keeps changing.
 *
 * `show` opens the card or replaces its content; `ask` shows it and waits for
 * a button; `close` releases it. Calls are applied in the order they are made.
 * A card the user dismissed is forgotten, so the next `show` opens a fresh one.
 */
export class NotificationCard {
  private id: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dispatcher: Dispatch) {}

  /** Open the card, or replace its content. */
  show(config: NotificationConfig): void {
    this.enqueue(() => this.apply(config));
  }

  /**
   * Show `config` and wait for the user.
   *
   * Resolves with the clicked button's id, or null when the card is dismissed
   * or closed. Either way the card is gone afterwards. Updates made while it
   * waits still apply — they replace the question's content in place.
   */
  ask(config: NotificationConfig): Promise<string | null> {
    return new Promise((resolve) => {
      this.enqueue(async () => {
        const id = await this.apply(config);
        if (id === null) {
          resolve(null);
          return;
        }
        // Not awaited: the wait lasts until the user answers, and the queue
        // must stay free for updates to the card in the meantime.
        void this.dispatcher
          .dispatch<ShowNotificationIntent>({
            type: INTENT_SHOW_NOTIFICATION,
            payload: { config, id, wait: true },
          })
          .then(
            (result) => ("choice" in result ? result.choice : null),
            () => null
          )
          .then((choice) => {
            // Answered or closed — either way the card no longer exists.
            if (this.id === id) this.id = null;
            resolve(choice);
          });
      });
    });
  }

  /** Release the card. */
  close(): void {
    this.enqueue(async () => {
      const id = this.id;
      if (id === null) return;
      this.id = null;
      await this.dispatcher
        .dispatch<CloseNotificationIntent>({ type: INTENT_CLOSE_NOTIFICATION, payload: { id } })
        .catch(() => undefined);
    });
  }

  /** Open or update; returns the card's id, or null when it could not be shown. */
  private async apply(config: NotificationConfig): Promise<string | null> {
    const current = this.id;
    let result;
    try {
      result = await this.dispatcher.dispatch<ShowNotificationIntent>({
        type: INTENT_SHOW_NOTIFICATION,
        payload: { config, ...(current !== null && { id: current }) },
      });
    } catch {
      // Already logged by the dispatcher; there is no card to report.
      return null;
    }
    this.id = notificationIdOf(result);
    if (this.id === null && current !== null) {
      // Dismissed under us: open a fresh card with this content.
      return this.apply(config);
    }
    return this.id;
  }

  private enqueue(step: () => Promise<unknown>): void {
    this.queue = this.queue.then(step).then(
      () => undefined,
      () => undefined
    );
  }
}
