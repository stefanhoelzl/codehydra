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
// Configuration Types
// ============================================================================

/**
 * Configuration sent from server to client on connection.
 * Used to enable development-only features in the extension.
 */
export interface PluginConfig {
  /** True when running in development mode */
  readonly isDevelopment: boolean;
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
   * Configuration sent immediately after connection validation.
   * Used to enable development-only features (e.g., debug commands).
   *
   * @param config - Configuration object with isDevelopment flag
   */
  config: (config: PluginConfig) => void;

  /**
   * Execute a VS Code command in the connected workspace.
   *
   * @param request - The command request containing command ID and optional args
   * @param ack - Acknowledgment callback to return the result
   */
  command: (request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void;

  /**
   * Shutdown the extension host process for workspace deletion.
   *
   * The extension should:
   * 1. Remove all workspace folders (releases file watchers)
   * 2. Send ack to confirm receipt
   * 3. Call process.exit(0) to terminate the extension host
   *
   * CodeHydra waits for socket disconnect as confirmation.
   *
   * @param ack - Acknowledgment callback to confirm shutdown received
   */
  shutdown: (ack: (result: PluginResult<void>) => void) => void;
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
 * Request payload for executing a VS Code command.
 */
export interface ExecuteCommandRequest {
  /** VS Code command identifier (e.g., "workbench.action.files.save") */
  readonly command: string;
  /** Optional arguments to pass to the command */
  readonly args?: readonly unknown[];
}

/**
 * Runtime validation for ExecuteCommandRequest.
 * Validates that command is a non-empty string and args is an array if present.
 *
 * @param payload - The payload to validate
 * @returns Object with valid boolean and optional error message
 */
export function validateExecuteCommandRequest(
  payload: unknown
): { valid: true } | { valid: false; error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { valid: false, error: "Request must be an object" };
  }

  const request = payload as Record<string, unknown>;

  if (!("command" in request)) {
    return { valid: false, error: "Missing required field: command" };
  }

  if (typeof request.command !== "string") {
    return { valid: false, error: "Field 'command' must be a string" };
  }

  if (request.command.trim().length === 0) {
    return { valid: false, error: "Field 'command' cannot be empty" };
  }

  if ("args" in request && !Array.isArray(request.args)) {
    return { valid: false, error: "Field 'args' must be an array" };
  }

  return { valid: true };
}

/**
 * Request payload for deleting a workspace.
 */
export interface DeleteWorkspaceRequest {
  /** If true, keep the git branch after deleting the worktree. Default: false */
  readonly keepBranch?: boolean | undefined;
}

/**
 * Response for workspace deletion.
 */
export interface DeleteWorkspaceResponse {
  /** True if deletion was started (deletion is async) */
  readonly started: boolean;
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

/**
 * Runtime validation for DeleteWorkspaceRequest.
 * Validates structure and keepBranch is boolean if present.
 *
 * @param payload - The payload to validate
 * @returns Object with valid boolean and optional error message
 */
export function validateDeleteWorkspaceRequest(
  payload: unknown
): { valid: true; request: DeleteWorkspaceRequest } | { valid: false; error: string } {
  // Allow empty object or undefined (optional request)
  if (payload === undefined || payload === null) {
    return { valid: true, request: {} };
  }

  if (typeof payload !== "object") {
    return { valid: false, error: "Request must be an object" };
  }

  const request = payload as Record<string, unknown>;

  if ("keepBranch" in request && typeof request.keepBranch !== "boolean") {
    return { valid: false, error: "Field 'keepBranch' must be a boolean" };
  }

  return {
    valid: true,
    request: {
      keepBranch: request.keepBranch as boolean | undefined,
    },
  };
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

  /**
   * Execute a VS Code command in the connected workspace.
   *
   * @param request - The command to execute with optional args
   * @param ack - Acknowledgment callback with command result
   */
  "api:workspace:executeCommand": (
    request: ExecuteCommandRequest,
    ack: (result: PluginResult<unknown>) => void
  ) => void;

  /**
   * Delete the connected workspace.
   * This will terminate the OpenCode session and remove the worktree.
   *
   * @param request - Optional request with keepBranch option
   * @param ack - Acknowledgment callback with deletion started confirmation
   */
  "api:workspace:delete": (
    request: DeleteWorkspaceRequest | undefined,
    ack: (result: PluginResult<DeleteWorkspaceResponse>) => void
  ) => void;

  /**
   * Send a structured log message to the main process.
   * This is a fire-and-forget event (no acknowledgment callback).
   *
   * The workspace context is automatically appended by the server.
   *
   * @param request - Log request with level, message, and optional context
   */
  "api:log": (request: LogRequest) => void;
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

/**
 * Timeout for shutdown disconnect confirmation (milliseconds).
 * If socket doesn't disconnect within this time, proceed with deletion anyway.
 * This is a best-effort timeout - extension host may be unresponsive.
 */
export const SHUTDOWN_DISCONNECT_TIMEOUT_MS = 5_000;

// ============================================================================
// Log Types
// ============================================================================

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety.
 */
export type LogContext = Record<string, string | number | boolean | null>;

/**
 * Log request payload sent from extension to main process.
 */
export interface LogRequest {
  /** Log level (silly, debug, info, warn, error) */
  readonly level: string;
  /** Log message */
  readonly message: string;
  /** Optional structured context data */
  readonly context?: LogContext;
}

/**
 * Valid log levels array for validation.
 * Note: Duplicated from services/logging/types.ts because shared/ cannot import from services/.
 */
const VALID_LOG_LEVELS = ["silly", "debug", "info", "warn", "error"];

/**
 * Runtime validation for LogRequest.
 * Validates structure, level, message, and context value types.
 *
 * @param payload - The payload to validate
 * @returns Object with valid boolean and optional error message
 */
export function validateLogRequest(
  payload: unknown
): { valid: true } | { valid: false; error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { valid: false, error: "Request must be an object" };
  }

  const request = payload as Record<string, unknown>;

  // Validate level
  if (!("level" in request)) {
    return { valid: false, error: "Missing required field: level" };
  }

  if (typeof request.level !== "string") {
    return { valid: false, error: "Field 'level' must be a string" };
  }

  if (!VALID_LOG_LEVELS.includes(request.level)) {
    return { valid: false, error: `Invalid log level: ${request.level}` };
  }

  // Validate message
  if (!("message" in request)) {
    return { valid: false, error: "Missing required field: message" };
  }

  if (typeof request.message !== "string") {
    return { valid: false, error: "Field 'message' must be a string" };
  }

  if (request.message.length === 0) {
    return { valid: false, error: "Field 'message' cannot be empty" };
  }

  // Validate context (optional)
  if ("context" in request && request.context !== undefined) {
    if (typeof request.context !== "object" || request.context === null) {
      return { valid: false, error: "Field 'context' must be an object" };
    }

    // Validate each context value is a primitive
    const contextObj = request.context as Record<string, unknown>;
    for (const [key, value] of Object.entries(contextObj)) {
      if (value === null) {
        continue; // null is valid
      }
      const valueType = typeof value;
      if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
        return {
          valid: false,
          error: `Invalid context value type for key '${key}': expected primitive, got ${valueType === "object" ? (Array.isArray(value) ? "array" : "object") : valueType}`,
        };
      }
    }
  }

  return { valid: true };
}
