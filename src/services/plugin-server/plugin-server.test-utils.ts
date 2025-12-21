/**
 * Test utilities for PluginServer testing.
 *
 * Provides mock factories for unit testing PluginServer and consumers.
 */

import { vi, type Mock } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  PluginResult,
  CommandRequest,
} from "../../shared/plugin-protocol";

// ============================================================================
// Mock Socket Types
// ============================================================================

/**
 * Typed client socket for connecting to PluginServer in tests.
 */
export type TestClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

// ============================================================================
// Test Client Factory
// ============================================================================

/**
 * Options for creating a test client.
 */
export interface TestClientOptions {
  /** Workspace path to send in auth */
  readonly workspacePath: string;
  /** Whether to connect immediately. Default: false */
  readonly autoConnect?: boolean;
}

/**
 * Create a Socket.IO client for testing PluginServer.
 *
 * @param port - Port to connect to
 * @param options - Client configuration
 * @returns Socket.IO client instance
 *
 * @example
 * ```typescript
 * const client = createTestClient(port, { workspacePath: '/test/workspace' });
 * await new Promise(resolve => client.on('connect', resolve));
 *
 * // Handle commands
 * client.on('command', (request, ack) => {
 *   ack({ success: true, data: undefined });
 * });
 *
 * // Cleanup
 * client.disconnect();
 * ```
 */
export function createTestClient(port: number, options: TestClientOptions): TestClientSocket {
  return ioClient(`http://localhost:${port}`, {
    // Use polling transport to match server configuration
    transports: ["polling"],
    autoConnect: options.autoConnect ?? false,
    auth: {
      workspacePath: options.workspacePath,
    },
    // Faster reconnection for tests
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
  });
}

/**
 * Wait for a client to connect.
 *
 * @param client - The client socket
 * @param timeoutMs - Timeout in milliseconds. Default: 5000
 * @returns Promise that resolves when connected
 */
export async function waitForConnect(client: TestClientSocket, timeoutMs = 5000): Promise<void> {
  if (client.connected) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });

    client.once("connect_error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.connect();
  });
}

/**
 * Wait for a client to disconnect.
 *
 * @param client - The client socket
 * @param timeoutMs - Timeout in milliseconds. Default: 5000
 * @returns Promise that resolves when disconnected
 */
export async function waitForDisconnect(client: TestClientSocket, timeoutMs = 5000): Promise<void> {
  if (!client.connected) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Disconnect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.once("disconnect", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ============================================================================
// Mock Command Handler
// ============================================================================

/**
 * Options for mock command handler.
 */
export interface MockCommandHandlerOptions {
  /** Default result to return. Default: { success: true, data: undefined } */
  readonly defaultResult?: PluginResult<unknown>;
  /** Map of command names to specific results */
  readonly commandResults?: Record<string, PluginResult<unknown>>;
  /** Delay before responding in ms. Default: 0 */
  readonly delayMs?: number;
}

/**
 * Create a mock command handler for testing.
 *
 * @param options - Handler configuration
 * @returns Mock function that can be attached to client.on('command', handler)
 *
 * @example
 * ```typescript
 * const handler = createMockCommandHandler({
 *   commandResults: {
 *     'workbench.action.closeSidebar': { success: true, data: undefined },
 *     'unknown.command': { success: false, error: 'Command not found' }
 *   }
 * });
 * client.on('command', handler);
 * ```
 */
export function createMockCommandHandler(
  options?: MockCommandHandlerOptions
): Mock<(request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void> {
  const defaultResult = options?.defaultResult ?? { success: true, data: undefined };
  const commandResults = options?.commandResults ?? {};
  const delayMs = options?.delayMs ?? 0;

  return vi.fn((request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => {
    const result = commandResults[request.command] ?? defaultResult;

    if (delayMs > 0) {
      setTimeout(() => ack(result), delayMs);
    } else {
      ack(result);
    }
  });
}
