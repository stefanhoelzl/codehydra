/**
 * An automation's `schedule`: how long it waits after a run before the next.
 *
 * One of `hourly`, `daily`, `weekly`, `monthly` and `yearly`, measured from when
 * it last ran, in the machine's local time (a day is a calendar day, so a
 * daylight-saving change does not shift it). A schedule can only make an
 * automation run less often than `poll.interval`, never more often.
 *
 * When it last ran is kept in memory: every automation runs at the first poll
 * after the app starts. So nothing is missed, whether the machine slept or the
 * app was closed — a restart runs it early instead.
 */

import type { Schedule } from "../../api/entries/deps";

/** Months move by calendar, keeping the day where the target month has it: Jan 31 → Feb 28. */
function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

/** The earliest time an automation that last ran at `lastRun` runs again. */
export function nextRun(schedule: Schedule, lastRun: number): number {
  const last = new Date(lastRun);
  switch (schedule) {
    case "hourly":
      return lastRun + 60 * 60 * 1000;
    case "daily":
    case "weekly": {
      const next = new Date(last);
      next.setDate(next.getDate() + (schedule === "daily" ? 1 : 7));
      return next.getTime();
    }
    case "monthly":
      return addMonths(last, 1).getTime();
    case "yearly":
      return addMonths(last, 12).getTime();
  }
}

/** Whether an automation is due: it has not run since the app started, or its wait is over. */
export function isDue(schedule: Schedule, lastRun: number | undefined, now: number): boolean {
  return lastRun === undefined || nextRun(schedule, lastRun) <= now;
}
