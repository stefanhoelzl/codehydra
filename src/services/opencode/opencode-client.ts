/**
 * OpenCode client for communicating with OpenCode instances.
 * Handles HTTP requests and SSE connections.
 */

import { EventSource } from "eventsource";
import { fetchWithTimeout } from "../platform/http";
import { OpenCodeError } from "../errors";
import {
  ok,
  err,
  type Result,
  type Session,
  type SessionListResponse,
  type SessionStatus,
  type SessionStatusResponse,
  type SessionStatusValue,
  type ClientStatus,
  type IDisposable,
  type Unsubscribe,
  type PermissionUpdatedEvent,
  type PermissionRepliedEvent,
} from "./types";

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
 */
export function isValidSessionStatus(value: unknown): value is SessionStatusValue {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return obj.type === "idle" || obj.type === "busy" || obj.type === "retry";
}

/**
 * Type guard for SessionStatusResponse.
 * OpenCode returns an array of SessionStatusValue objects.
 */
export function isSessionStatusResponse(value: unknown): value is SessionStatusResponse {
  if (!Array.isArray(value)) return false;

  return value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      (item.type === "idle" || item.type === "busy" || item.type === "retry")
  );
}

/**
 * Type guard for SessionListResponse.
 * Validates session list from /session endpoint.
 */
function isSessionListResponse(value: unknown): value is SessionListResponse {
  if (!Array.isArray(value)) return false;

  return value.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof s.id === "string" &&
      typeof s.directory === "string" &&
      (s.parentID === undefined || typeof s.parentID === "string")
  );
}

/**
 * Client for communicating with a single OpenCode instance.
 */
export class OpenCodeClient implements IDisposable {
  private readonly baseUrl: string;
  private readonly listeners = new Set<SessionEventCallback>();
  private readonly permissionListeners = new Set<PermissionEventCallback>();
  private readonly statusListeners = new Set<StatusChangedCallback>();
  private eventSource: EventSource | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;

  /**
   * Set of root session IDs (sessions without a parentID).
   * Only events for these sessions are emitted.
   */
  private readonly rootSessionIds = new Set<string>();

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

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  /**
   * Get all sessions and identify root sessions (those without parentID).
   * Must be called before connect() to properly filter events.
   */
  async fetchRootSessions(): Promise<Result<Session[], OpenCodeError>> {
    const url = `${this.baseUrl}/session`;

    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return err(new OpenCodeError(`HTTP ${response.status}`, "REQUEST_FAILED"));
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return err(new OpenCodeError("Invalid JSON response", "INVALID_RESPONSE"));
      }

      if (!isSessionListResponse(data)) {
        return err(new OpenCodeError("Invalid response structure", "INVALID_RESPONSE"));
      }

      // Clear and rebuild root session set
      this.rootSessionIds.clear();
      for (const session of data) {
        if (!session.parentID) {
          this.rootSessionIds.add(session.id);
        }
      }

