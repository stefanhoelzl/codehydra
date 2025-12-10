/**
 * Network layer interfaces and implementation.
 *
 * Provides focused, injectable network interfaces following Interface Segregation Principle:
 * - HttpClient: HTTP requests with timeout support
 * - SseClient: Server-Sent Events with auto-reconnection
 * - PortManager: Port discovery and allocation
 */

import { EventSource } from "eventsource";

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
   * const response = await httpClient.fetch('http://localhost:8080/api');
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
// SSE Client Interface
// ============================================================================

/**
 * Options for SSE connections.
 */
export interface SseConnectionOptions {
  /** Enable auto-reconnection on disconnect. Default: true */
  readonly reconnect?: boolean;
  /** Initial reconnection delay in ms. Default: 1000 */
  readonly initialReconnectDelay?: number;
  /** Maximum reconnection delay in ms (backoff cap). Default: 30000 */
  readonly maxReconnectDelay?: number;
}

/**
 * SSE connection handle.
 *
 * IMPORTANT: Reconnection timing is handled by the connection.
 * Application-specific logic (what to do on reconnect) is handled
 * by the consumer via onStateChange callback.
 */
export interface SseConnection {
  /**
   * Set message handler. Called for each SSE message.
   * Replaces any previous handler.
   * @param handler - Receives raw message data string (not parsed)
   */
  onMessage(handler: (data: string) => void): void;

  /**
   * Set state change handler. Called on connect/disconnect.
   * Replaces any previous handler.
   *
   * Use this to perform application-specific actions on reconnect,
   * such as re-syncing state from the server.
   *
   * @param handler - Receives true on connect, false on disconnect
   *
   * @example Re-sync state on reconnect (in OpenCodeClient)
   * connection.onStateChange((connected) => {
   *   if (connected) {
   *     // Application-specific: fetch current status after reconnect
   *     void this.getStatus().then((result) => {
   *       if (result.ok) this.updateCurrentStatus(result.value);
   *     });
   *   }
   * });
   */
  onStateChange(handler: (connected: boolean) => void): void;

  /**
   * Disconnect and cleanup.
   * - Closes the EventSource connection
   * - Clears any pending reconnection timers
   * - Prevents future reconnection attempts
   *
   * Safe to call multiple times.
   */
  disconnect(): void;
}

/**
 * Factory for creating SSE connections.
 */
export interface SseClient {
  /**
   * Create SSE connection with auto-reconnection.
   *
   * Connection is established immediately upon creation.
   * Reconnection uses exponential backoff: 1s, 2s, 4s, 8s... up to maxReconnectDelay.
   * Backoff resets to initialReconnectDelay after successful connection.
   *
   * @param url - SSE endpoint URL
   * @param options - Connection options
   * @returns SSE connection handle
   *
   * @example
   * const conn = sseClient.createSseConnection('http://localhost:8080/events');
   * conn.onMessage((data) => console.log('Received:', data));
   * conn.onStateChange((connected) => console.log('Connected:', connected));
   * // Later: conn.disconnect();
   */
  createSseConnection(url: string, options?: SseConnectionOptions): SseConnection;
}

// ============================================================================
// Port Manager Interface
// ============================================================================

/**
 * A port that is listening for connections.
 */
export interface ListeningPort {
  readonly port: number;
  readonly pid: number;
}

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
   * Get all TCP ports currently listening on localhost.
   *
   * Note: This operation may block briefly (100-500ms) while querying
   * system network state via systeminformation library.
   *
   * @returns Array of listening ports with associated PIDs
   */
  getListeningPorts(): Promise<readonly ListeningPort[]>;
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
  /** Initial SSE reconnection delay in ms. Default: 1000 */
  readonly initialReconnectDelay?: number;
  /** Maximum SSE reconnection delay in ms. Default: 30000 */
  readonly maxReconnectDelay?: number;
}

// ============================================================================
// Default Implementation
// ============================================================================

/**
 * Default implementation of network interfaces.
 * Implements HttpClient, SseClient, and PortManager.
 */
export class DefaultNetworkLayer implements HttpClient, SseClient, PortManager {
  private readonly config: Required<NetworkLayerConfig>;

