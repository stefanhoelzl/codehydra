/**
 * Types for OpenCode integration services.
 * All properties use readonly modifier for immutability.
 */

// ============ Result Type ============

/**
 * Result type for operations that can fail.
 * Discriminated union pattern for type-safe error handling.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Creates a successful result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Creates a failed result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ============ IDisposable ============

/**
 * Interface for resources that need cleanup.
 */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

// ============ Port Info ============

/**
 * Information about a listening port.
 */
export interface PortInfo {
  readonly port: number;
  readonly pid: number;
}

// ============ OpenCode API Responses ============

/**
 * Response from OpenCode /path endpoint.
 */
export interface PathResponse {
  readonly worktree: string;
  readonly directory: string;
}

/**
 * Individual session status value in the response.
 * Uses 'type' property for status value.
 */
export interface SessionStatusValue {
  readonly type: "idle" | "busy" | "retry";
}

/**
 * Response from OpenCode /session/status endpoint.
 * OpenCode returns an array of status values (not keyed by session ID).
 */
export type SessionStatusResponse = readonly SessionStatusValue[];

/**
 * Client status - simplified to just idle or busy.
 * Used for port-based status tracking (1 agent per port).
 */
export type ClientStatus = "idle" | "busy";

/**
 * Full session data from OpenCode /session endpoint.
 * Used to determine parent/child relationships.
 */
export interface Session {
  readonly id: string;
  readonly parentID?: string;
  readonly directory: string;
  readonly title: string;
}

/**
 * Response from OpenCode /session endpoint.
 */
export type SessionListResponse = readonly Session[];

// ============ Session Status ============

/**
 * Session status as a discriminated union for type-safe handling.
 */
export type SessionStatus =
  | { readonly type: "idle"; readonly sessionId: string }
  | { readonly type: "busy"; readonly sessionId: string }
  | { readonly type: "deleted"; readonly sessionId: string };

// ============ SSE Event Types ============

/**
 * SSE event types from OpenCode.
 */
export type OpenCodeEventType =
  | "session.status"
  | "session.deleted"
  | "session.idle"
  | "permission.updated"
  | "permission.replied";

/**
 * SSE event payload from OpenCode.
 */
export interface OpenCodeEvent {
  readonly type: OpenCodeEventType;
  readonly sessionId: string;
  readonly status?: "idle" | "busy";
}

/**
 * Permission request event from OpenCode.
 * Emitted when a session requests user permission.
 */
export interface PermissionUpdatedEvent {
  readonly id: string; // permission ID
  readonly sessionID: string; // session requesting permission
  readonly type: string; // permission type (e.g., "bash")
  readonly title: string; // human-readable description
}

/**
 * Permission response event from OpenCode.
 * Emitted when user responds to a permission request.
 */
export interface PermissionRepliedEvent {
  readonly sessionID: string;
  readonly permissionID: string;
  readonly response: "once" | "always" | "reject";
}

// ============ Error Types ============

/**
 * Specific error codes for discovery operations.
 */
export type DiscoveryErrorCode =
  | "SCAN_IN_PROGRESS"
  | "PORT_SCAN_FAILED"
  | "PROCESS_TREE_FAILED"
  | "PROBE_FAILED";

/**
 * Error details for discovery operations.
 */
export interface DiscoveryError {
  readonly code: DiscoveryErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Specific error codes for probe operations.
 */
export type ProbeErrorCode =
  | "TIMEOUT"
  | "CONNECTION_REFUSED"
  | "INVALID_RESPONSE"
  | "NOT_OPENCODE"
  | "NON_LOCALHOST";

/**
 * Error details for probe operations.
 */
export interface ProbeError {
  readonly code: ProbeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Specific error codes for scan operations.
 */
export type ScanErrorCode = "NETSTAT_FAILED" | "PARSE_ERROR";

/**
 * Error details for scan operations.
 */
export interface ScanError {
  readonly code: ScanErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

// ============ Unsubscribe ============

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

// ============ Non-OpenCode Port Cache Entry ============

/**
 * Cache entry for ports that are not OpenCode instances.
 */
export interface NonOpenCodePortEntry {
  readonly pid: number;
  readonly timestamp: number;
}
