/**
 * OpenCode client for communicating with an OpenCode server.
 *
 * Owns the wire-agnostic machinery: session tracking (roots and subagents),
 * status aggregation, and the listener surface the provider consumes. The
 * server API itself — 1.x or 2.x — is behind the {@link WireClient} seam
 * (wire-v1.ts, wire-v2.ts), picked by the resolved binary's major version.
 */

import { OpenCodeError, getErrorMessage } from "../../../shared/errors/service-errors";
import type { Logger } from "../../../boundaries/platform/logging";
import { isBackgroundAgentLabel } from "../status-utils";
import type {
  Result,
  Session,
  SessionStatus,
  ClientStatus,
  IDisposable,
  Unsubscribe,
  UserRequestAskedEvent,
  UserRequestResolvedEvent,
} from "./types";
import type { WireClient, WireClientFactory, WireEvent, WirePromptOptions } from "./wire";
import { OpenCodeWireV1 } from "./wire-v1";
import { OpenCodeWireV2 } from "./wire-v2";

/** What the client needs to know about the server it talks to. */
export interface OpenCodeClientOptions {
  /** Which server API the server speaks. */
  readonly major: 1 | 2;
  /** 2.x only: the server's password (Basic auth, user `opencode`). */
  readonly password?: string;
  /** The workspace directory: where sessions are created, and how listings scope (2.x). */
  readonly directory: string;
  /** 2.x only: an MCP server a prompt waits for, so the turn sees its tools. */
  readonly mcpServer?: string;
}

/** Builds the wire the server's API version calls for. */
const defaultWireFactory: WireClientFactory = (baseUrl, options, logger) =>
  options.major === 2
    ? new OpenCodeWireV2(baseUrl, options, logger)
    : new OpenCodeWireV1(baseUrl, options, logger);

/**
 * Callback for session events.
 */
export type SessionEventCallback = (event: SessionStatus) => void;

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (status: ClientStatus) => void;

/**
 * A session started or stopped waiting on the user.
 */
export type UserRequestEvent =
  | { type: "asked"; event: UserRequestAskedEvent }
  | { type: "resolved"; event: UserRequestResolvedEvent };

/**
 * Callback for user request events.
 */
export type UserRequestEventCallback = (event: UserRequestEvent) => void;

/**
 * Client for communicating with a single OpenCode server.
 *
 * The wire client is injected via factory for testability; the default builds
 * the 1.x or 2.x wire from the options.
 */
export class OpenCodeClient implements IDisposable {
  private readonly port: number;
  private readonly logger: Logger;
  private readonly wire: WireClient;
  private readonly listeners = new Set<SessionEventCallback>();
  private readonly userRequestListeners = new Set<UserRequestEventCallback>();
  private readonly statusListeners = new Set<StatusChangedCallback>();
  private connected = false;
  private disposed = false;

  /**
   * Set of root session IDs (sessions without a parentID).
   * Only events for these sessions are emitted.
   */
  private readonly rootSessionIds = new Set<string>();

  /**
   * Map of child session ID to its root session ID.
   * Used to emit user request events for subagents under their root session.
   */
  private readonly childToRootSession = new Map<string, string>();

  /**
   * Child sessions opted out with `[bg]`: their title (the task description)
   * starts with the marker, or an ancestor's does. They never keep the
   * workspace busy.
   */
  private readonly optedOutChildSessions = new Set<string>();

  /**
   * Tracked child sessions that are busy and not opted out. A background
   * sub-agent outlives its parent's turn, so while any of these runs the
   * workspace stays busy; a synchronous one runs inside a busy root anyway.
   */
  private readonly busyChildSessions = new Set<string>();

  /** The status the root session last reported. */
  private rootStatus: ClientStatus = "idle";

  /**
   * Current aggregated status for this port: the root's, or busy while a child
   * session keeps it busy. Simplified model: 1 agent per port.
   */
  private _currentStatus: ClientStatus = "idle";

  constructor(
    port: number,
    logger: Logger,
    options: OpenCodeClientOptions,
    wireFactory: WireClientFactory = defaultWireFactory
  ) {
    this.port = port;
    this.logger = logger;
    const wireOptions = {
      major: options.major,
      ...(options.password !== undefined && { password: options.password }),
      directory: options.directory,
      ...(options.mcpServer !== undefined && { mcpServer: options.mcpServer }),
    };
    this.wire = wireFactory(`http://127.0.0.1:${port}`, wireOptions, logger);
    this.wire.onWireEvent((event) => this.handleWireEvent(event));
  }

  /**
   * Lists all sessions from the OpenCode server.
   * Returns all sessions without filtering (caller can filter as needed).
   */
  async listSessions(): Promise<Result<Session[], OpenCodeError>> {
    return this.wire.listSessions();
  }

  /**
   * Subscribe to session events.
   */
  onSessionEvent(callback: SessionEventCallback): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Subscribe to user request events: a root or tracked child session asking
   * for permission or asking a question (a form, on 2.x), and that request
   * being resolved.
   */
  onUserRequestEvent(callback: UserRequestEventCallback): Unsubscribe {
    this.userRequestListeners.add(callback);
    return () => this.userRequestListeners.delete(callback);
  }

