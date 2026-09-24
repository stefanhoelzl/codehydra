// @vitest-environment node
/**
 * Focused tests for ConditionWaiters.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ConditionWaiters } from "./wait-until";

describe("ConditionWaiters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true at once when the condition already holds", async () => {
    await expect(new ConditionWaiters().waitUntil(() => true, 0)).resolves.toBe(true);
  });

  it("does not wait when waitMs is 0", async () => {
    await expect(new ConditionWaiters().waitUntil(() => false, 0)).resolves.toBe(false);
  });

  it("resolves true on the notify that makes the condition hold", async () => {
    vi.useFakeTimers();
    const waiters = new ConditionWaiters();
    let ready = false;
    const result = waiters.waitUntil(() => ready, 1000);

    waiters.notify(); // not yet
    ready = true;
    waiters.notify();

    await expect(result).resolves.toBe(true);
  });

  it("resolves false once waitMs passes without the condition", async () => {
    vi.useFakeTimers();
    const waiters = new ConditionWaiters();
    const result = waiters.waitUntil(() => false, 1000);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBe(false);
  });

  it("forgets a waiter once it has settled", async () => {
    vi.useFakeTimers();
    const waiters = new ConditionWaiters();
    let checks = 0;
    const result = waiters.waitUntil(() => {
      checks++;
      return checks > 1;
    }, 1000);

    waiters.notify();
    await result;
    const settledAt = checks;
    waiters.notify();

    expect(checks).toBe(settledAt);
  });
});
