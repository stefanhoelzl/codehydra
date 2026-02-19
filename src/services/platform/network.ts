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

import { createServer } from "net";
import type { Logger } from "../logging";
import { getErrorMessage } from "../errors";

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
   * Find a free port on localhost.
   *
   * Uses TCP server bind to port 0, which lets the OS assign an available port.
   * Port is released after discovery, so there's a small race window.
   * Callers should handle EADDRINUSE and retry if needed.
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
// Configuration
// ============================================================================

/**
 * Configuration for DefaultNetworkLayer.
 */
export interface NetworkLayerConfig {
  /** Default timeout for HTTP requests in ms. Default: 5000 */
  readonly defaultTimeout?: number;
}

// ============================================================================
// Default Implementation
// ============================================================================

/**
 * Default implementation of network interfaces.
 * Implements HttpClient and PortManager.
 */
export class DefaultNetworkLayer implements HttpClient, PortManager {
  private readonly config: Required<NetworkLayerConfig>;
  private readonly logger: Logger;

  constructor(logger: Logger, config: NetworkLayerConfig = {}) {
    this.logger = logger;
    this.config = {
      defaultTimeout: config.defaultTimeout ?? 5000,
    };
  }

  // HttpClient implementation
  async fetch(url: string, options?: HttpRequestOptions): Promise<Response> {
    const timeout = options?.timeout ?? this.config.defaultTimeout;
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
      const response = await fetch(url, { signal: controller.signal });
      this.logger.debug("Fetch complete", { url, status: response.status });
      return response;
    } catch (error) {
      this.logger.warn("Fetch failed", { url, error: getErrorMessage(error) });
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // PortManager implementation
  async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const { port } = address;
          this.logger.debug("Found free port", { port });
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Failed to get port from server address")));
        }
      });
      server.on("error", reject);
    });
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