      // Return only root sessions
      const rootSessions = data.filter((s) => !s.parentID);
      return ok(rootSessions);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return err(new OpenCodeError("Request timeout", "TIMEOUT"));
      }
      return err(
        new OpenCodeError(
          error instanceof Error ? error.message : "Unknown error",
          "REQUEST_FAILED"
        )
      );
    }
  }

  /**
   * Check if a session ID is a root session.
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
   * Get current status from the API.
   * Fetches /session/status and aggregates to a single ClientStatus.
   * Empty array or all idle → "idle", any busy/retry → "busy"
   */
  async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
    const url = `${this.baseUrl}/session/status`;

    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return err(new OpenCodeError(`HTTP ${response.status}`, "REQUEST_FAILED"));
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return err(new OpenCodeError("Invalid JSON response", "INVALID_RESPONSE"));
      }

      if (!isSessionStatusResponse(data)) {
        return err(new OpenCodeError("Invalid response structure", "INVALID_RESPONSE"));
      }

      // Aggregate: empty array OR all idle → "idle", any busy/retry → "busy"
      const hasBusy = data.some((s) => s.type === "busy" || s.type === "retry");
      const status: ClientStatus = hasBusy ? "busy" : "idle";

      return ok(status);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return err(new OpenCodeError("Request timeout", "TIMEOUT"));
      }
      return err(
        new OpenCodeError(
          error instanceof Error ? error.message : "Unknown error",
          "REQUEST_FAILED"
        )
      );
    }
  }

  /**
   * Connect to SSE event stream.
   */
  connect(): void {
    if (this.disposed || this.eventSource) return;

    try {
      this.eventSource = new EventSource(`${this.baseUrl}/event`);

      this.eventSource.onopen = () => {
        // Reset reconnect delay on successful connection
        this.reconnectDelay = 1000;

        // Re-fetch current status after reconnection to sync state
        void this.getStatus().then((result) => {
          if (result.ok) {
            this.updateCurrentStatus(result.value);
          }
        });
      };

      this.eventSource.onerror = () => {
        this.handleDisconnect();
      };

      // OpenCode sends all events as unnamed SSE events with a "type" field in the JSON payload.
      // Example: data: {"type":"session.status","properties":{"sessionID":"...","status":{"type":"busy"}}}
      //
      // This is NOT the named event format (event: session.status\ndata: ...) that would
      // trigger addEventListener(). Therefore, we must use onmessage to receive all events.
      this.eventSource.onmessage = (event) => {
        this.handleMessage(event);
      };
    } catch {
      this.handleDisconnect();
    }
  }

  /**
   * Disconnect from SSE event stream.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
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
  }

  /**
   * Handle incoming SSE message.
   * Parses the OpenCode wire format and dispatches to appropriate handlers.
   *
   * OpenCode wire format: { type: "event.name", properties: { ... } }
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data as string) as {
        type?: string;
        properties?: {
          sessionID?: string;
          status?: { type?: string };
          info?: { id?: string; parentID?: string };
          id?: string;
          type?: string;
          title?: string;
          permissionID?: string;
          response?: string;
        };
      };

      if (!data.type) return;

      // Dispatch to appropriate handler based on event type
      switch (data.type) {
        case "session.status":
          this.handleSessionStatus(data.properties);
          break;
        case "session.created":
          this.handleSessionCreated(data.properties);
          break;
        case "session.idle":
          this.handleSessionIdle(data.properties);
          break;
        case "session.deleted":
          this.handleSessionDeleted(data.properties);
          break;
        case "permission.updated":
          this.handlePermissionUpdated(data.properties);
          break;
        case "permission.replied":
          this.handlePermissionReplied(data.properties);
          break;
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle session.status events.
   */
  private handleSessionStatus(properties?: {
    sessionID?: string;
    status?: { type?: string };
  }): void {
    if (!properties?.sessionID || !properties?.status?.type) return;

    const statusType = properties.status.type;
    // Map "retry" to "busy"
    if (statusType === "idle" || statusType === "busy" || statusType === "retry") {
      const mappedType = statusType === "retry" ? "busy" : statusType;
      this.emitSessionEvent({ type: mappedType, sessionId: properties.sessionID });

      // Update current status and emit if changed
      this.updateCurrentStatus(mappedType);
    }
  }

  /**
   * Handle session.idle events.
   */
  private handleSessionIdle(properties?: { sessionID?: string }): void {
    if (!properties?.sessionID) return;
    this.emitSessionEvent({ type: "idle", sessionId: properties.sessionID });

    // Update current status to idle
    this.updateCurrentStatus("idle");
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
   */
  private handleSessionDeleted(properties?: { sessionID?: string }): void {
    if (!properties?.sessionID) return;
    this.emitSessionEvent({ type: "deleted", sessionId: properties.sessionID });
  }

  /**
   * Emit a session event to all listeners.
   * Only emits for root sessions (those without parentID).
   */
  private emitSessionEvent(event: SessionStatus): void {
    // Only emit events for root sessions
    if (!this.rootSessionIds.has(event.sessionId)) {
      return;
    }

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
   * Adds new root sessions to the tracking set.
   */
  private handleSessionCreated(properties?: { info?: { id?: string; parentID?: string } }): void {
    const sessionInfo = properties?.info;
    if (!sessionInfo || typeof sessionInfo.id !== "string") return;

    // Only track root sessions (those without parentID)
    if (!sessionInfo.parentID) {
      this.rootSessionIds.add(sessionInfo.id);
      // Emit idle status for new root session
      this.emitSessionEvent({ type: "idle", sessionId: sessionInfo.id });
    }
  }

  /**
   * Handle permission.updated events.
   * Only emits for root sessions.
   */
  private handlePermissionUpdated(properties?: {
    id?: string;
    sessionID?: string;
    type?: string;
    title?: string;
  }): void {
    if (!isPermissionUpdatedEvent(properties)) return;

    // Only emit for root sessions
    if (!this.rootSessionIds.has(properties.sessionID)) return;

    for (const listener of this.permissionListeners) {
      listener({ type: "permission.updated", event: properties });
    }
  }

  /**
   * Handle permission.replied events.
   * Only emits for root sessions.
   */
  private handlePermissionReplied(properties?: {
    sessionID?: string;
    permissionID?: string;
    response?: string;
  }): void {
    if (!isPermissionRepliedEvent(properties)) return;

    // Only emit for root sessions
    if (!this.rootSessionIds.has(properties.sessionID)) return;

    for (const listener of this.permissionListeners) {
      listener({ type: "permission.replied", event: properties });
    }
  }

  private handleDisconnect(): void {
    this.disconnect();

    if (this.disposed) return;

    // Exponential backoff reconnection
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) {
        this.connect();
      }
    }, this.reconnectDelay);

    // Increase delay for next attempt (capped at max)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
