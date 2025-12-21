/**
 * Plugin communication protocol types.
 *
 * Defines the Socket.IO event types for communication between
 * CodeHydra (server) and VS Code extensions (clients).
 */

import path from "node:path";

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalize workspace path for consistent Map lookups across platforms.
 * Uses Node.js path.normalize() and strips trailing separators for consistency.
 *
 * @param workspacePath - The workspace path to normalize
 * @returns Normalized path string without trailing separator (except for root)
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  const normalized = path.normalize(workspacePath);
  // Strip trailing separator, but preserve root path (/ or C:\)
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result wrapper for all acknowledgment responses.
 * Provides a discriminated union for success/failure handling.
 */
export type PluginResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

// ============================================================================
// Command Types
// ============================================================================

/**
 * VS Code command request sent from server to client.
 */
export interface CommandRequest {
  /** VS Code command identifier (e.g., "workbench.action.closeSidebar") */
  readonly command: string;
  /** Optional arguments to pass to the command */
  readonly args?: readonly unknown[];
}

/**
 * Runtime validation for incoming CommandRequest.
 * Used to validate payloads before processing.
 *
 * @param payload - The payload to validate
 * @returns True if the payload is a valid CommandRequest
 */
export function isValidCommandRequest(payload: unknown): payload is CommandRequest {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "command" in payload &&
    typeof (payload as CommandRequest).command === "string" &&
    (!("args" in payload) || Array.isArray((payload as CommandRequest).args))
  );
}

// ============================================================================
// Socket.IO Event Types
// ============================================================================

/**
 * Server to Client events (CodeHydra -> Extension).
 * Used by Socket.IO for type-safe event handling.
 */
export interface ServerToClientEvents {
  /**
   * Execute a VS Code command in the connected workspace.
   *
   * @param request - The command request containing command ID and optional args
   * @param ack - Acknowledgment callback to return the result
   */
  command: (request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void;
}

/**
 * Client to Server events (Extension -> CodeHydra).
 * Currently empty - reserved for future API calls.
 * Uses Record<string, never> to indicate an intentionally empty interface
 * that will be extended in future versions.
 */
export type ClientToServerEvents = Record<string, never>;

/**
 * Socket metadata set from auth on connect.
 * Stored in the Socket.data property.
 */
export interface SocketData {
  /** Normalized workspace path this socket is connected from */
  workspacePath: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default timeout for command acknowledgments (milliseconds).
 * If no ack is received within this time, the command is considered failed.
 */
export const COMMAND_TIMEOUT_MS = 10_000;
