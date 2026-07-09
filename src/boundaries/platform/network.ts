/**
 * Network layer interfaces and implementation.
 *
 * Provides focused, injectable network interfaces following Interface Segregation Principle:
 * - HttpClient: HTTP requests with timeout support
 * - PortManager: Port discovery and allocation
 *
 * Note: SSE (Server-Sent Events) functionality was previously provided here but has been
 * removed in favor of the @opencode-ai/sdk which handles SSE internally.
 */

import { createServer, type Server } from "net";
import type { Logger } from "./logging";
import { getErrorMessage } from "../../shared/errors/service-errors";

// ============================================================================
// HTTP Client Interface
// ============================================================================

/**
 * Options for HTTP requests.
 */
export interface HttpRequestOptions {
  /** Timeout in milliseconds. Default: 5000 */
  readonly timeout?: number;
  /** External abort signal to cancel the request */
  readonly signal?: AbortSignal;
  /** Optional HTTP headers to include in the request */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * HTTP client for making fetch requests with timeout support.
 */
export interface HttpClient {
  /**
   * HTTP GET request with timeout support.
   *
   * @param url - URL to fetch
   * @param options - Request options
   * @returns Response object
   * @throws DOMException with name "AbortError" on timeout or abort
   * @throws TypeError on network error (connection refused, DNS failure)
   *
   * @example
   * const response = await httpClient.fetch('http://127.0.0.1:8080/api');
   * if (response.ok) {
   *   const data = await response.json();
   * }
   *
   * @example With timeout and abort signal
   * const controller = new AbortController();
   * const response = await httpClient.fetch(url, {
   *   timeout: 10000,
   *   signal: controller.signal
   * });
   */
  fetch(url: string, options?: HttpRequestOptions): Promise<Response>;
}

// ============================================================================
// Port Manager Interface
// ============================================================================

/**
 * Port management operations.
 */
export interface PortManager {
  /**
   * Bind a server to a free localhost port chosen by the OS, and report it.
   *
   * Prefer this over `findFreePort()` whenever the caller owns the server that
   * will hold the port. The port is never released between discovery and use,
   * so there is no race: the socket that is probed is the socket that is kept.
   *
   * @param server - An unbound server to listen on
   * @param host - Interface to bind. Default: 127.0.0.1
   * @returns The port the server is now listening on
   */
  listenOnFreePort(server: Server, host?: string): Promise<number>;

  /**
   * Find a free port on localhost, without holding it.
   *
   * Uses TCP server bind to port 0, which lets the OS assign an available port.
   * The port is released again before this resolves, so the caller may lose it
   * before it binds: either to another process, or — for a few milliseconds —
   * to the kernel still tearing down the probe socket. Callers must handle
   * EADDRINUSE.
   *
   * Only use this when the port must be known before the socket exists, e.g. to
   * pass to a child process that binds it itself. When the caller owns the
   * server, use `listenOnFreePort()` instead.
   *
   * @returns Available port number (1024-65535)
   */
  findFreePort(): Promise<number>;

  /**
   * Check if a specific port is available for binding.
   * Uses TCP server bind to test - if successful, port is free.
   *
   * @param port - Port number to check
   * @returns true if port is available, false if in use
   */
  isPortAvailable(port: number): Promise<boolean>;
}

// ============================================================================
// Default Implementation
// ============================================================================

/** Default timeout for HTTP requests in ms. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Listen on a port and resolve the port actually bound.
 *
 * Pass port 0 to let the OS assign one. The "listening"/"error" pair is settled
 * exactly once, and the loser is unsubscribed so a later error on the server
 * doesn't reject an already-settled promise.
 */
async function listenOnPort(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("Failed to get port from server address");
  }
  return address.port;
}

/**
 * Default implementation of network interfaces.
 * Implements HttpClient and PortManager.
 */
export class DefaultNetworkLayer implements HttpClient, PortManager {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // HttpClient implementation
  async fetch(url: string, options?: HttpRequestOptions): Promise<Response> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const externalSignal = options?.signal;

    this.logger.debug("Fetch", { url, method: "GET" });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, timeout);

    // If an external signal is provided, listen for its abort
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort);
      }
    }

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(options?.headers && { headers: options.headers }),
      });
      this.logger.debug("Fetch complete", { url, status: response.status });
      return response;
    } catch (error) {
      this.logger.silly("Fetch failed", { url, error: getErrorMessage(error) });
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // PortManager implementation
  async listenOnFreePort(server: Server, host = "127.0.0.1"): Promise<number> {
    const port = await listenOnPort(server, 0, host);
    this.logger.debug("Bound free port", { port });
    return port;
  }

  async findFreePort(): Promise<number> {
    const probe = createServer();
    const port = await listenOnPort(probe, 0, "127.0.0.1");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    this.logger.debug("Found free port", { port });
    return port;
  }

  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.logger.debug("Port in use", { port });
          resolve(false);
        } else {
          // Other errors (permissions, etc.) - treat as unavailable
          this.logger.warn("Port check error", { port, error: err.message });
          resolve(false);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        this.logger.debug("Port available", { port });
        server.close(() => resolve(true));
      });
    });
  }
}
