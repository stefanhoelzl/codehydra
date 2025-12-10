/**
 * Test utilities for network layer mocking.
 *
 * Provides mock factories for HttpClient, SseClient, PortManager, and SseConnection
 * to enable easy unit testing of consumers.
 */

import {
  type HttpClient,
  type HttpRequestOptions,
  type SseClient,
  type SseConnection,
  type SseConnectionOptions,
  type PortManager,
  type ListeningPort,
} from "./network";

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
  /** Options for getListeningPorts */
  readonly getListeningPorts?: { ports?: ListeningPort[]; error?: Error };
}

/**
 * Options for creating a mock SseClient.
 */
export interface MockSseClientOptions {
  /** Connection to return from createSseConnection */
  readonly connection?: SseConnection;
  /** Custom implementation for createSseConnection */
  readonly implementation?: (url: string, options?: SseConnectionOptions) => SseConnection;
}

/**
 * Options for creating a mock SseConnection.
 */
export interface MockSseConnectionOptions {
  /** Messages to emit (will be emitted asynchronously) */
  readonly messages?: string[];
  /** Initial connected state. Default: true */
  readonly connected?: boolean;
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
 * @example Basic usage - returns port 8080 and empty ports list
 * const portManager = createMockPortManager();
 *
 * @example Return custom port
 * const portManager = createMockPortManager({
 *   findFreePort: { port: 3000 }
 * });
 *
 * @example Return listening ports
 * const portManager = createMockPortManager({
 *   getListeningPorts: { ports: [{ port: 8080, pid: 1234 }] }
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
    getListeningPorts: async (): Promise<readonly ListeningPort[]> => {
      if (options?.getListeningPorts?.error) {
        throw options.getListeningPorts.error;
      }
      return options?.getListeningPorts?.ports ?? [];
    },
  };
}

// ============================================================================
// Mock SSE Connection
// ============================================================================

/**
 * Create a mock SseConnection for testing.
 *
 * @example Basic usage - connected, no messages
 * const connection = createMockSseConnection();
 *
 * @example With messages (emitted asynchronously)
 * const connection = createMockSseConnection({
 *   messages: ['{"type":"status","data":"idle"}', '{"type":"status","data":"busy"}']
 * });
 *
 * @example Disconnected state
 * const connection = createMockSseConnection({
 *   connected: false
 * });
 */
export function createMockSseConnection(options?: MockSseConnectionOptions): SseConnection {
  let messageHandler: ((data: string) => void) | null = null;
  let stateHandler: ((connected: boolean) => void) | null = null;
  let disposed = false;

  // Schedule initial state and messages
  if (options?.connected !== false) {
    queueMicrotask(() => {
      if (!disposed && stateHandler) {
        stateHandler(true);
      }
      // Emit messages after connected
      if (!disposed && messageHandler && options?.messages) {
        for (const message of options.messages) {
          if (!disposed) {
            messageHandler(message);
          }
        }
      }
    });
  } else {
    queueMicrotask(() => {
      if (!disposed && stateHandler) {
        stateHandler(false);
      }
    });
  }

  return {
    onMessage(handler: (data: string) => void): void {
      messageHandler = handler;
    },
    onStateChange(handler: (connected: boolean) => void): void {
      stateHandler = handler;
    },
    disconnect(): void {
      disposed = true;
      if (stateHandler) {
        stateHandler(false);
      }
    },
  };
}

// ============================================================================
// Mock SSE Client
// ============================================================================

/**
 * Create a mock SseClient for testing.
 *
 * @example Basic usage - returns mock connection
 * const sseClient = createMockSseClient();
 *
 * @example With custom connection
 * const connection = createMockSseConnection({ messages: ['test'] });
 * const sseClient = createMockSseClient({ connection });
 *
 * @example Custom implementation
 * const sseClient = createMockSseClient({
 *   implementation: (url) => {
 *     if (url.includes('error')) throw new Error('Invalid URL');
 *     return createMockSseConnection();
 *   }
 * });
 */
export function createMockSseClient(options?: MockSseClientOptions): SseClient {
  return {
    createSseConnection(url: string, connOptions?: SseConnectionOptions): SseConnection {
      if (options?.implementation) {
        return options.implementation(url, connOptions);
      }
      return options?.connection ?? createMockSseConnection();
    },
  };
}
