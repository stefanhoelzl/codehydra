/**
 * How long a workspace has been hibernated, for the sidebar row, its tooltip
 * and the hibernated overlay. Pure: callers pass `now` (see clock.svelte.ts).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Single floored unit for the sidebar row: `now`, `5m`, `3h`, `4d`, `2w`. */
export function formatShortAge(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / WEEK)}w`;
}

/** The same floored unit, spelled out: `just now`, `1 minute ago`, `3 days ago`. */
export function formatRelativeAge(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE) return "just now";
  const [count, unit] =
    elapsed < HOUR
      ? [Math.floor(elapsed / MINUTE), "minute"]
      : elapsed < DAY
        ? [Math.floor(elapsed / HOUR), "hour"]
        : [Math.floor(elapsed / DAY), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Local date and time, `Mon, Oct 27, 14:02`; the year only when it is not this year. */
export function formatHibernatedDate(since: number, now: number, locale?: string): string {
  const date = new Date(since);
  return date.toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface HibernationAge {
  /** `3d` */
  readonly short: string;
  /** `3 days ago` */
  readonly relative: string;
  /** `Mon, Oct 27, 14:02` */
  readonly date: string;
}

/** Every label for an ISO `hibernatedAt`; null when absent or unparsable. */
export function describeHibernation(
  iso: string | null | undefined,
  now: number,
  locale?: string
): HibernationAge | null {
  if (!iso) return null;
  const since = Date.parse(iso);
  if (Number.isNaN(since)) return null;
  return {
    short: formatShortAge(since, now),
    relative: formatRelativeAge(since, now),
    date: formatHibernatedDate(since, now, locale),
  };
}
