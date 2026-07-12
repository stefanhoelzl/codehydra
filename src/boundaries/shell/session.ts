/**
 * SessionBoundary - Abstraction over Electron's session API.
 *
 * Provides an injectable interface for session management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron session
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { SessionHandle } from "./types";
import { createSessionHandle } from "./types";
import { ShellError } from "../../shared/errors/shell-errors";
import type { Logger } from "../platform/logging";

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

/**
 * An asset served in place of a network response by a protocol interceptor.
 */
export interface InterceptedAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
  /** Extra response headers (e.g. `service-worker-allowed`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Resolves an intercepted request URL to a locally-served asset, or `null` to
 * forward the request to the built-in (network) handler untouched.
 *
 * Interceptors are given only the URL — no Electron or fetch types cross the
 * boundary, so callers stay trivially testable.
 */
export type ProtocolInterceptor = (url: string) => Promise<InterceptedAsset | null>;

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
export interface SessionBoundary {
  /**
   * Get or create a session for a given partition.
   *
   * Partition names starting with "persist:" are persisted across app restarts.
   * Other partitions are in-memory only.
   *
   * @param partition - The partition name (e.g., "persist:codehydra-global")
   * @returns Handle to the session
   */
  fromPartition(partition: string): SessionHandle;

  /**
   * Set a handler for permission requests.
   *
   * @param handle - Handle to the session
   * @param handler - Handler function
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setPermissionRequestHandler(handle: SessionHandle, handler: PermissionRequestHandler): void;

  /**
   * Set a handler for permission checks.
   *
   * @param handle - Handle to the session
   * @param handler - Handler function
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setPermissionCheckHandler(handle: SessionHandle, handler: PermissionCheckHandler): void;

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
    handler: (headers: Record<string, string[]>) => Record<string, string[]>
  ): void;

  /**
   * Intercept `scheme` on this session, serving the interceptor's asset when it
   * returns one and forwarding to the network otherwise.
   *
   * Registration is idempotent: re-registering replaces the previous handler.
   *
   * @param handle - Handle to the session
   * @param scheme - Scheme to intercept (e.g. "https")
   * @param interceptor - Resolves a URL to a local asset, or null to pass through
   * @throws ShellError with code SESSION_NOT_FOUND if handle is invalid
   */
  setProtocolHandler(handle: SessionHandle, scheme: string, interceptor: ProtocolInterceptor): void;

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
 * Default implementation of SessionBoundary using Electron's session API.
 */
export class DefaultSessionBoundary implements SessionBoundary {
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

  setPermissionRequestHandler(handle: SessionHandle, handler: PermissionRequestHandler): void {
    const state = this.getSession(handle);

    state.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      const result = handler(permission as Permission);
      callback(result);
    });

    this.logger.debug("Permission request handler set", { id: handle.id });
  }

  setPermissionCheckHandler(handle: SessionHandle, handler: PermissionCheckHandler): void {
    const state = this.getSession(handle);

    state.session.setPermissionCheckHandler((_webContents, permission) => {
      return handler(permission as Permission);
    });

    this.logger.debug("Permission check handler set", { id: handle.id });
  }

  setHeadersReceivedHandler(
    handle: SessionHandle,
    handler: (headers: Record<string, string[]>) => Record<string, string[]>
  ): void {
    const state = this.getSession(handle);

    state.session.webRequest.onHeadersReceived((details, callback) => {
      // Convert Electron's header format to our interface format and back
      const headers = details.responseHeaders ?? {};
      const modifiedHeaders = handler(headers as Record<string, string[]>);
      callback({ responseHeaders: modifiedHeaders });
    });

    this.logger.debug("Headers received handler set", { id: handle.id });
  }

  setProtocolHandler(
    handle: SessionHandle,
    scheme: string,
    interceptor: ProtocolInterceptor
  ): void {
    const state = this.getSession(handle);
    const { protocol } = state.session;

    // Idempotent: protocol.handle throws if the scheme is already handled.
    if (protocol.isProtocolHandled(scheme)) {
      protocol.unhandle(scheme);
    }

    protocol.handle(scheme, async (request) => {
      const asset = await interceptor(request.url);
      if (!asset) {
        // Forward to Electron's built-in handler. Without the bypass this would
        // re-enter this same handler and loop forever.
        return state.session.fetch(request, { bypassCustomProtocolHandlers: true });
      }
      return new Response(asset.body as BodyInit, {
        status: 200,
        headers: { "content-type": asset.contentType, ...asset.headers },
      });
    });

    this.logger.debug("Protocol handler set", { id: handle.id, scheme });
  }

  async dispose(): Promise<void> {
    // Just clear the sessions map. We don't clear storage data because
    // we use persistent sessions that should survive app restarts.
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
