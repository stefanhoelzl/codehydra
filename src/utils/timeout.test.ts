import { describe, it, expect, vi, afterEach } from "vitest";
import { raceTimeout, withTimeout, TIMED_OUT } from "./timeout";

describe("raceTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles first and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(raceTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with TIMED_OUT when the deadline passes first", async () => {
    vi.useFakeTimers();
    const pending = raceTimeout(new Promise<never>(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(TIMED_OUT);
  });

  it("rejects when the promise rejects and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(raceTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles first", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, () => new Error("late"))).resolves.toBe(
      "ok"
    );
  });

  it("rejects with onTimeout() when the deadline passes first", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => {}), 1000, () => new Error("late"));
    const assertion = expect(pending).rejects.toThrow("late");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