  /**
   * Subscribe to status changes.
   */
  onStatusChanged(callback: StatusChangedCallback): Unsubscribe {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Add a session to the root sessions set (for existing sessions found via listSessions).
   * This ensures status events for existing sessions are properly processed.
   */
  addRootSession(sessionId: string): void {
    this.rootSessionIds.add(sessionId);
  }

  /**
   * Get current status from the API.
   * Fetches session status and aggregates to a single ClientStatus.
   * Empty or all idle -> "idle", any busy/retry -> "busy"
   */
  async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
    return this.wire.getStatus();
  }

  /**
   * Create a new session.
   * The session is immediately tracked in rootSessionIds before SSE events arrive.
   * This ensures proper status tracking even if session.status arrives before session.created.
   *
   * @returns The full session object on success, or an error
   */
  async createSession(): Promise<Result<Session, OpenCodeError>> {
    const result = await this.wire.createSession();
    if (result.ok) {
      // Track immediately - don't wait for the session.created event
      // This ensures session status events are handled correctly
      this.rootSessionIds.add(result.value.id);
      this.logger.debug("Session created", { port: this.port, sessionId: result.value.id });
    }
    return result;
  }

  /**
   * Send a prompt to an existing session. Resolves when the turn it starts
   * has finished.
   *
   * @param sessionId - The session to send the prompt to
   * @param prompt - The prompt text
   * @param options - Optional agent and model configuration
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    const result = await this.wire.sendPrompt(sessionId, prompt, options);
    if (result.ok) {
      this.logger.debug("Prompt sent", {
        port: this.port,
        sessionId,
        promptLength: prompt.length,
        ...(options?.agent !== undefined && { agent: options.agent }),
      });
    }
    return result;
  }

  /**
   * Queue a prompt on an existing session and return at once.
   *
   * Unlike {@link sendPrompt}, which resolves only when the turn it starts has
   * finished, this resolves as soon as the server has accepted the prompt. A
   * busy session runs it as its own turn once the current one ends.
   *
   * @param sessionId - The session to queue the prompt on
   * @param prompt - The prompt text
   * @param options - Optional agent and model configuration
   */
  async sendPromptAsync(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    const result = await this.wire.sendPromptAsync(sessionId, prompt, options);
    if (result.ok) {
      this.logger.debug("Prompt queued", {
        port: this.port,
        sessionId,
        promptLength: prompt.length,
      });
    }
    return result;
  }

  /**
   * Connect to the server's event stream.
   *
   * @param timeoutMs - Connection timeout in milliseconds. Default: 5000
   * @throws Error if connection fails or times out
   */
  async connect(timeoutMs = 5000): Promise<void> {
    if (this.disposed || this.connected) return;

    this.logger.info("Connecting", { port: this.port });

    await this.wire.connect(timeoutMs);
    this.connected = true;

    this.logger.info("Connected", { port: this.port });

    // Sync initial status with error handling
    try {
      const result = await this.getStatus();
      if (result.ok) {
        this.updateRootStatus(result.value);
      }
    } catch (statusError) {
      this.logger.warn("Connection error", {
        port: this.port,
        error: getErrorMessage(statusError),
      });
    }
  }

  /**
   * Disconnect from the event stream.
   *
   * This closes the subscription but keeps the wire client and session
   * tracking state. Used during server restart flow: create a new
   * OpenCodeClient and call connect() to resume event streaming.
   *
   * Note: For permanent cleanup, use dispose() instead which also clears
   * all listeners and session tracking.
   */
  disconnect(): void {
    this.connected = false;
    this.wire.disconnect();
    this.logger.info("Disconnected", { port: this.port });
  }

