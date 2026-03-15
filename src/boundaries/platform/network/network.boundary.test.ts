/**
 * Boundary tests for network layer - tests against real HTTP servers and network operations.
 *
 * Note: SSE boundary tests were previously here but have been removed after
 * migrating OpenCodeClient to use the @opencode-ai/sdk which handles SSE internally.
 * SSE boundary testing is now the responsibility of the SDK.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "net";
import { DefaultNetworkLayer, type HttpClient, type PortManager } from "./network";
import { createTestServer, type TestServer } from "./network.test-utils";
import { SILENT_LOGGER } from "../logging";

// ============================================================================
// Constants
// ============================================================================

const TEST_TIMEOUT_MS = process.env.CI ? 30000 : 10000;

// ============================================================================
// Test Server Helper Tests (validates our test infrastructure)
// ============================================================================

describe("TestServer helper", () => {
  let server: TestServer;

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it("start() resolves without error", async () => {
    server = createTestServer();
    await expect(server.start()).resolves.not.toThrow();
  });

  it("getPort() returns port > 0 after start", async () => {
    server = createTestServer();
    await server.start();

    const port = server.getPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("getPort() throws if called before start", () => {
    server = createTestServer();

    expect(() => server.getPort()).toThrow("Server not started");
  });

  it(
    "server responds to GET /json with 200 status",
    async () => {
      server = createTestServer();
      await server.start();

      const response = await fetch(server.url("/json"));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ status: "ok" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "stop() resolves within 1000ms",
    async () => {
      server = createTestServer();
      await server.start();

      const start = Date.now();
      await server.stop();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
    },
    TEST_TIMEOUT_MS
  );

  it("stop() resolves even if server already stopped", async () => {
    server = createTestServer();
    await server.start();
    await server.stop();

    // Second stop should not throw
    await expect(server.stop()).resolves.not.toThrow();
  });
});

// ============================================================================
// PortManager Boundary Tests
// ============================================================================
//
// NOTE: These tests cover the PortManager interface functionality that was
// originally tested through a standalone `findAvailablePort()` function in
// `process.test.ts`. That file was deleted when the function was moved into
// the `DefaultNetworkLayer` class as `PortManager.findFreePort()`. The same
// test coverage (valid port range, bindability, concurrent calls) is provided
// here through the unified NetworkLayer interface.
// ============================================================================

describe("DefaultNetworkLayer boundary tests", () => {
  describe("PortManager.isPortAvailable()", () => {
    let networkLayer: PortManager;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    });

    it("returns true for unused port", async () => {
      // Find a free port first
      const port = await networkLayer.findFreePort();

      const available = await networkLayer.isPortAvailable(port);
      expect(available).toBe(true);
    });

    it("returns false when port is in use", async () => {
      const server = createServer();

      // Bind to a random port
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = (address as { port: number }).port;

      try {
        const available = await networkLayer.isPortAvailable(port);
        expect(available).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns true after port is released", async () => {
      const server = createServer();

      // Bind and release
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = (address as { port: number }).port;
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // Port should now be available
      const available = await networkLayer.isPortAvailable(port);
      expect(available).toBe(true);
    });
  });

  describe("PortManager.findFreePort()", () => {
    let networkLayer: PortManager;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    });

    it("findFreePort returns valid port number (1024-65535)", async () => {
      const port = await networkLayer.findFreePort();

      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it("findFreePort returns port that can be bound immediately", async () => {
      const port = await networkLayer.findFreePort();

      // Try to bind to the returned port
      const server = createServer();

      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve());
        });
      });
    });

    it("findFreePort handles concurrent calls", async () => {
      const ports = await Promise.all([
        networkLayer.findFreePort(),
        networkLayer.findFreePort(),
        networkLayer.findFreePort(),
      ]);

      // All ports should be valid
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(1024);
        expect(port).toBeLessThanOrEqual(65535);
      }

      // All ports should be unique
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(3);
    });

    it("handles 100 concurrent calls with all unique ports", async () => {
      const COUNT = 100;
      const ports = await Promise.all(
        Array.from({ length: COUNT }, () => networkLayer.findFreePort())
      );

      // All ports should be valid
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(1024);
        expect(port).toBeLessThanOrEqual(65535);
      }

      // All ports should be unique
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(COUNT);

      // All ports should be bindable (verify first 5 to avoid test slowness)
      const serversToTest = ports.slice(0, 5);
      for (const port of serversToTest) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.on("error", reject);
          server.listen(port, () => {
            server.close(() => resolve());
          });
        });
      }
    }, 30000); // 30s timeout for stress test
  });

  // ============================================================================
  // HttpClient Boundary Tests
  // ============================================================================

  describe("HttpClient", () => {
    let httpServer: TestServer;
    let httpClient: HttpClient;

    beforeAll(async () => {
      httpServer = createTestServer();
      await httpServer.start();
    });

    afterAll(async () => {
      await httpServer.stop();
    });

    beforeEach(() => {
      httpClient = new DefaultNetworkLayer(SILENT_LOGGER);
    });

    describe("successful requests", () => {
      it(
        "fetches JSON from real endpoint",
        async () => {
          const response = await httpClient.fetch(httpServer.url("/json"));

          expect(response.ok).toBe(true);
          expect(response.status).toBe(200);

          const data = await response.json();
          expect(data).toEqual({ status: "ok" });
        },
        TEST_TIMEOUT_MS
      );

      it(
        "returns non-2xx status without throwing",
        async () => {
          const response = await httpClient.fetch(httpServer.url("/error/404"));

          // Should NOT throw - returns the response
          expect(response.ok).toBe(false);
          expect(response.status).toBe(404);

          const data = await response.json();
          expect(data).toEqual({ error: "Not Found" });
        },
        TEST_TIMEOUT_MS
      );

      it(
        "returns 500 error status without throwing",
        async () => {
          const response = await httpClient.fetch(httpServer.url("/error/500"));

          expect(response.ok).toBe(false);
          expect(response.status).toBe(500);

          const data = await response.json();
          expect(data).toEqual({ error: "Internal Server Error" });
        },
        TEST_TIMEOUT_MS
      );

      it(
        "uses default 5000ms timeout when not specified",
        async () => {
          // The /slow endpoint has SLOW_ENDPOINT_DELAY_MS = 2000ms
          // Default timeout is 5000ms, so this should succeed
          const response = await httpClient.fetch(httpServer.url("/slow"));

          expect(response.ok).toBe(true);
          expect(response.status).toBe(200);
        },
        TEST_TIMEOUT_MS
      );
    });

    describe("timeout behavior", () => {
      it(
        "times out on slow endpoint when timeout < delay",
        async () => {
          // /timeout never responds, so any timeout should trigger
          await expect(
            httpClient.fetch(httpServer.url("/timeout"), { timeout: 100 })
          ).rejects.toThrow();
        },
        TEST_TIMEOUT_MS
      );

      it(
        "respects custom timeout value",
        async () => {
          // Use a 200ms timeout with /timeout endpoint (never responds)
          const start = Date.now();

          await expect(
            httpClient.fetch(httpServer.url("/timeout"), { timeout: 200 })
          ).rejects.toThrow();

          const elapsed = Date.now() - start;
          // Should timeout at roughly 200ms (allow some tolerance)
          expect(elapsed).toBeGreaterThanOrEqual(180);
          expect(elapsed).toBeLessThan(500); // Should not wait too long
        },
        TEST_TIMEOUT_MS
      );

      it(
        "throws AbortError on timeout",
        async () => {
          try {
            await httpClient.fetch(httpServer.url("/timeout"), { timeout: 100 });
            // Should not reach here
            expect.fail("Expected fetch to throw");
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).name).toBe("AbortError");
          }
        },
        TEST_TIMEOUT_MS
      );

      it(
        "timeout triggers AFTER the timeout duration",
        async () => {
          const timeout = 300;
          const start = Date.now();

          try {
            await httpClient.fetch(httpServer.url("/timeout"), { timeout });
            expect.fail("Expected fetch to throw");
          } catch {
            const elapsed = Date.now() - start;
            // Should NOT timeout before the specified duration
            expect(elapsed).toBeGreaterThanOrEqual(timeout - 20); // Small tolerance for timing
          }
        },
        TEST_TIMEOUT_MS
      );

      it(
        "handles multiple concurrent requests with different timeouts",
        async () => {
          // Request 1: Fast (100ms timeout) - should timeout first
          // Request 2: Slow (500ms timeout) - should timeout second
          const fast = httpClient.fetch(httpServer.url("/timeout"), { timeout: 100 });
          const slow = httpClient.fetch(httpServer.url("/timeout"), { timeout: 500 });

          const fastStart = Date.now();

          // Fast should timeout around 100ms
          await expect(fast).rejects.toThrow();
          const fastElapsed = Date.now() - fastStart;
          expect(fastElapsed).toBeGreaterThanOrEqual(80);
          expect(fastElapsed).toBeLessThan(300);

          // Slow should still be pending (not resolved yet)
          // Wait for it to timeout
          await expect(slow).rejects.toThrow();
          const totalElapsed = Date.now() - fastStart;
          // Total should be at least 500ms (slow timeout)
          expect(totalElapsed).toBeGreaterThanOrEqual(480);
        },
        TEST_TIMEOUT_MS
      );
    });

    describe("error handling", () => {
      // Platform detection following process.boundary.test.ts pattern
      const isWindows = process.platform === "win32";

      it.skipIf(isWindows)(
        "handles connection refused when no server",
        async () => {
          // Port 59999 should not have a server running
          // (If flaky, could find an unused port first)
          const unusedPort = 59999;

          try {
            await httpClient.fetch(`http://127.0.0.1:${unusedPort}/test`, { timeout: 1000 });
            expect.fail("Expected fetch to throw");
          } catch (error) {
            // On Node.js, connection refused errors are wrapped in TypeError with "fetch failed"
            // The actual ECONNREFUSED is in error.cause
            expect(error).toBeInstanceOf(Error);
            const err = error as Error & { cause?: Error & { code?: string } };

            // Either the message contains "fetch failed" (Node.js native fetch)
            // or it contains ECONNREFUSED directly
            const message = err.message.toLowerCase();
            const causeCode = err.cause?.code?.toLowerCase();

            expect(
              message.includes("fetch failed") ||
                message.includes("econnrefused") ||
                causeCode === "econnrefused"
            ).toBe(true);
          }
        },
        TEST_TIMEOUT_MS
      );

      it(
        "handles abort signal cancellation",
        async () => {
          const controller = new AbortController();

          // Start a slow request
          const fetchPromise = httpClient.fetch(httpServer.url("/slow"), {
            signal: controller.signal,
          });

          // Abort after a short delay
          setTimeout(() => controller.abort(), 50);

          try {
            await fetchPromise;
            expect.fail("Expected fetch to throw on abort");
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).name).toBe("AbortError");
          }
        },
        TEST_TIMEOUT_MS
      );

      it(
        "abort signal takes precedence over timeout",
        async () => {
          const controller = new AbortController();
          const start = Date.now();

          // Request with 1000ms timeout, but abort after 100ms
          const fetchPromise = httpClient.fetch(httpServer.url("/timeout"), {
            timeout: 1000,
            signal: controller.signal,
          });

          setTimeout(() => controller.abort(), 100);

          try {
            await fetchPromise;
            expect.fail("Expected fetch to throw");
          } catch (error) {
            const elapsed = Date.now() - start;
            // Should abort around 100ms, not wait for 1000ms timeout
            expect(elapsed).toBeLessThan(500);
            expect((error as Error).name).toBe("AbortError");
          }
        },
        TEST_TIMEOUT_MS
      );

      it(
        "already-aborted signal throws immediately",
        async () => {
          const controller = new AbortController();
          controller.abort(); // Pre-abort

          try {
            await httpClient.fetch(httpServer.url("/json"), {
              signal: controller.signal,
            });
            expect.fail("Expected fetch to throw");
          } catch (error) {
            expect((error as Error).name).toBe("AbortError");
          }
        },
        TEST_TIMEOUT_MS
      );
    });
  });
});
