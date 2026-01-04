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

// ============ Re-exports from shared types ============

// Re-export from shared types (single source of truth)
export type { IDisposable, Unsubscribe } from "../../shared/types";

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
  readonly parentID?: string | null | undefined;
  readonly directory: string;
  readonly title?: string;
  readonly time?: {
    readonly created?: string;
    readonly updated?: number;
  };
}

// ============ Session Status ============

/**
 * Session status as a discriminated union for type-safe handling.
 *
 * - "idle": Session is idle (waiting for user input)
 * - "busy": Session is actively processing
 * - "created": Session was created (status not yet known)
 * - "deleted": Session was deleted
 */
export type SessionStatus =
  | { readonly type: "idle"; readonly sessionId: string }
  | { readonly type: "busy"; readonly sessionId: string }
  | { readonly type: "created"; readonly sessionId: string }
  | { readonly type: "deleted"; readonly sessionId: string };

// ============ Permission Event Types ============

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