  /**
   * Dispose the client.
   */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
    this.userRequestListeners.clear();
    this.statusListeners.clear();
    this.rootSessionIds.clear();
    this.childToRootSession.clear();
    this.optedOutChildSessions.clear();
    this.busyChildSessions.clear();
  }

  /**
   * Handle a normalized wire event and dispatch to the tracking state and
   * the listeners.
   */
  private handleWireEvent(event: WireEvent): void {
    switch (event.type) {
      case "session.status":
        this.handleSessionStatus(event.sessionID, event.status);
        break;
      case "session.created":
        this.handleSessionCreated(event.sessionID, event.parentID, event.title);
        break;
      case "session.deleted":
        this.handleSessionDeleted(event.sessionID);
        break;
      case "user-request.asked":
        this.handleUserRequestAsked(event.kind, event.id, event.sessionID);
        break;
      case "user-request.resolved":
        this.handleUserRequestResolved(event.kind, event.requestID, event.sessionID);
        break;
    }
  }

  /**
   * Handle a session's status.
   */
  private handleSessionStatus(sessionId: string, status: "idle" | "busy" | "retry"): void {
    // Map "retry" to "busy"
    const mappedType = status === "retry" ? "busy" : status;
    this.logger.debug("Session status", { sessionId, status: mappedType });
    this.emitSessionEvent({ type: mappedType, sessionId });
    this.applySessionStatus(sessionId, mappedType);
  }

  /**
   * Fold one session's status into the current status. The root session drives
   * it; a child session only adds busy while it runs unopted — so a sub-agent
   * finishing inside its parent's turn chimes nothing, and a background one
   * still at work when the parent's turn ends holds the workspace busy.
   */
  private applySessionStatus(sessionId: string, status: ClientStatus): void {
    if (this.rootSessionIds.has(sessionId)) {
      this.updateRootStatus(status);
      return;
    }
    if (!this.childToRootSession.has(sessionId) || this.optedOutChildSessions.has(sessionId)) {
      return;
    }
    if (status === "busy") {
      this.busyChildSessions.add(sessionId);
    } else {
      this.busyChildSessions.delete(sessionId);
    }
    this.recomputeStatus();
  }

  private updateRootStatus(status: ClientStatus): void {
    this.rootStatus = status;
    this.recomputeStatus();
  }

  private recomputeStatus(): void {
    this.updateCurrentStatus(this.busyChildSessions.size > 0 ? "busy" : this.rootStatus);
  }

  /**
   * Update current status and emit if changed.
   */
  private updateCurrentStatus(newStatus: ClientStatus): void {
    if (this._currentStatus !== newStatus) {
      this._currentStatus = newStatus;
      for (const listener of this.statusListeners) {
        listener(newStatus);
      }
    }
  }

  /**
   * Handle a session.deleted event.
   */
  private handleSessionDeleted(sessionId: string): void {
    // Clean up child mapping if this was a child session
    this.childToRootSession.delete(sessionId);
    this.optedOutChildSessions.delete(sessionId);
    if (this.busyChildSessions.delete(sessionId)) {
      this.recomputeStatus();
    }

    this.emitSessionEvent({ type: "deleted", sessionId });
  }

  /**
   * Emit a session event to all listeners.
   * Only emits for root sessions (those without parentID).
   */
  private emitSessionEvent(event: SessionStatus): void {
    // Only emit events for root sessions
    if (!this.rootSessionIds.has(event.sessionId)) return;

    // Handle deleted events - remove from root set
    if (event.type === "deleted") {
      this.rootSessionIds.delete(event.sessionId);
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Handle a session.created event.
   * Adds new root sessions to the tracking set, and maps child sessions to their root.
   * Emits a "created" event to notify listeners that a session exists but status is unknown.
   */
  private handleSessionCreated(sessionId: string, parentID?: string, title?: string): void {
    if (parentID === undefined) {
      // Root session
      this.rootSessionIds.add(sessionId);
      // Emit "created" event - status is unknown until a status event arrives
      // This allows sessionToPort tracking without assuming idle status
      this.emitSessionEvent({ type: "created", sessionId });
    } else {
      // Child session: map to its root
      if (this.rootSessionIds.has(parentID)) {
        // Direct child of a root session
        this.childToRootSession.set(sessionId, parentID);
      } else {
        // Parent is also a child - find its root
        const rootId = this.childToRootSession.get(parentID);
        if (rootId) {
          this.childToRootSession.set(sessionId, rootId);
        }
      }
      // The task tool titles a child session after the task description (1.x:
      // "<description> (@<agent> subagent)"), so a leading `[bg]` opts it out —
      // and with it everything it spawns. OpenCode 1.x runs a task in the
      // background only with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true.
      if (
        this.childToRootSession.has(sessionId) &&
        (isBackgroundAgentLabel(title) || this.optedOutChildSessions.has(parentID))
      ) {
        this.optedOutChildSessions.add(sessionId);
      }
    }
  }

  /**
   * Handle a session asking the user something (permission asked, question
   * or — on 2.x — a form created).
   * Emits for root sessions and tracked child sessions.
   */
  private handleUserRequestAsked(
    kind: UserRequestAskedEvent["kind"],
    id: string,
    sessionID: string
  ): void {
    if (!this.isTrackedSession(sessionID)) return;

    const event = { kind, id, sessionID };
    for (const listener of this.userRequestListeners) {
      listener({ type: "asked", event });
    }
  }

  /**
   * Handle a pending request being answered. Only the fact matters here, not
   * the answer.
   * Emits for root sessions and tracked child sessions.
   */
  private handleUserRequestResolved(
    kind: UserRequestResolvedEvent["kind"],
    requestID: string,
    sessionID: string
  ): void {
    if (!this.isTrackedSession(sessionID)) return;

    const event = { kind, requestID, sessionID };
    for (const listener of this.userRequestListeners) {
      listener({ type: "resolved", event });
    }
  }

  /**
   * A root session, or a child session mapped to one.
   */
  private isTrackedSession(sessionId: string): boolean {
    return this.rootSessionIds.has(sessionId) || this.childToRootSession.has(sessionId);
  }
}

/** Re-exported for the provider's convenience. */
export type { WirePromptOptions } from "./wire";
