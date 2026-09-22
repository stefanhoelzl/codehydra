import { describe, it, expect } from "vitest";
import { formatAge } from "./age";

describe("formatAge", () => {
  const now = 10_000_000;

  it.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_999, "59m"],
    [3_600_000, "1h 0m"],
    [2 * 3_600_000 + 5 * 60_000, "2h 5m"],
  ])("renders %ims as %s", (elapsed, expected) => {
    expect(formatAge(now - elapsed, now)).toBe(expected);
  });

  it("treats a timestamp in the future as just now", () => {
    expect(formatAge(now + 5_000, now)).toBe("0s");
  });
});
