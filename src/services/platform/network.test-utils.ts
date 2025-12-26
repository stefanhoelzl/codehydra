/**
 * Test utilities for network layer mocking and boundary testing.
 *
 * Provides mock factories for HttpClient and PortManager
 * to enable easy unit testing of consumers.
 *
 * Also provides test server helpers for boundary tests against real HTTP servers.
 */

import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { type HttpClient, type HttpRequestOptions, type PortManager } from "./network";

// ============================================================================
// Mock Option Types
// ============================================================================

/**
 * Options for creating a mock HttpClient.
 */
export interface MockHttpClientOptions {
  /** Response to return from fetch. Default: 200 OK with empty body */
  readonly response?: Response;
  /** Error to throw from fetch */
  readonly error?: Error;
  /** Custom implementation for fetch */
  readonly implementation?: (url: string, options?: HttpRequestOptions) => Promise<Response>;
}

/**
 * Options for creating a mock PortManager.
 */
export interface MockPortManagerOptions {
  /** Options for findFreePort */
  readonly findFreePort?: { port?: number; error?: Error };
}

// ============================================================================
// Mock HTTP Client
// ============================================================================

/**
 * Create a mock HttpClient for testing.
 *
 * @example Basic usage - returns 200 OK
 * const httpClient = createMockHttpClient();
 *
 * @example Return custom response
 * const httpClient = createMockHttpClient({
 *   response: new Response('{"status":"ok"}', { status: 200 })
 * });
 *
 * @example Throw error
 * const httpClient = createMockHttpClient({
 *   error: new Error('Connection refused')
 * });
 *
 * @example Custom implementation
 * const httpClient = createMockHttpClient({
 *   implementation: async (url) => {
 *     if (url.includes('/health')) return new Response('ok');
 *     throw new Error('Not found');
 *   }
 * });
 */
export function createMockHttpClient(options?: MockHttpClientOptions): HttpClient {
  const defaultResponse = new Response("", { status: 200 });

  return {
    fetch: async (url: string, fetchOptions?: HttpRequestOptions): Promise<Response> => {
      if (options?.implementation) {
        return options.implementation(url, fetchOptions);
      }
      if (options?.error) {
        throw options.error;
      }
      return options?.response ?? defaultResponse;
    },
  };
}

// ============================================================================
// Mock Port Manager
// ============================================================================

/**
 * Create a mock PortManager for testing.
 *
 * @example Basic usage - returns port 8080
 * const portManager = createMockPortManager();
 *
 * @example Return custom port
 * const portManager = createMockPortManager({
 *   findFreePort: { port: 3000 }
 * });
 *
 * @example Throw errors
 * const portManager = createMockPortManager({
 *   findFreePort: { error: new Error('No ports available') }
 * });
 */
export function createMockPortManager(options?: MockPortManagerOptions): PortManager {
  return {
    findFreePort: async (): Promise<number> => {
      if (options?.findFreePort?.error) {
        throw options.findFreePort.error;
      }
      return options?.findFreePort?.port ?? 8080;
    },
  };
}

// ============================================================================
// Test Server for Boundary Tests
// ============================================================================

/**
 * Delay for slow endpoint responses in boundary tests.
 */
export const SLOW_ENDPOINT_DELAY_MS = 2000;

/**
 * Route handler for test server.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Test HTTP server for boundary tests.
 */
export interface TestServer {
  /** Get the port the server is listening on. Throws if not started. */
  getPort(): number;
  /** Start the server. Resolves when listening. */
  start(): Promise<void>;
  /** Stop the server. Resolves when closed. Safe to call multiple times. */
  stop(): Promise<void>;
  /** Build URL for a given path. */
  url(path: string): string;
}

