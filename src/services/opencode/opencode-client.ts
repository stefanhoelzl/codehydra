/**
 * OpenCode client for communicating with OpenCode instances.
 * Uses the official @opencode-ai/sdk for HTTP and SSE operations.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type Session as SdkSession,
  type Event as SdkEvent,
  type SessionStatus as SdkSessionStatus,
} from "@opencode-ai/sdk";
import { OpenCodeError, getErrorMessage } from "../errors";
import type { Logger } from "../logging";
import {
  ok,
  err,
  type Result,
  type Session,
  type SessionStatus,
  type ClientStatus,
  type IDisposable,
  type Unsubscribe,
  type PermissionUpdatedEvent,
  type PermissionRepliedEvent,
} from "./types";

/**
 * Factory function type for creating SDK clients.
 * Used for dependency injection and testing.
 */
export type SdkClientFactory = (baseUrl: string) => OpencodeClient;

/**
 * Default SDK factory that creates a real OpencodeClient.
 */
const defaultSdkFactory: SdkClientFactory = (baseUrl: string) => createOpencodeClient({ baseUrl });

/**
 * Type guard for PermissionUpdatedEvent.
 * Validates the structure of a permission.updated SSE event.
 */
export function isPermissionUpdatedEvent(value: unknown): value is PermissionUpdatedEvent {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.sessionID === "string" &&
    typeof obj.type === "string" &&
    typeof obj.title === "string"
  );
}

/**
 * Type guard for PermissionRepliedEvent.
 * Validates the structure of a permission.replied SSE event.
 */
export function isPermissionRepliedEvent(value: unknown): value is PermissionRepliedEvent {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionID === "string" &&
    typeof obj.permissionID === "string" &&
    (obj.response === "once" || obj.response === "always" || obj.response === "reject")
  );
}

/**
 * Callback for session events.
 */
export type SessionEventCallback = (event: SessionStatus) => void;

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (status: ClientStatus) => void;

/**
 * Permission event payload.
 */
export type PermissionEvent =
  | { type: "permission.updated"; event: PermissionUpdatedEvent }
  | { type: "permission.replied"; event: PermissionRepliedEvent };

/**
 * Callback for permission events.
 */
export type PermissionEventCallback = (event: PermissionEvent) => void;

/**
 * Type guard for SessionStatusValue.
 * Validates individual session status from the response.
 * @internal Exported for testing only
 */
export function isValidSessionStatus(value: unknown): value is SdkSessionStatus {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return obj.type === "idle" || obj.type === "busy" || obj.type === "retry";
}

/**
 * Type guard for SessionStatusResponse (SDK format: Record<string, SessionStatus>).
 * @internal Exported for testing only
 */
export function isSessionStatusResponse(value: unknown): value is Record<string, SdkSessionStatus> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const obj = value as Record<string, unknown>;
  return Object.values(obj).every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      ((item as Record<string, unknown>).type === "idle" ||
        (item as Record<string, unknown>).type === "busy" ||
        (item as Record<string, unknown>).type === "retry")
  );
}

/**
 * Result from SDK event.subscribe()
 */
interface SdkEventSubscription {
  stream: AsyncIterable<SdkEvent>;
}

/**
 * Client for communicating with a single OpenCode instance.
 *
 * Uses the official @opencode-ai/sdk for HTTP and SSE operations.
 * SDK client is injected via factory for testability.
 */
export class OpenCodeClient implements IDisposable {
  private readonly baseUrl: string;
  private readonly port: number;
  private readonly sdk: OpencodeClient;
  private readonly logger: Logger;
  private readonly listeners = new Set<SessionEventCallback>();
  private readonly permissionListeners = new Set<PermissionEventCallback>();
  private readonly statusListeners = new Set<StatusChangedCallback>();
  private eventSubscription: SdkEventSubscription | null = null;
  private disposed = false;

  /**
   * Set of root session IDs (sessions without a parentID).
   * Only events for these sessions are emitted.
   */
  private readonly rootSessionIds = new Set<string>();

  /**
   * Map of child session ID to its root session ID.
   * Used to emit permission events for subagents under their root session.
   */
  private readonly childToRootSession = new Map<string, string>();

