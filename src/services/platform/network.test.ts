/**
 * Tests for network layer interfaces and implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultNetworkLayer, type HttpClient } from "./network";
import { createSilentLogger } from "../logging";

describe("DefaultNetworkLayer", () => {
  describe("HttpClient.fetch()", () => {
    let networkLayer: HttpClient;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer(createSilentLogger());
    });

    it("fetch returns response on success", async () => {
      // This test requires a real server or mock fetch
      // For unit tests, we'll test the behavior with a mock
      const mockResponse = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

      const response = await networkLayer.fetch("http://localhost:8080/test");

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      vi.restoreAllMocks();
    });

    it("fetch times out after specified timeout", async () => {
      // Use real timers with a very short timeout
      let abortTriggered = false;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        // Track if abort is triggered
        init?.signal?.addEventListener("abort", () => {
          abortTriggered = true;
        });

        // Wait longer than the timeout
        return new Promise<Response>((_, reject) => {
          setTimeout(() => {
            if (init?.signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
            }
          }, 200);
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      await expect(
        networkLayer.fetch("http://localhost:8080/slow", { timeout: 50 })
      ).rejects.toThrow();

      expect(abortTriggered).toBe(true);

      vi.restoreAllMocks();
    });

    it("fetch uses default timeout when not specified", async () => {
      // Test that custom default timeout is applied
      const customLayer = new DefaultNetworkLayer(createSilentLogger(), { defaultTimeout: 50 });
      let abortTriggered = false;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        init?.signal?.addEventListener("abort", () => {
          abortTriggered = true;
        });

        return new Promise<Response>((_, reject) => {
          setTimeout(() => {
            if (init?.signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
            }
          }, 200);
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      // Should timeout using the custom default of 50ms
      await expect(customLayer.fetch("http://localhost:8080/slow")).rejects.toThrow();

      expect(abortTriggered).toBe(true);

      vi.restoreAllMocks();
    });

    it("fetch aborts when external signal is aborted", async () => {
      const controller = new AbortController();

      // Mock fetch to check the signal
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        // Wait for abort
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const resultPromise = networkLayer.fetch("http://localhost:8080/test", {
        signal: controller.signal,
      });

      // Abort the request
      controller.abort();

      await expect(resultPromise).rejects.toThrow();

      vi.restoreAllMocks();
    });

    it("fetch clears timeout on completion", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const mockResponse = new Response("ok", { status: 200 });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

      await networkLayer.fetch("http://localhost:8080/test");

      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("fetch clears timeout on error", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

      await expect(networkLayer.fetch("http://localhost:8080/test")).rejects.toThrow();

      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("fetch handles concurrent requests with independent signals", async () => {
      const responses: Response[] = [];
      let callCount = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        callCount++;
        return new Response(`response-${callCount}`, { status: 200 });
      });

      const [r1, r2, r3] = await Promise.all([
        networkLayer.fetch("http://localhost:8080/a"),
        networkLayer.fetch("http://localhost:8080/b"),
        networkLayer.fetch("http://localhost:8080/c"),
      ]);

      responses.push(r1, r2, r3);

      expect(responses).toHaveLength(3);
      expect(callCount).toBe(3);

      vi.restoreAllMocks();
    });

    it("fetch aborts immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response("ok", { status: 200 });
      });

      await expect(
        networkLayer.fetch("http://localhost:8080/test", { signal: controller.signal })
      ).rejects.toThrow();

      vi.restoreAllMocks();
    });
  });
});

describe("waitForPort", () => {
  // Import the function dynamically to avoid import issues
  const getWaitForPort = async () => {
    const { waitForPort } = await import("./network.test-utils");
    return waitForPort;
  };

  it("resolves when port is accepting connections", async () => {
    const { createTestServer } = await import("./network.test-utils");
    const waitForPort = await getWaitForPort();
    const server = createTestServer();
    await server.start();

    try {
      // Port should already be ready
      await expect(waitForPort(server.getPort(), 1000)).resolves.toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("times out when port is not available", async () => {
    const { createServer } = await import("net");
    const waitForPort = await getWaitForPort();

    // Find an unused port by binding to 0, then immediately closing
    // This gives us a port that was just freed and is almost certainly not listening
    const unusedPort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          reject(new Error("Failed to get port"));
        }
      });
    });

    await expect(waitForPort(unusedPort, 200)).rejects.toThrow(
      /Timeout waiting for port \d+ to become available/
    );
  });

  it("handles port becoming available during wait", async () => {
    const { createServer } = await import("net");
    const waitForPort = await getWaitForPort();

    // Find an unused port by binding to 0
    const findUnusedPort = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "localhost", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            const port = addr.port;
            server.close(() => resolve(port));
          } else {
            reject(new Error("Failed to get port"));
          }
        });
      });

    const port = await findUnusedPort();

    // Start a server after a delay
    const serverPromise = new Promise<{ server: ReturnType<typeof createServer>; port: number }>(
      (resolve) => {
        setTimeout(() => {
          const server = createServer();
          server.listen(port, "localhost", () => {
            resolve({ server, port });
          });
        }, 150);
      }
    );

    // Wait for the port to become available
    // This should succeed after the server starts
    await expect(waitForPort(port, 2000)).resolves.toBeUndefined();

    // Cleanup
    const { server } = await serverPromise;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
