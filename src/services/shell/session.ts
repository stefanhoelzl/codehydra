/**
 * SessionLayer - Abstraction over Electron's session API.
 *
 * Provides an injectable interface for session management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron session
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { SessionHandle } from "./types";
import { createSessionHandle } from "./types";
import { ShellError } from "./errors";
import type { Logger } from "../logging";

// ============================================================================
// Types
// ============================================================================

/**
 * Permission types that can be requested by web content.
 */
export type Permission =
  | "clipboard-read"
  | "clipboard-sanitized-write"
  | "clipboard-write"
  | "media"
  | "fullscreen"
  | "notifications"
  | "openExternal"
  | "fileSystem"
  | "hid"
  | "serial"
  | "usb"
  | "display-capture"
  | "mediaKeySystem"
  | "geolocation"
  | "midi"
  | "midiSysex"
  | "pointerLock"
  | "keyboardLock"
  | "idle-detection"
  | "speaker-selection"
  | "storage-access"
  | "top-level-storage-access"
  | "window-management"
  | "unknown";

/**
 * Handler for permission requests.
 * Returns true to grant, false to deny.
 */
export type PermissionRequestHandler = (permission: Permission) => boolean;

/**
 * Handler for permission checks.
 * Returns true if permission is granted, false otherwise.
 */
export type PermissionCheckHandler = (permission: Permission) => boolean;

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's session API.
 *
 * Uses opaque SessionHandle references instead of exposing Session directly.
 * This allows testing without Electron dependencies and ensures all session
 * access goes through this abstraction.
 */
export interface SessionLayer {
  /**
   * Get or create a session for a given partition.
   *
   * Partition names starting with "persist:" are persisted across app restarts.
   * Other partitions are in-memory only.
   *
   * @param partition - The partition name (e.g., "persist:project/workspace")
   * @returns Handle to the session
   */
  fromPartition(partition: string): SessionHandle;

  /**
   * Clear all storage data for a session.
   *
   * Clears localStorage, cookies, cache, etc.
   *
   * @param handle - Handle to the session
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  clearStorageData(handle: SessionHandle): Promise<void>;

  /**
   * Set a handler for permission requests.
   *
   * @param handle - Handle to the session
   * @param handler - Handler function, or null to use default behavior
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setPermissionRequestHandler(
    handle: SessionHandle,
    handler: PermissionRequestHandler | null
  ): void;

  /**
   * Set a handler for permission checks.
   *
   * @param handle - Handle to the session
   * @param handler - Handler function, or null to use default behavior
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setPermissionCheckHandler(handle: SessionHandle, handler: PermissionCheckHandler | null): void;

  /**
   * Set a handler for modifying response headers.
   *
   * Used to strip headers like X-Frame-Options that would block loading
   * external content in iframes or webviews.
   *
   * @param handle - Handle to the session
   * @param handler - Handler function that receives headers and returns modified headers
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setHeadersReceivedHandler(
    handle: SessionHandle,
    handler: ((headers: Record<string, string[]>) => Record<string, string[]>) | null
  ): void;

  /**
   * Dispose of all resources.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { session as electronSession, type Session } from "electron";

interface SessionState {
  partition: string;
  session: Session;
}

/**
 * Default implementation of SessionLayer using Electron's session API.
 */
export class DefaultSessionLayer implements SessionLayer {
  private readonly sessions = new Map<string, SessionState>();
  private nextId = 1;

  constructor(private readonly logger: Logger) {}

  fromPartition(partition: string): SessionHandle {
    // Check if we already have a handle for this partition
    for (const [id, state] of this.sessions) {
      if (state.partition === partition) {
        return createSessionHandle(id);
      }
    }

    // Create new session
    const id = `session-${this.nextId++}`;
    const sess = electronSession.fromPartition(partition);

    this.sessions.set(id, {
      partition,
      session: sess,
    });

    this.logger.debug("Session created", { id, partition });
    return createSessionHandle(id);
  }

  async clearStorageData(handle: SessionHandle): Promise<void> {
    const state = this.getSession(handle);
    await state.session.clearStorageData();
    this.logger.debug("Session storage cleared", { id: handle.id, partition: state.partition });
  }

  setPermissionRequestHandler(
    handle: SessionHandle,
    handler: PermissionRequestHandler | null
  ): void {
    const state = this.getSession(handle);

    if (handler === null) {
      state.session.setPermissionRequestHandler(null);
    } else {
      state.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        const result = handler(permission as Permission);
        callback(result);
      });
    }

    this.logger.debug("Permission request handler set", {
      id: handle.id,
      hasHandler: handler !== null,
    });
  }

  setPermissionCheckHandler(handle: SessionHandle, handler: PermissionCheckHandler | null): void {
    const state = this.getSession(handle);

    if (handler === null) {
      state.session.setPermissionCheckHandler(null);
    } else {
      state.session.setPermissionCheckHandler((_webContents, permission) => {
        return handler(permission as Permission);
      });
    }

    this.logger.debug("Permission check handler set", {
      id: handle.id,
      hasHandler: handler !== null,
    });
  }

  setHeadersReceivedHandler(
    handle: SessionHandle,
    handler: ((headers: Record<string, string[]>) => Record<string, string[]>) | null
  ): void {
    const state = this.getSession(handle);

    if (handler === null) {
      // Remove the handler by setting an empty one that passes through all headers
      state.session.webRequest.onHeadersReceived(null);
    } else {
      state.session.webRequest.onHeadersReceived((details, callback) => {
        // Convert Electron's header format to our interface format and back
        const headers = details.responseHeaders ?? {};
        const modifiedHeaders = handler(headers as Record<string, string[]>);
        callback({ responseHeaders: modifiedHeaders });
      });
    }

    this.logger.debug("Headers received handler set", {
      id: handle.id,
      hasHandler: handler !== null,
    });
  }

  async dispose(): Promise<void> {
    // Clear storage for all sessions
    for (const state of this.sessions.values()) {
      try {
        await state.session.clearStorageData();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sessions.clear();
  }

  private getSession(handle: SessionHandle): SessionState {
    const state = this.sessions.get(handle.id);
    if (!state) {
      throw new ShellError("SESSION_NOT_FOUND", `Session ${handle.id} not found`, handle.id);
    }
    return state;
  }
}
