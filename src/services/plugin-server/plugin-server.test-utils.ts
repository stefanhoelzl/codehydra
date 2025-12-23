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
import type { WorkspaceStatus } from "../../shared/api/types";
import type { ApiCallHandlers } from "./plugin-server";

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

// ============================================================================
// Mock API Handlers
// ============================================================================

/**
 * Options for creating mock API handlers.
 */
export interface MockApiHandlersOptions {
  /** Status to return from getStatus. Default: { isDirty: false, agent: { type: 'none' } } */
  readonly getStatus?: WorkspaceStatus | PluginResult<WorkspaceStatus>;
  /** Port to return from getOpencodePort. Default: null */
  readonly getOpencodePort?: number | null | PluginResult<number | null>;
  /** Metadata to return from getMetadata. Default: { base: 'main' } */
  readonly getMetadata?: Record<string, string> | PluginResult<Record<string, string>>;
  /** Result to return from setMetadata. Default: { success: true, data: undefined } */
  readonly setMetadata?: PluginResult<void>;
}

/**
 * Create mock API handlers for testing PluginServer API functionality.
 *
 * Each handler is a vi.Mock that returns a Promise resolving to a PluginResult.
 * You can customize the return values via options or access the mocks directly.
 *
 * @param options - Optional return value overrides
 * @returns Object with mock handler functions
 *
 * @example
 * ```typescript
 * // Default behavior
 * const handlers = createMockApiHandlers();
 * server.onApiCall(handlers);
 *
 * // Custom status
 * const handlers = createMockApiHandlers({
 *   getStatus: { isDirty: true, agent: { type: 'busy', counts: { idle: 0, busy: 1, total: 1 } } },
 * });
 *
 * // Error response
 * const handlers = createMockApiHandlers({
 *   getStatus: { success: false, error: 'Not found' },
 * });
 *
 * // Check calls
 * expect(handlers.getStatus).toHaveBeenCalledWith('/workspace/path');
 * ```
 */
export function createMockApiHandlers(options?: MockApiHandlersOptions): ApiCallHandlers {
  const defaultStatus: WorkspaceStatus = { isDirty: false, agent: { type: "none" } };
  const defaultMetadata: Record<string, string> = { base: "main" };

  // Helper to check if value is already a PluginResult
  function isPluginResult<T>(value: T | PluginResult<T> | undefined): value is PluginResult<T> {
    return value !== undefined && typeof value === "object" && value !== null && "success" in value;
  }

  // Convert to PluginResult if not already
  let statusResult: PluginResult<WorkspaceStatus>;
  if (isPluginResult(options?.getStatus)) {
    statusResult = options.getStatus;
  } else {
    statusResult = { success: true, data: options?.getStatus ?? defaultStatus };
  }

  let portResult: PluginResult<number | null>;
  if (isPluginResult(options?.getOpencodePort)) {
    portResult = options.getOpencodePort;
  } else {
    portResult = { success: true, data: options?.getOpencodePort ?? null };
  }

  let metadataResult: PluginResult<Record<string, string>>;
  if (isPluginResult(options?.getMetadata)) {
    metadataResult = options.getMetadata;
  } else {
    metadataResult = { success: true, data: options?.getMetadata ?? defaultMetadata };
  }

  const setMetadataResult: PluginResult<void> = options?.setMetadata ?? {
    success: true,
    data: undefined,
  };

  return {
    getStatus: vi.fn().mockResolvedValue(statusResult),
    getOpencodePort: vi.fn().mockResolvedValue(portResult),
    getMetadata: vi.fn().mockResolvedValue(metadataResult),
    setMetadata: vi.fn(() => Promise.resolve(setMetadataResult)),
  };
}
