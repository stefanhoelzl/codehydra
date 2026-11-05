import { describe, it, expect } from "vitest";
import { isDue, nextScheduled, scheduleProblem } from "./schedule";

const at = (text: string): number => new Date(text).getTime();

describe("scheduleProblem", () => {
  it.each(["* * * * *", "0 3 * * *", "*/5 9-17 * * 1-5", "0 0 1 jan *"])("accepts %s", (text) => {
    expect(scheduleProblem(text)).toBeUndefined();
  });

  it.each(["", "* * * *", "0 * * * * *", "@daily", "99 * * * *", "nonsense x y z w"])(
    "refuses %j",
    (text) => {
      expect(scheduleProblem(text)).toEqual(expect.any(String));
    }
  );
});

describe("isDue", () => {
  const since = at("2026-03-10T02:00:00");

  it("is not due before the time", () => {
    expect(isDue("0 3 * * *", since, at("2026-03-10T02:59:59"))).toBe(false);
  });

  it("is due once the time has passed", () => {
    expect(isDue("0 3 * * *", since, at("2026-03-10T03:00:00"))).toBe(true);
    expect(isDue("0 3 * * *", since, at("2026-03-10T03:00:40"))).toBe(true);
  });

  it("does not count the time it last ran at", () => {
    expect(isDue("0 3 * * *", at("2026-03-10T03:00:00"), at("2026-03-10T03:00:40"))).toBe(false);
  });

  it("is due however many times passed", () => {
    expect(isDue("* * * * *", since, at("2026-03-11T02:00:00"))).toBe(true);
  });
});

describe("nextScheduled", () => {
  it("names the next time, in local time", () => {
    expect(nextScheduled("0 3 * * *", at("2026-03-10T03:00:00"))).toBe(at("2026-03-11T03:00:00"));
  });
});