/**
 * Create a test HTTP server for boundary tests.
 *
 * By default includes these routes:
 * - GET /json → 200, {"status": "ok"}
 * - GET /echo-headers → 200, returns request headers as JSON
 * - GET /slow → 200 after SLOW_ENDPOINT_DELAY_MS (2000ms)
 * - GET /timeout → Never responds (for timeout testing)
 * - GET /error/404 → 404 Not Found
 * - GET /error/500 → 500 Internal Server Error
 *
 * @param routes - Custom routes to add or override defaults
 *
 * @example Basic usage
 * const server = createTestServer();
 * await server.start();
 * const response = await fetch(server.url('/json'));
 * await server.stop();
 *
 * @example Custom routes
 * const server = createTestServer({
 *   '/custom': (req, res) => {
 *     res.writeHead(200);
 *     res.end('custom response');
 *   }
 * });
 */
export function createTestServer(routes?: Record<string, RouteHandler>): TestServer {
  let serverPort: number | null = null;
  let server: Server | null = null;

  const defaultRoutes: Record<string, RouteHandler> = {
    "/json": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    },
    "/echo-headers": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.headers));
    },
    "/slow": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      }, SLOW_ENDPOINT_DELAY_MS);
    },
    "/timeout": () => {
      // Never responds - for timeout testing
    },
    "/error/404": (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    },
    "/error/500": (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    },
  };

  const allRoutes = { ...defaultRoutes, ...routes };

  return {
    getPort(): number {
      if (serverPort === null) {
        throw new Error("Server not started - call start() first");
      }
      return serverPort;
    },

    async start(): Promise<void> {
      if (server) return; // Already started

      server = createHttpServer((req, res) => {
        const handler = allRoutes[req.url ?? ""];
        if (handler) {
          handler(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve, reject) => {
        // CRITICAL: Bind to localhost only for security
        server!.listen(0, "localhost", () => {
          const addr = server!.address();
          if (addr && typeof addr === "object") {
            serverPort = addr.port;
            resolve();
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
        server!.on("error", reject);
      });
    },

    async stop(): Promise<void> {
      if (!server || serverPort === null) {
        return; // Already stopped or never started
      }

      await new Promise<void>((resolve) => {
        // Always resolve, even on error (server may already be closed)
        server!.close(() => {
          serverPort = null;
          server = null;
          resolve();
        });
      });
    },

    url(path: string): string {
      if (serverPort === null) {
        throw new Error("Server not started - call start() first");
      }
      return `http://localhost:${serverPort}${path}`;
    },
  };
}

// ============================================================================
// Port Waiting Utility
// ============================================================================

/**
 * Default timeout for CI environment (longer to account for slow CI machines).
 */
export const CI_TIMEOUT_MS = 30000;

/**
 * Default timeout for local development.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Interval between port check attempts.
 */
const PORT_CHECK_INTERVAL_MS = 100;

/**
 * Wait for a port to become available (accepting connections).
 *
 * Uses dynamic timeout based on CI environment.
 * Polls the port with TCP connection attempts.
 *
 * @param port - Port number to wait for
 * @param timeoutMs - Maximum time to wait (defaults based on CI environment)
 * @returns Resolves when port is accepting connections
 * @throws Error if timeout is reached
 *
 * @example
 * ```ts
 * // Start a server process
 * const proc = await startServer();
 *
 * // Wait for it to be ready
 * await waitForPort(8080);
 *
 * // Now safe to connect
 * ```
 */
export async function waitForPort(port: number, timeoutMs?: number): Promise<void> {
  const timeout = timeoutMs ?? (process.env.CI ? CI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await isPortOpen(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_CHECK_INTERVAL_MS));
  }

  throw new Error(`Timeout waiting for port ${port} to become available (${timeout}ms)`);
}

/**
 * Check if a port is open and accepting connections.
 *
 * @param port - Port number to check
 * @returns true if port is accepting connections
 */
async function isPortOpen(port: number): Promise<boolean> {
  const { createConnection } = await import("net");

  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "localhost" }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    // Set a short timeout for connection attempt
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
