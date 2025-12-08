// @vitest-environment node
/**
 * Tests for HTTP utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithTimeout } from "./http";

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns response on successful fetch", async () => {
    const mockResponse = new Response(JSON.stringify({ data: "test" }), {
      status: 200,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const response = await fetchWithTimeout("http://localhost:8080/test");

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ data: "test" });
  });

  it("passes abort signal to fetch", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    await fetchWithTimeout("http://localhost:8080/test");

    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:8080/test", {
      signal: expect.any(AbortSignal),
    });
  });

  it("propagates fetch errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    await expect(fetchWithTimeout("http://localhost:8080/test")).rejects.toThrow("Network error");
  });

  it("clears timeout on successful completion", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await fetchWithTimeout("http://localhost:8080/test");

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("clears timeout on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(fetchWithTimeout("http://localhost:8080/test")).rejects.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("accepts custom timeout option", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await fetchWithTimeout("http://localhost:8080/test", { timeout: 10000 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10000);
  });

  it("uses default timeout of 5000ms", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await fetchWithTimeout("http://localhost:8080/test");

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  it("aborts on timeout", async () => {
    // Real abort behavior - simulate by returning a promise that never resolves
    // and verifying it aborts when signal is triggered
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise((_, reject) => {
          const signal = options?.signal;
          if (signal) {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }
        })
    );

    // Use a very short timeout to test quickly without fake timers
    const fetchPromise = fetchWithTimeout("http://localhost:8080/test", {
      timeout: 10,
    });

    await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts when external signal is aborted", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise((_, reject) => {
          const signal = options?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }
        })
    );

    const fetchPromise = fetchWithTimeout("http://localhost:8080/test", {
      signal: controller.signal,
      timeout: 60000, // Long timeout so we know it's the external signal
    });

    // Abort immediately
    controller.abort();

    await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" });
  });
});
