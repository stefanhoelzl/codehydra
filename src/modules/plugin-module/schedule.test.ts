import { describe, it, expect } from "vitest";
import { isDue, nextRun } from "./schedule";

const at = (text: string): number => new Date(text).getTime();

describe("nextRun", () => {
  it("waits an hour", () => {
    expect(nextRun("hourly", at("2026-03-10T02:15:00"))).toBe(at("2026-03-10T03:15:00"));
  });

  it("waits a calendar day, and a week, in local time", () => {
    expect(nextRun("daily", at("2026-03-10T02:15:00"))).toBe(at("2026-03-11T02:15:00"));
    expect(nextRun("weekly", at("2026-03-10T02:15:00"))).toBe(at("2026-03-17T02:15:00"));
  });

  it("waits a calendar month, keeping the day where the month has it", () => {
    expect(nextRun("monthly", at("2026-03-10T08:00:00"))).toBe(at("2026-04-10T08:00:00"));
    expect(nextRun("monthly", at("2026-01-31T08:00:00"))).toBe(at("2026-02-28T08:00:00"));
    expect(nextRun("monthly", at("2026-12-15T08:00:00"))).toBe(at("2027-01-15T08:00:00"));
  });

  it("waits a calendar year, Feb 29 landing on Feb 28", () => {
    expect(nextRun("yearly", at("2026-03-10T08:00:00"))).toBe(at("2027-03-10T08:00:00"));
    expect(nextRun("yearly", at("2028-02-29T08:00:00"))).toBe(at("2029-02-28T08:00:00"));
  });
});

describe("isDue", () => {
  const last = at("2026-03-10T02:00:00");

  it("is due when it has not run since the app started", () => {
    expect(isDue("yearly", undefined, last)).toBe(true);
  });

  it("is not due before its wait is over", () => {
    expect(isDue("hourly", last, at("2026-03-10T02:59:59"))).toBe(false);
    expect(isDue("daily", last, at("2026-03-11T01:59:59"))).toBe(false);
  });

  it("is due once its wait is over, however long ago that was", () => {
    expect(isDue("hourly", last, at("2026-03-10T03:00:00"))).toBe(true);
    expect(isDue("daily", last, at("2026-03-14T09:00:00"))).toBe(true);
  });
});
