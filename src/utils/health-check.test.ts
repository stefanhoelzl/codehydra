import { describe, it, expect, vi, afterEach } from "vitest";
import { HealthCheckAbortError, waitForHealthy } from "./health-check";

describe("waitForHealthy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries ordinary errors until the check passes", async () => {
    const checkFn = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await waitForHealthy({ checkFn, timeoutMs: 1000, intervalMs: 1 });

    expect(checkFn).toHaveBeenCalledTimes(3);
  });

  it("stops at the first HealthCheckAbortError and rethrows it", async () => {
    const abort = new HealthCheckAbortError("process exited");
    const checkFn = vi.fn<() => Promise<boolean>>().mockRejectedValue(abort);

    await expect(waitForHealthy({ checkFn, timeoutMs: 1000, intervalMs: 1 })).rejects.toBe(abort);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("throws the configured message on timeout", async () => {
    vi.useFakeTimers();
    const checkFn = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const result = waitForHealthy({
      checkFn,
      timeoutMs: 500,
      intervalMs: 100,
      errorMessage: "late",
    });
    const assertion = expect(result).rejects.toThrow("late");
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });
});
