import { describe, it, expect } from "vitest";
import {
  describeHibernation,
  formatHibernatedDate,
  formatRelativeAge,
  formatShortAge,
} from "./hibernation-age";

const NOW = new Date(2026, 9, 30, 12, 0).getTime();
const ago = (ms: number): number => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatShortAge", () => {
  it.each([
    [0, "<1m"],
    [59_999, "<1m"],
    [MIN, "1m"],
    [59 * MIN + 59_999, "59m"],
    [HOUR, "1h"],
    [23 * HOUR + 59 * MIN, "23h"],
    [DAY, "1d"],
    [45 * DAY + 5 * HOUR, "45d"],
  ])("%i ms ago → %s", (elapsed, expected) => {
    expect(formatShortAge(ago(elapsed), NOW)).toBe(expected);
  });

  it("treats a time in the future (clock skew) as just now", () => {
    expect(formatShortAge(NOW + HOUR, NOW)).toBe("<1m");
  });
});

describe("formatRelativeAge", () => {
  it.each([
    [30_000, "just now"],
    [MIN, "1 minute ago"],
    [5 * MIN, "5 minutes ago"],
    [HOUR, "1 hour ago"],
    [3 * HOUR, "3 hours ago"],
    [DAY, "1 day ago"],
    [12 * DAY, "12 days ago"],
  ])("%i ms ago → %s", (elapsed, expected) => {
    expect(formatRelativeAge(ago(elapsed), NOW)).toBe(expected);
  });
});

describe("formatHibernatedDate", () => {
  it("omits the year within the current year", () => {
    const since = new Date(2026, 9, 27, 14, 2).getTime();
    expect(formatHibernatedDate(since, NOW, "en-US")).toBe("Tue, Oct 27, 02:02 PM");
  });

  it("includes the year when it is not the current year", () => {
    const since = new Date(2025, 11, 31, 9, 5).getTime();
    expect(formatHibernatedDate(since, NOW, "en-US")).toBe("Wed, Dec 31, 2025, 09:05 AM");
  });
});

describe("describeHibernation", () => {
  it("returns every label for a valid time", () => {
    const iso = new Date(ago(3 * DAY)).toISOString();
    expect(describeHibernation(iso, NOW, "en-US")).toEqual({
      short: "3d",
      relative: "3 days ago",
      date: formatHibernatedDate(ago(3 * DAY), NOW, "en-US"),
    });
  });

  it.each([null, undefined, "", "not a date"])("returns null for %j", (iso) => {
    expect(describeHibernation(iso, NOW)).toBeNull();
  });
});