  /**
   * Current aggregated status for this port.
   * Simplified model: 1 agent per port.
   */
  private _currentStatus: ClientStatus = "idle";

  /**
   * Get the current status for this client.
   */
  get currentStatus(): ClientStatus {
    return this._currentStatus;
  }

  constructor(port: number, logger: Logger, sdkFactory: SdkClientFactory = defaultSdkFactory) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.logger = logger;
    this.sdk = sdkFactory(this.baseUrl);
  }

  /**
   * Lists all sessions from the OpenCode server.
   * Returns all sessions without filtering (caller can filter as needed).
   */
  async listSessions(): Promise<Result<Session[], OpenCodeError>> {
    this.logger.debug("Listing sessions");
    try {
      const result = await this.sdk.session.list();
      const sessions = result.data as SdkSession[];
      return ok(sessions.map((s) => this.mapSdkSession(s)));
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  /**
   * Check if a session ID is a root session.
   * Used internally for event filtering.
   */
  isRootSession(sessionId: string): boolean {
    return this.rootSessionIds.has(sessionId);
  }

  /**
   * Subscribe to session events.
   */
  onSessionEvent(callback: SessionEventCallback): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Subscribe to permission events.
   */
  onPermissionEvent(callback: PermissionEventCallback): Unsubscribe {
    this.permissionListeners.add(callback);
    return () => this.permissionListeners.delete(callback);
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
   * Empty or all idle → "idle", any busy/retry → "busy"
   */
  async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
    try {
      const result = await this.sdk.session.status();
      const statuses = result.data as Record<string, SdkSessionStatus>;

      // Aggregate: empty OR all idle → "idle", any busy/retry → "busy"
      const hasBusy = Object.values(statuses).some((s) => s.type === "busy" || s.type === "retry");
      const status: ClientStatus = hasBusy ? "busy" : "idle";

      return ok(status);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  /**
   * Create a new session.
   * The session is immediately tracked in rootSessionIds before SSE events arrive.
   * This ensures proper status tracking even if session.status arrives before session.created.
   *
   * @returns The full session object on success, or an error
   */
  async createSession(): Promise<Result<Session, OpenCodeError>> {
    try {
      const result = await this.sdk.session.create({ body: {} });
      if (!result.data) {
        return err(new OpenCodeError("Session creation returned no data", "REQUEST_FAILED"));
      }

      const session = this.mapSdkSession(result.data);

      // Track immediately - don't wait for SSE session.created event
      // This ensures session.status events are handled correctly
      this.rootSessionIds.add(session.id);

      this.logger.debug("Session created", { port: this.port, sessionId: session.id });
      return ok(session);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  /**
   * Send a prompt to an existing session.
   *
   * @param sessionId - The session to send the prompt to
   * @param prompt - The prompt text
   * @param options - Optional agent and model configuration
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: { agent?: string; model?: { providerID: string; modelID: string } }
  ): Promise<Result<void, OpenCodeError>> {
    try {
      await this.sdk.session.prompt({
        path: { id: sessionId },
        body: {
          ...(options?.agent !== undefined && { agent: options.agent }),
          ...(options?.model !== undefined && { model: options.model }),
          parts: [{ type: "text", text: prompt }],
        },
      });

      this.logger.debug("Prompt sent", {
        port: this.port,
        sessionId,
        promptLength: prompt.length,
        ...(options?.agent !== undefined && { agent: options.agent }),
      });
      return ok(undefined);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  /**
   * Connect to SSE event stream.
   *
   * @param timeoutMs - Connection timeout in milliseconds. Default: 5000
   * @throws Error if connection fails or times out
   */
  async connect(timeoutMs = 5000): Promise<void> {
    if (this.disposed || this.eventSubscription) return;

    this.logger.info("Connecting", { port: this.port });

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connect timeout")), timeoutMs)
      );

      const events = await Promise.race([this.sdk.event.subscribe(), timeoutPromise]);

      this.eventSubscription = events;

      this.logger.info("Connected", { port: this.port });

      // Process events in background with error handling
      this.processEvents(events.stream).catch((processError) => {
        if (!this.disposed) {
          this.logger.warn("Connection error", {
            port: this.port,
            error: getErrorMessage(processError),
          });
        }
      });

      // Sync initial status with error handling
      try {
        const result = await this.getStatus();
        if (result.ok) {
          this.updateCurrentStatus(result.value);
        }
      } catch (statusError) {
        this.logger.warn("Connection error", {
          port: this.port,
          error: getErrorMessage(statusError),
        });
      }
    } catch (connectError) {
      this.logger.warn("Connection error", {
        port: this.port,
        error: getErrorMessage(connectError),
      });
      throw connectError;
    }
  }

  /**
   * Disconnect from SSE event stream.
   *
   * This method closes the SSE subscription but keeps the SDK client instance.
   * Used during server restart flow to temporarily disconnect while preserving
   * session tracking state. After restart, create a new OpenCodeClient and
   * call connect() to resume event streaming.
   *
   * Note: For permanent cleanup, use dispose() instead which also clears
   * all listeners and session tracking.
   */
  disconnect(): void {
    this.eventSubscription = null;
    this.logger.info("Disconnected", { port: this.port });
  }

  /**
   * Dispose the client.
   */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
    this.permissionListeners.clear();
    this.statusListeners.clear();
    this.rootSessionIds.clear();
    this.childToRootSession.clear();
  }

  /**
   * Process events from the SDK event stream.
   */
  private async processEvents(stream: AsyncIterable<SdkEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.disposed || !this.eventSubscription) break;
        this.handleSdkEvent(event);
      }
    } catch (error) {
      if (this.disposed) return; // Expected during shutdown
      this.logger.warn("Connection error", { port: this.port, error: getErrorMessage(error) });
      throw error; // Re-throw for .catch() handler
    }
  }

  /**
   * Handle an SDK event and dispatch to appropriate handlers.
   */
  private handleSdkEvent(event: SdkEvent): void {
    switch (event.type) {
      case "session.status":
        this.handleSessionStatus(event.properties);
        break;
      case "session.created":
        this.handleSessionCreated(event.properties);
        break;
      case "session.idle":
        this.handleSessionIdle(event.properties);
        break;
      case "session.deleted":
        this.handleSessionDeleted(event.properties);
        break;
      case "permission.updated":
        this.handlePermissionUpdated(event.properties);
        break;
      case "permission.replied":
        this.handlePermissionReplied(event.properties);
        break;
    }
  }

  /**
   * Handle incoming SSE message.
   * Accepts MessageEvent for simulating SSE events in tests.
   * @internal
   */
  handleMessage(event: MessageEvent): void {
    this.handleRawMessage(event.data as string);
  }

  /**
   * Handle incoming raw SSE message data.
   * Parses the OpenCode wire format and dispatches to appropriate handlers.
   *
   * OpenCode wire format: { type: "event.name", properties: { ... } }
   * @internal - Used for backward compatibility with existing tests
   */
  private handleRawMessage(data: string): void {
    try {
      const parsed = JSON.parse(data) as SdkEvent;
      if (!parsed.type) return;
      this.handleSdkEvent(parsed);
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle session.status events.
   */
  private handleSessionStatus(properties: { sessionID: string; status: SdkSessionStatus }): void {
    if (!properties?.sessionID || !properties?.status?.type) return;

    const statusType = properties.status.type;
    // Map "retry" to "busy"
    if (statusType === "idle" || statusType === "busy" || statusType === "retry") {
      const mappedType = statusType === "retry" ? "busy" : statusType;
      this.logger.debug("Session status", { sessionId: properties.sessionID, status: mappedType });
      this.emitSessionEvent({ type: mappedType, sessionId: properties.sessionID });

      // Only update current status for root sessions (main agents)
      // This ensures notification chimes only play when main agents finish, not subagents
      if (this.rootSessionIds.has(properties.sessionID)) {
        this.updateCurrentStatus(mappedType);
      }
    }
  }

  /**
   * Handle session.idle events.
   */
  private handleSessionIdle(properties: { sessionID: string }): void {
    if (!properties?.sessionID) return;
    this.emitSessionEvent({ type: "idle", sessionId: properties.sessionID });

    // Only update current status for root sessions (main agents)
    // This ensures notification chimes only play when main agents finish, not subagents
    if (this.rootSessionIds.has(properties.sessionID)) {
      this.updateCurrentStatus("idle");
    }
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
   * Handle session.deleted events.
   * Accepts either SDK format ({ info: Session }) or legacy format ({ sessionID: string }).
   */
  private handleSessionDeleted(properties?: { info?: { id?: string }; sessionID?: string }): void {
    // Support SDK format (info.id) and legacy format (sessionID)
    const sessionId = properties?.info?.id ?? properties?.sessionID;
    if (!sessionId) return;

    // Clean up child mapping if this was a child session
    this.childToRootSession.delete(sessionId);

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
   * Handle session.created events.
   * Adds new root sessions to the tracking set, and maps child sessions to their root.
   * Emits a "created" event to notify listeners that a session exists but status is unknown.
   */
  private handleSessionCreated(properties?: { info?: { id?: string; parentID?: string } }): void {
    const sessionInfo = properties?.info;
    if (!sessionInfo || typeof sessionInfo.id !== "string") return;

    if (!sessionInfo.parentID) {
      // Root session
      this.rootSessionIds.add(sessionInfo.id);
      // Emit "created" event - status is unknown until we receive session.status
      // This allows sessionToPort tracking without assuming idle status
      this.emitSessionEvent({ type: "created", sessionId: sessionInfo.id });
    } else {
      // Child session: map to its root
      if (this.rootSessionIds.has(sessionInfo.parentID)) {
        // Direct child of a root session
        this.childToRootSession.set(sessionInfo.id, sessionInfo.parentID);
      } else {
        // Parent is also a child - find its root
        const rootId = this.childToRootSession.get(sessionInfo.parentID);
        if (rootId) {
          this.childToRootSession.set(sessionInfo.id, rootId);
        }
      }
    }
  }

  /**
   * Handle permission.updated events.
   * Emits for root sessions and tracked child sessions.
   */
  private handlePermissionUpdated(properties?: {
    id?: string;
    sessionID?: string;
    type?: string;
    title?: string;
  }): void {
    if (!isPermissionUpdatedEvent(properties)) return;

    // Emit for root sessions OR child sessions mapped to a root
    const isTracked =
      this.rootSessionIds.has(properties.sessionID) ||
      this.childToRootSession.has(properties.sessionID);

    if (!isTracked) return;

    for (const listener of this.permissionListeners) {
      listener({ type: "permission.updated", event: properties });
    }
  }

  /**
   * Handle permission.replied events.
   * Emits for root sessions and tracked child sessions.
   */
  private handlePermissionReplied(properties?: {
    sessionID?: string;
    permissionID?: string;
    response?: string;
  }): void {
    if (!isPermissionRepliedEvent(properties)) return;

    // Emit for root sessions OR child sessions mapped to a root
    const isTracked =
      this.rootSessionIds.has(properties.sessionID) ||
      this.childToRootSession.has(properties.sessionID);

    if (!isTracked) return;

    for (const listener of this.permissionListeners) {
      listener({ type: "permission.replied", event: properties });
    }
  }

  /**
   * Map SDK session to our Session type.
   */
  private mapSdkSession(sdkSession: SdkSession): Session {
    const session: Session = {
      id: sdkSession.id,
      directory: sdkSession.directory,
      title: sdkSession.title,
    };
    // Only add parentID if it exists (to satisfy exactOptionalPropertyTypes)
    if (sdkSession.parentID) {
      return { ...session, parentID: sdkSession.parentID };
    }
    return session;
  }

  /**
   * Map SDK errors to OpenCodeError.
   */
  private mapSdkError(error: unknown): OpenCodeError {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timeout")) {
        return new OpenCodeError("Request timeout", "TIMEOUT");
      }
      if (message.includes("econnrefused") || message.includes("connection refused")) {
        return new OpenCodeError("Connection refused", "CONNECTION_REFUSED");
      }
      return new OpenCodeError(error.message, "REQUEST_FAILED");
    }
    return new OpenCodeError("Unknown error", "REQUEST_FAILED");
  }
}
