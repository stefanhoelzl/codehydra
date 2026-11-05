/**
 * The clocks outside a reactive context. Their ticking inside one is covered
 * where they are read: the sidebar's busy time (second clock) and hibernation
 * age (minute clock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClock, minuteNow, secondNow } from "./clock.svelte";

describe("clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 12, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current time", () => {
    const now = createClock(5_000);
    expect(now()).toBe(Date.now());
    vi.advanceTimersByTime(2_500);
    expect(now()).toBe(Date.now());
    expect(secondNow()).toBe(Date.now());
    expect(minuteNow()).toBe(Date.now());
  });

  it("starts no interval when nothing reactive reads it", () => {
    createClock(1_000)();
    secondNow();
    minuteNow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
