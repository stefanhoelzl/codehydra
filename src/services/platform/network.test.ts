/**
 * Tests for network layer interfaces and implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "net";
import { DefaultNetworkLayer, type HttpClient, type PortManager } from "./network";

describe("DefaultNetworkLayer", () => {
  describe("HttpClient.fetch()", () => {
    let networkLayer: HttpClient;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer();
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
      const customLayer = new DefaultNetworkLayer({ defaultTimeout: 50 });
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

  describe("PortManager.findFreePort()", () => {
    let networkLayer: PortManager;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer();
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
        server.listen(port, () => {
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
  });

  describe("PortManager.getListeningPorts()", () => {
    let networkLayer: PortManager;
    let testServer: Server | null = null;

    beforeEach(() => {
      networkLayer = new DefaultNetworkLayer();
    });

    afterEach(async () => {
      if (testServer) {
        await new Promise<void>((resolve, reject) => {
          testServer!.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }).catch(() => {
          // Server already closed
        });
        testServer = null;
      }
    });

    it("getListeningPorts returns array of ListeningPort", async () => {
      // Create a server to ensure at least one listening port
      testServer = createServer();
      await new Promise<void>((resolve) => testServer!.listen(0, () => resolve()));

      const ports = await networkLayer.getListeningPorts();

      expect(Array.isArray(ports)).toBe(true);

      // There should be at least one port (our test server)
      expect(ports.length).toBeGreaterThan(0);

      // Verify structure
      for (const portInfo of ports) {
        expect(typeof portInfo.port).toBe("number");
        expect(typeof portInfo.pid).toBe("number");
        expect(portInfo.pid).toBeGreaterThan(0);
      }
    });

    it("getListeningPorts includes our test server port", async () => {
      // Create a server on a specific port
      testServer = createServer();
      await new Promise<void>((resolve) => testServer!.listen(0, () => resolve()));

      const serverAddress = testServer.address();
      const serverPort =
        typeof serverAddress === "object" && serverAddress ? serverAddress.port : 0;

      const ports = await networkLayer.getListeningPorts();
      const foundPort = ports.find((p) => p.port === serverPort);

      expect(foundPort).toBeDefined();
      expect(foundPort?.pid).toBe(process.pid);
    });
  });

  describe("SseClient.createSseConnection()", () => {
    let networkLayer: DefaultNetworkLayer;
    let mockEventSource: {
      onopen: ((event: Event) => void) | null;
      onerror: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      close: ReturnType<typeof vi.fn>;
      readyState: number;
    };

    beforeEach(() => {
      vi.useFakeTimers();

      // Create a mock EventSource
      mockEventSource = {
        onopen: null,
        onerror: null,
        onmessage: null,
        close: vi.fn(),
        readyState: 0,
      };

      // Create network layer with mocked EventSource
      networkLayer = new DefaultNetworkLayer();
      vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      ).mockReturnValue(mockEventSource as unknown as EventSource);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("SSE connects and fires onStateChange(true)", async () => {
      const stateHandler = vi.fn();

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");
      conn.onStateChange(stateHandler);

      // Flush microtasks to trigger connection
      await vi.advanceTimersByTimeAsync(0);

      // Simulate connection open
      mockEventSource.onopen?.(new Event("open"));

      expect(stateHandler).toHaveBeenCalledWith(true);
    });

    it("SSE delivers messages via onMessage handler", async () => {
      const messageHandler = vi.fn();

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");
      conn.onMessage(messageHandler);

      // Flush microtasks to trigger connection
      await vi.advanceTimersByTimeAsync(0);

      // Simulate connection open
      mockEventSource.onopen?.(new Event("open"));

      // Simulate message
      const messageEvent = new MessageEvent("message", { data: '{"type":"test"}' });
      mockEventSource.onmessage?.(messageEvent);

      expect(messageHandler).toHaveBeenCalledWith('{"type":"test"}');
    });

    it("SSE fires onStateChange(false) on error", async () => {
      const stateHandler = vi.fn();

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");
      conn.onStateChange(stateHandler);

      // Flush microtasks to trigger connection
      await vi.advanceTimersByTimeAsync(0);

      // Simulate error
      mockEventSource.onerror?.(new Event("error"));

      expect(stateHandler).toHaveBeenCalledWith(false);
    });

    it("SSE reconnects after 1s on first failure", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);

      // Initial connection
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Simulate error
      mockEventSource.onerror?.(new Event("error"));

      // Advance less than 1s
      await vi.advanceTimersByTimeAsync(999);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Advance past 1s
      await vi.advanceTimersByTimeAsync(2);
      expect(createSpy).toHaveBeenCalledTimes(2);
    });

    it("SSE backoff doubles each retry (1s → 2s → 4s → 8s)", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // First failure - reconnect after 1s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(createSpy).toHaveBeenCalledTimes(2);

      // Second failure - reconnect after 2s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(createSpy).toHaveBeenCalledTimes(3);

      // Third failure - reconnect after 4s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(4000);
      expect(createSpy).toHaveBeenCalledTimes(4);

      // Fourth failure - reconnect after 8s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(8000);
      expect(createSpy).toHaveBeenCalledTimes(5);
    });

    it("SSE backoff caps at maxReconnectDelay", async () => {
      // Use shorter max delay for testing
      const shortDelayLayer = new DefaultNetworkLayer({ maxReconnectDelay: 4000 });
      const shortDelayCreateSpy = vi
        .spyOn(
          shortDelayLayer as unknown as { createEventSource: (url: string) => EventSource },
          "createEventSource"
        )
        .mockReturnValue(mockEventSource as unknown as EventSource);

      shortDelayLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(1);

      // First failure - reconnect after 1s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(2);

      // Second failure - reconnect after 2s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(3);

      // Third failure - reconnect after 4s (max)
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(4000);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(4);

      // Fourth failure - should still use 4s (capped, not 8s)
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(3999);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(4); // Not yet
      await vi.advanceTimersByTimeAsync(2);
      expect(shortDelayCreateSpy).toHaveBeenCalledTimes(5); // Now reconnected
    });

    it("SSE backoff resets to initial after successful connect", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // First failure - reconnect after 1s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(createSpy).toHaveBeenCalledTimes(2);

      // Second failure - reconnect after 2s
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(createSpy).toHaveBeenCalledTimes(3);

      // Successful connection - should reset delay
      mockEventSource.onopen?.(new Event("open"));

      // Third failure - should use initial 1s delay again
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(createSpy).toHaveBeenCalledTimes(4);
    });

    it("SSE disconnect() stops reconnection attempts", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Disconnect
      conn.disconnect();

      // Simulate error (shouldn't trigger reconnection)
      mockEventSource.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(5000);

      // Should not have reconnected
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it("SSE disconnect() clears pending timers", async () => {
      const conn = networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);

      // Simulate error to start reconnection timer
      mockEventSource.onerror?.(new Event("error"));

      // Disconnect before timer fires
      conn.disconnect();

      // Advance time
      await vi.advanceTimersByTimeAsync(5000);

      // Verify no timer leaks
      expect(vi.getTimerCount()).toBe(0);
    });

    it("SSE disconnect() during backoff wait cancels reconnect", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Simulate error to start reconnection timer
      mockEventSource.onerror?.(new Event("error"));

      // Wait half the delay
      await vi.advanceTimersByTimeAsync(500);

      // Disconnect during backoff
      conn.disconnect();

      // Advance past when reconnection would have happened
      await vi.advanceTimersByTimeAsync(1000);

      // Should not have reconnected
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it("SSE handles EventSource constructor error", async () => {
      const stateHandler = vi.fn();

      // Make EventSource throw on construction
      vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      ).mockImplementation(() => {
        throw new Error("Invalid URL");
      });

      const conn = networkLayer.createSseConnection("invalid://url");
      conn.onStateChange(stateHandler);

      // Flush microtasks to trigger connection attempt
      await vi.advanceTimersByTimeAsync(0);

      // Should have notified disconnected
      expect(stateHandler).toHaveBeenCalledWith(false);
    });

    it("SSE ignores events after disconnect()", async () => {
      const messageHandler = vi.fn();
      const stateHandler = vi.fn();

      const conn = networkLayer.createSseConnection("http://localhost:8080/events");
      conn.onMessage(messageHandler);
      conn.onStateChange(stateHandler);

      // Flush microtasks to trigger connection
      await vi.advanceTimersByTimeAsync(0);

      // Simulate connection open
      mockEventSource.onopen?.(new Event("open"));

      // Disconnect
      conn.disconnect();

      // Clear the mock to only track events after disconnect
      stateHandler.mockClear();
      messageHandler.mockClear();

      // Try to send events (these should be ignored)
      mockEventSource.onopen?.(new Event("open"));
      mockEventSource.onmessage?.(new MessageEvent("message", { data: "test" }));

      expect(stateHandler).not.toHaveBeenCalled();
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it("SSE does not reconnect when reconnect option is false", async () => {
      const createSpy = vi.spyOn(
        networkLayer as unknown as { createEventSource: (url: string) => EventSource },
        "createEventSource"
      );

      networkLayer.createSseConnection("http://localhost:8080/events", { reconnect: false });

      // Flush microtasks to trigger initial connection
      await vi.advanceTimersByTimeAsync(0);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Simulate error
      mockEventSource.onerror?.(new Event("error"));

      // Advance time
      await vi.advanceTimersByTimeAsync(5000);

      // Should not have reconnected
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });
});
