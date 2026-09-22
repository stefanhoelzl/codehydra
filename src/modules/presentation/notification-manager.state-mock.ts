/**
 * Test harness for modules that raise sidebar notifications.
 *
 * Producers raise cards by dispatching `notification:show` / `notification:close`,
 * so the harness is the real thing end to end: the two operations, the same
 * hook handlers the presenter registers (`createNotificationHooks`), and a real
 * NotificationManager behind them. Collapsing, holds, dismiss-closes and waits
 * therefore behave exactly as in the app.
 *
 * What it adds is a record per card for assertions, kept in step with the
 * manager's snapshot on every change: the config it opened with, every config
 * it was updated to, its hold count, and whether it has closed.
 *
 * Dispatches are asynchronous, so a test awaits `settle()` after the action
 * that raises a card and before asserting on it.
 */
import type { NotificationConfig } from "../../shared/notification-types";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { ShowNotificationOperation } from "../../intents/show-notification";
import { CloseNotificationOperation } from "../../intents/close-notification";
import { NotificationManager } from "./sessions";
import { createNotificationHooks } from "./notification-hooks";

/** Per-card state exposed for assertions. */
export interface MockNotification {
  readonly id: string;
  /** The config the card opened with. */
  readonly opened: NotificationConfig;
  /** Every config the card was updated to, in order. */
  updates: NotificationConfig[];
  /** Latest config — the open plus any updates applied. */
  latestConfig: NotificationConfig;
  /** Opens (and waits) holding the card. */
  count: number;
  /** True once the card has closed. */
  closed: boolean;
  /** The workspace the card is attached to, if any. */
  readonly workspacePath: string | undefined;
}

export interface MockNotificationManager {
  /** A dispatcher carrying just the notification operations, for modules that only raise cards. */
  readonly dispatcher: Dispatcher;
  /** Carry the notification operations on a test's own dispatcher instead. */
  register(dispatcher: Dispatcher): void;
  /** Every card opened so far, in order. Mutates live. */
  readonly notifications: MockNotification[];
  /** The most recently opened card, or null. */
  readonly lastNotification: MockNotification | null;
  /**
   * Deliver a user interaction to a card: "dismiss", or a button id.
   * @param indexOrId card index (0-based) or its id
   */
  emitEvent(indexOrId: number | string, event: { readonly actionId: string }): void;
  /**
   * Let in-flight dispatches finish. A dispatch is a chain of microtasks, so
   * this drains the microtask queue rather than waiting on a timer — it works
   * the same under `vi.useFakeTimers()`.
   */
  settle(): Promise<void>;
}

/**
 * Microtask turns `settle()` yields. Comfortably more than the deepest chain a
 * producer starts (a NotificationCard step: queue, dispatch, interceptors,
 * operation, hook, result), and still microseconds.
 */
const SETTLE_TURNS = 200;

export function createMockNotificationManager(): MockNotificationManager {
  const records: MockNotification[] = [];
  const byId = new Map<string, MockNotification>();

  const manager: NotificationManager = new NotificationManager(() => sync());

  /** Fold the manager's snapshot into the records. Runs on every mutation. */
  function sync(): void {
    const open = new Set<string>();
    for (const card of manager.getSnapshot()) {
      open.add(card.id);
      const record = byId.get(card.id);
      if (!record) {
        const created: MockNotification = {
          id: card.id,
          opened: card.config,
          updates: [],
          latestConfig: card.config,
          count: card.count,
          closed: false,
          workspacePath: card.workspacePath,
        };
        records.push(created);
        byId.set(card.id, created);
        continue;
      }
      if (record.latestConfig !== card.config) {
        record.updates.push(card.config);
        record.latestConfig = card.config;
      }
      record.count = card.count;
    }
    for (const record of records) {
      if (!record.closed && !open.has(record.id)) record.closed = true;
    }
  }

  function register(dispatcher: Dispatcher): void {
    dispatcher.registerOperation(new ShowNotificationOperation());
    dispatcher.registerOperation(new CloseNotificationOperation());
    dispatcher.registerModule({
      name: "notifications-mock",
      hooks: createNotificationHooks(manager),
    });
  }

  const own = createMockDispatcher();
  register(own);

  return {
    dispatcher: own,
    register,
    notifications: records,
    get lastNotification() {
      return records[records.length - 1] ?? null;
    },
    emitEvent(indexOrId, event) {
      const record = typeof indexOrId === "number" ? records[indexOrId] : byId.get(indexOrId);
      if (!record) throw new Error(`No notification matching ${String(indexOrId)}`);
      manager.routeEvent({ notificationId: record.id, actionId: event.actionId });
    },
    settle: async () => {
      for (let i = 0; i < SETTLE_TURNS; i++) await Promise.resolve();
    },
  };
}
