/**
 * How long a workspace's agent has been working, for the sidebar row, its
 * status tooltip and its accessible name. Pure: callers pass `now` (see
 * clock.svelte.ts).
 */

import { formatHibernatedDate } from "./hibernation-age.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The row's label: `42s` under a minute, then `5m`, `1h 5m`, `2h`. */
export function formatBusyTime(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)}s`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  const hours = Math.floor(elapsed / HOUR);
  const minutes = Math.floor((elapsed % HOUR) / MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * The same time spelled out, to the minute: `less than a minute`, `1 minute`,
 * `1 hour 5 minutes`. Minutes only, so an accessible name built from it
 * changes once a minute rather than every second.
 */
export function formatBusyDuration(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE) return "less than a minute";
  const plural = (count: number, unit: string): string =>
    `${count} ${unit}${count === 1 ? "" : "s"}`;
  const hours = Math.floor(elapsed / HOUR);
  const minutes = Math.floor((elapsed % HOUR) / MINUTE);
  if (hours === 0) return plural(minutes, "minute");
  return minutes === 0
    ? plural(hours, "hour")
    : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

/** The start time: `14:02` today, otherwise with the date (`Mon, Oct 27, 14:02`). */
export function formatBusySince(since: number, now: number, locale?: string): string {
  const start = new Date(since);
  if (start.toDateString() !== new Date(now).toDateString()) {
    return formatHibernatedDate(since, now, locale);
  }
  return start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export interface BusyTime {
  /** `1h 5m` */
  readonly short: string;
  /** `1 hour 5 minutes` */
  readonly spoken: string;
  /** `14:02` */
  readonly since: string;
}

/** Every label for an ISO `changedAt`; null when absent or unparsable. */
export function describeBusyTime(
  iso: string | null | undefined,
  now: number,
  locale?: string
): BusyTime | null {
  if (!iso) return null;
  const since = Date.parse(iso);
  if (Number.isNaN(since)) return null;
  return {
    short: formatBusyTime(since, now),
    spoken: formatBusyDuration(since, now),
    since: formatBusySince(since, now, locale),
  };
}
