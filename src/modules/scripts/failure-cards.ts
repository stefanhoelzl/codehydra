/**
 * The cards that report failing scripts — a plugin's hook or automation, a
 * wakeup script, a plugin that cannot run — and what is kept of them once they
 * stop failing.
 *
 * One card per failing thing, and it lives exactly as long as the failure: it
 * opens when the failure is first reported, says the new message in place when
 * the message changes, and closes when the failure clears (the next success,
 * or the thing no longer being run). A list read after the card has gone can
 * then never disagree with a card still on screen.
 *
 * A failure with a run log carries an **Open log** button that opens its newest
 * failed run's log with the system's default app. The button leaves the card
 * up — reading the log does not fix anything. A newer failed run with the same
 * message points the button at its own log without raising the card again.
 *
 * Dismissing a card silences that failure until its message changes or it
 * clears and fails afresh: an automation fails every poll cycle until fixed,
 * and one card saying so is enough.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { NotificationConfig } from "../../shared/notification-types";
import { NotificationCard } from "../presentation/notification-card";
import { getErrorMessage } from "../../shared/error-utils";

/** The id of a failure card's Open log button. */
export const OPEN_LOG_ACTION = "open-log";

/** Failures with no run log that are kept per failing thing once they are past. */
export const KEEP_PAST_FAILURES = 10;

export interface FailureReport {
  readonly title: string;
  readonly message: string;
  /** The newest failed run's log file (native path), for the Open log button. */
  readonly logPath?: string;
}

export interface FailureCards {
  /**
   * A failure was reported: open its card, or bring the open one up to date.
   * The same message again only moves the Open log button to the new log.
   */
  raise(key: string, report: FailureReport): void;
  /** The failure cleared: close its card. No-op when it has none. */
  clear(key: string): void;
}

export interface FailureCardsDeps {
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** Hands a file to the system's default app. */
  readonly openPath: (path: string) => Promise<void>;
  readonly logger: Logger;
}

interface Tracked {
  report: FailureReport;
  /** The card waiting on the user; null once dismissed. */
  card: NotificationCard | null;
  cleared: boolean;
}

function configOf(report: FailureReport): NotificationConfig {
  return {
    type: "error",
    title: report.title,
    message: report.message,
    dismissible: true,
    ...(report.logPath !== undefined && {
      actions: [{ id: OPEN_LOG_ACTION, label: "Open log", keepOpen: true }],
    }),
  };
}

export function createFailureCards(deps: FailureCardsDeps): FailureCards {
  const tracked = new Map<string, Tracked>();

  /** Hold the card up, opening the log on each click, until it is dismissed or cleared. */
  async function watch(key: string, entry: Tracked, card: NotificationCard): Promise<void> {
    for (;;) {
      const choice = await card.ask(configOf(entry.report));
      if (choice !== OPEN_LOG_ACTION || entry.cleared) break;
      const logPath = entry.report.logPath;
      if (logPath === undefined) continue;
      try {
        await deps.openPath(logPath);
      } catch (error) {
        deps.logger.warn("Could not open run log", { error: getErrorMessage(error) });
      }
      if (entry.cleared) break;
    }
    // Ended by the user rather than by the failure clearing: dismissed.
    if (!entry.cleared && tracked.get(key) === entry) entry.card = null;
  }

  function open(key: string, entry: Tracked): void {
    const card = new NotificationCard(deps.dispatcher);
    entry.card = card;
    void watch(key, entry, card);
  }

  return {
    raise(key, report) {
      const entry = tracked.get(key);
      if (entry === undefined) {
        const fresh: Tracked = { report, card: null, cleared: false };
        tracked.set(key, fresh);
        open(key, fresh);
        return;
      }
      const previous = entry.report;
      entry.report = report;
      if (previous.message === report.message && previous.title === report.title) {
        // Only the log moved; the button appearing or going is the one visible change.
        const hadButton = previous.logPath !== undefined;
        const hasButton = report.logPath !== undefined;
        if (hadButton !== hasButton) entry.card?.show(configOf(report));
        return;
      }
      if (entry.card === null) open(key, entry);
      else entry.card.show(configOf(report));
    },
    clear(key) {
      const entry = tracked.get(key);
      if (entry === undefined) return;
      tracked.delete(key);
      entry.cleared = true;
      entry.card?.close();
    },
  };
}

/**
 * Failures that left no run log, kept once they are past — the newest
 * {@link KEEP_PAST_FAILURES} per failing thing, until the app restarts. A
 * failure with a log needs no keeping: its log is its record.
 */
export class PastFailures<T extends { readonly logPath?: string }> {
  private readonly byKey = new Map<string, T[]>();

  /** `entry` stopped being current — cleared, or replaced by a new message. */
  add(key: string, entry: T): void {
    if (entry.logPath !== undefined) return;
    const list = this.byKey.get(key) ?? [];
    list.unshift(entry);
    list.length = Math.min(list.length, KEEP_PAST_FAILURES);
    this.byKey.set(key, list);
  }

  list(): readonly T[] {
    return [...this.byKey.values()].flat();
  }
}
