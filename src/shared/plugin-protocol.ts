/**
 * Plugin communication protocol types.
 *
 * Defines the Socket.IO event types for communication between
 * CodeHydra (server) and VS Code extensions (clients).
 */

import path from "node:path";
import type { WorkspaceStatus } from "./api/types";
import { METADATA_KEY_REGEX, isValidMetadataKey } from "./api/types";

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalize workspace path for consistent Map lookups across platforms.
 * Uses POSIX-style forward slashes for cross-platform consistency in
 * socket communication. This ensures paths match regardless of OS.
 *
 * @param workspacePath - The workspace path to normalize
 * @returns Normalized path string with forward slashes, without trailing separator
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  // First normalize using Node's path (handles .. and . segments, double separators)
  let normalized = path.normalize(workspacePath);

  // Convert Windows backslashes to forward slashes for cross-platform consistency
  normalized = normalized.replace(/\\/g, "/");

  // Collapse any remaining double forward slashes (edge case after conversion)
  normalized = normalized.replace(/\/+/g, "/");

  // Strip trailing separator, but preserve root path (/)
  if (normalized.length > 1 && normalized.endsWith("/")) {
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

// ============================================================================
// API Request Types
// ============================================================================

/**
 * Request payload for setting workspace metadata.
 */
export interface SetMetadataRequest {
  /** Metadata key (must match METADATA_KEY_REGEX) */
  readonly key: string;
  /** Metadata value (string to set, null to delete) */
  readonly value: string | null;
}

/**
 * Runtime validation for SetMetadataRequest.
 * Validates structure and key format against METADATA_KEY_REGEX.
 *
 * @param payload - The payload to validate
 * @returns Object with valid boolean and optional error message
 */
export function validateSetMetadataRequest(
  payload: unknown
): { valid: true } | { valid: false; error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { valid: false, error: "Request must be an object" };
  }

  const request = payload as Record<string, unknown>;

  if (!("key" in request)) {
    return { valid: false, error: "Missing required field: key" };
  }

  if (typeof request.key !== "string") {
    return { valid: false, error: "Field 'key' must be a string" };
  }

  if (request.key.length === 0) {
    return { valid: false, error: "Field 'key' cannot be empty" };
  }

  if (!isValidMetadataKey(request.key)) {
    return {
      valid: false,
      error: `Invalid key format: must match ${METADATA_KEY_REGEX.toString()}`,
    };
  }

  if (!("value" in request)) {
    return { valid: false, error: "Missing required field: value" };
  }

  if (request.value !== null && typeof request.value !== "string") {
    return { valid: false, error: "Field 'value' must be a string or null" };
  }

  return { valid: true };
}

// ============================================================================
// Socket.IO Event Types
// ============================================================================

/**
 * Client to Server events (Extension -> CodeHydra).
 * Provides workspace-scoped API methods for extensions.
 */
export interface ClientToServerEvents {
  /**
   * Get the current status of the connected workspace.
   *
   * @param ack - Acknowledgment callback with workspace status
   */
  "api:workspace:getStatus": (ack: (result: PluginResult<WorkspaceStatus>) => void) => void;

  /**
   * Get the OpenCode server port for the connected workspace.
   *
   * @param ack - Acknowledgment callback with port number (null if not running)
   */
  "api:workspace:getOpencodePort": (ack: (result: PluginResult<number | null>) => void) => void;

  /**
   * Get all metadata for the connected workspace.
   *
   * @param ack - Acknowledgment callback with metadata record
   */
  "api:workspace:getMetadata": (
    ack: (result: PluginResult<Record<string, string>>) => void
  ) => void;

  /**
   * Set or delete a metadata key for the connected workspace.
   *
   * @param request - The metadata key/value to set (value: null to delete)
   * @param ack - Acknowledgment callback with void result
   */
  "api:workspace:setMetadata": (
    request: SetMetadataRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;
}

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
