import { describe, it, expect } from "vitest";
import { describeBusyTime, formatBusyDuration, formatBusySince, formatBusyTime } from "./busy-time";

const NOW = new Date(2026, 9, 30, 12, 0).getTime();
const ago = (ms: number): number => NOW - ms;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("formatBusyTime", () => {
  it.each([
    [0, "0s"],
    [42 * SEC + 999, "42s"],
    [59 * SEC + 999, "59s"],
    [MIN, "1m"],
    [59 * MIN + 59 * SEC, "59m"],
    [HOUR, "1h"],
    [HOUR + 5 * MIN + 30 * SEC, "1h 5m"],
    [26 * HOUR + 59 * MIN, "26h 59m"],
  ])("%i ms → %s", (elapsed, expected) => {
    expect(formatBusyTime(ago(elapsed), NOW)).toBe(expected);
  });

  it("reads a start in the future (clock skew) as 0s", () => {
    expect(formatBusyTime(NOW + 5 * SEC, NOW)).toBe("0s");
  });
});

describe("formatBusyDuration", () => {
  it.each([
    [42 * SEC, "less than a minute"],
    [MIN, "1 minute"],
    [5 * MIN + 59 * SEC, "5 minutes"],
    [HOUR, "1 hour"],
    [HOUR + MIN, "1 hour 1 minute"],
    [2 * HOUR + 5 * MIN, "2 hours 5 minutes"],
  ])("%i ms → %s", (elapsed, expected) => {
    expect(formatBusyDuration(ago(elapsed), NOW)).toBe(expected);
  });
});

describe("formatBusySince", () => {
  it("shows only the time for a start today", () => {
    expect(formatBusySince(new Date(2026, 9, 30, 9, 5).getTime(), NOW, "en-GB")).toBe("09:05");
  });

  it("adds the date for a start on an earlier day", () => {
    expect(formatBusySince(new Date(2026, 9, 29, 23, 50).getTime(), NOW, "en-US")).toBe(
      "Thu, Oct 29, 11:50 PM"
    );
  });
});

describe("describeBusyTime", () => {
  it("gives every label for an ISO timestamp", () => {
    expect(describeBusyTime(new Date(ago(90 * SEC)).toISOString(), NOW, "en-GB")).toEqual({
      short: "1m",
      spoken: "1 minute",
      since: "11:58",
    });
  });

  it.each([undefined, null, "", "not a date"])("is null for %s", (iso) => {
    expect(describeBusyTime(iso, NOW)).toBeNull();
  });
});