  constructor(config: NetworkLayerConfig = {}) {
    this.config = {
      defaultTimeout: config.defaultTimeout ?? 5000,
      initialReconnectDelay: config.initialReconnectDelay ?? 1000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000,
    };
  }

  // HttpClient implementation
  async fetch(url: string, options?: HttpRequestOptions): Promise<Response> {
    const timeout = options?.timeout ?? this.config.defaultTimeout;
    const externalSignal = options?.signal;

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
      return response;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // PortManager implementation
  async findFreePort(): Promise<number> {
    const { createServer } = await import("net");

    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const { port } = address;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Failed to get port from server address")));
        }
      });
      server.on("error", reject);
    });
  }

  async getListeningPorts(): Promise<readonly ListeningPort[]> {
    const si = await import("systeminformation");
    const connections = await si.default.networkConnections();

    if (!Array.isArray(connections)) return [];

    return connections
      .filter(
        (conn): conn is typeof conn & { localPort: string; pid: number } =>
          conn !== null &&
          conn.state === "LISTEN" &&
          typeof conn.localPort === "string" &&
          typeof conn.pid === "number" &&
          conn.pid > 0
      )
      .map((conn) => ({
        port: parseInt(conn.localPort, 10),
        pid: conn.pid,
      }));
  }

  // SseClient implementation
  createSseConnection(url: string, options?: SseConnectionOptions): SseConnection {
    return new DefaultSseConnection(
      url,
      {
        reconnect: options?.reconnect ?? true,
        initialReconnectDelay: options?.initialReconnectDelay ?? this.config.initialReconnectDelay,
        maxReconnectDelay: options?.maxReconnectDelay ?? this.config.maxReconnectDelay,
      },
      this.createEventSource.bind(this)
    );
  }

  /**
   * Create an EventSource instance. Extracted for testability.
   */
  protected createEventSource(url: string): EventSource {
    return new EventSource(url);
  }
}

/**
 * Default SSE connection implementation with auto-reconnection.
 */
class DefaultSseConnection implements SseConnection {
  private eventSource: EventSource | null = null;
  private messageHandler: ((data: string) => void) | null = null;
  private stateHandler: ((connected: boolean) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private disposed = false;

  private readonly shouldReconnect: boolean;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly createEventSource: (url: string) => EventSource;

  constructor(
    private readonly url: string,
    options: Required<
      Pick<SseConnectionOptions, "reconnect" | "initialReconnectDelay" | "maxReconnectDelay">
    >,
    createEventSourceFn: (url: string) => EventSource
  ) {
    this.shouldReconnect = options.reconnect;
    this.initialDelay = options.initialReconnectDelay;
    this.maxDelay = options.maxReconnectDelay;
    this.currentDelay = this.initialDelay;
    this.createEventSource = createEventSourceFn;

    // Connect asynchronously so handlers can be set first
    queueMicrotask(() => {
      if (!this.disposed) {
        this.connect();
      }
    });
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onStateChange(handler: (connected: boolean) => void): void {
    this.stateHandler = handler;
  }

  disconnect(): void {
    this.disposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private connect(): void {
    if (this.disposed) return;

    try {
      this.eventSource = this.createEventSource(this.url);

      this.eventSource.onopen = () => {
        if (this.disposed) return;

        // Reset backoff on successful connection
        this.currentDelay = this.initialDelay;

        // Notify connected
        this.stateHandler?.(true);
      };

      this.eventSource.onerror = () => {
        if (this.disposed) return;

        this.handleDisconnect();
      };

      this.eventSource.onmessage = (event: MessageEvent) => {
        if (this.disposed) return;

        this.messageHandler?.(event.data as string);
      };
    } catch {
      // EventSource constructor can throw on invalid URL
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    // Close current connection
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Notify disconnected
    this.stateHandler?.(false);

    if (this.disposed || !this.shouldReconnect) return;

    // Schedule reconnection with backoff
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) {
        this.connect();
      }
    }, this.currentDelay);

    // Increase delay for next attempt (capped at max)
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
  }
}
