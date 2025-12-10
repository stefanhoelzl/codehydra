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
 * OpenCode returns an object keyed by session ID.
 */
export function isSessionStatusResponse(value: unknown): value is SessionStatusResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const obj = value as Record<string, unknown>;
  return Object.values(obj).every((v) => isValidSessionStatus(v));
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
   * Get current session statuses.
   */
  async getSessionStatuses(): Promise<Result<SessionStatus[], OpenCodeError>> {
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

      // Only return statuses for root sessions
      // Response is object format: { sessionId: { type: "idle" | "busy" | "retry" } }
      const statuses: SessionStatus[] = [];
      for (const [sessionId, statusValue] of Object.entries(data)) {
        if (this.rootSessionIds.has(sessionId)) {
          // Map "retry" to "busy" for our internal status representation
          const statusType = statusValue.type === "retry" ? "busy" : statusValue.type;
          statuses.push({
            type: statusType,
            sessionId,
          });
        }
      }

      return ok(statuses);
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
   * Connect to SSE event stream.
   */
  connect(): void {
    if (this.disposed || this.eventSource) return;

    try {
      this.eventSource = new EventSource(`${this.baseUrl}/event`);

      this.eventSource.onopen = () => {
        // Reset reconnect delay on successful connection
        this.reconnectDelay = 1000;
      };

      this.eventSource.onerror = () => {
        this.handleDisconnect();
      };

      this.eventSource.onmessage = (event) => {
        this.handleMessage(event);
      };

      // Listen for specific event types
      this.eventSource.addEventListener("session.status", (event) => {
        const parsed = this.parseSSEEvent("session.status", event.data);
        if (parsed) this.emitSessionEvent(parsed);
      });

      this.eventSource.addEventListener("session.deleted", (event) => {
        const parsed = this.parseSSEEvent("session.deleted", event.data);
        if (parsed) this.emitSessionEvent(parsed);
      });

      this.eventSource.addEventListener("session.idle", (event) => {
        const parsed = this.parseSSEEvent("session.idle", event.data);
        if (parsed) this.emitSessionEvent(parsed);
      });

      this.eventSource.addEventListener("session.created", (event) => {
        this.handleSessionCreated(event.data);
      });

      // Listen for permission events
      this.eventSource.addEventListener("permission.updated", (event) => {
        this.handlePermissionUpdated(event.data);
      });

      this.eventSource.addEventListener("permission.replied", (event) => {
        this.handlePermissionReplied(event.data);
      });
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
  }

  /**
   * Parse an SSE event into a SessionStatus.
   * Exposed for testing.
   */
  private parseSSEEvent(eventType: string, data: string): SessionStatus | null {
    try {
      const parsed = JSON.parse(data) as { id?: string; status?: string };

      if (typeof parsed.id !== "string") return null;

      switch (eventType) {
        case "session.status":
          if (parsed.status === "idle" || parsed.status === "busy") {
            return { type: parsed.status, sessionId: parsed.id };
          }
          return null;
        case "session.idle":
          return { type: "idle", sessionId: parsed.id };
        case "session.deleted":
          return { type: "deleted", sessionId: parsed.id };
        default:
          return null;
      }
    } catch {
      return null;
    }
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
  private handleSessionCreated(data: string): void {
    try {
      const parsed = JSON.parse(data) as {
        info?: { id?: string; parentID?: string };
      };

      const sessionInfo = parsed.info;
      if (!sessionInfo || typeof sessionInfo.id !== "string") return;

      // Only track root sessions (those without parentID)
      if (!sessionInfo.parentID) {
        this.rootSessionIds.add(sessionInfo.id);
        // Emit idle status for new root session
        this.emitSessionEvent({ type: "idle", sessionId: sessionInfo.id });
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle permission.updated events.
   * Only emits for root sessions.
   */
  private handlePermissionUpdated(data: string): void {
    try {
      const parsed = JSON.parse(data) as unknown;

      if (!isPermissionUpdatedEvent(parsed)) return;

      // Only emit for root sessions
      if (!this.rootSessionIds.has(parsed.sessionID)) return;

      for (const listener of this.permissionListeners) {
        listener({ type: "permission.updated", event: parsed });
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle permission.replied events.
   * Only emits for root sessions.
   */
  private handlePermissionReplied(data: string): void {
    try {
      const parsed = JSON.parse(data) as unknown;

      if (!isPermissionRepliedEvent(parsed)) return;

      // Only emit for root sessions
      if (!this.rootSessionIds.has(parsed.sessionID)) return;

      for (const listener of this.permissionListeners) {
        listener({ type: "permission.replied", event: parsed });
      }
    } catch {
      // Ignore parse errors
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data as string) as {
        type?: string;
        properties?: {
          sessionID?: string;
          status?: { type?: string };
          info?: { id?: string; parentID?: string };
          // Permission event properties
          id?: string;
          type?: string;
          title?: string;
          permissionID?: string;
          response?: string;
        };
      };

      if (!data.type) return;

      // Handle session.created specially - needs info.parentID check
      if (data.type === "session.created") {
        const sessionInfo = data.properties?.info;
        if (sessionInfo && typeof sessionInfo.id === "string" && !sessionInfo.parentID) {
          this.rootSessionIds.add(sessionInfo.id);
          this.emitSessionEvent({ type: "idle", sessionId: sessionInfo.id });
        }
        return;
      }

      // Handle permission events
      if (data.type === "permission.updated") {
        const props = data.properties;
        if (
          props &&
          typeof props.id === "string" &&
          typeof props.sessionID === "string" &&
          typeof props.type === "string" &&
          typeof props.title === "string"
        ) {
          // Only emit for root sessions
          if (!this.rootSessionIds.has(props.sessionID)) return;

          for (const listener of this.permissionListeners) {
            listener({
              type: "permission.updated",
              event: {
                id: props.id,
                sessionID: props.sessionID,
                type: props.type,
                title: props.title,
              },
            });
          }
        }
        return;
      }

      if (data.type === "permission.replied") {
        const props = data.properties;
        if (
          props &&
          typeof props.sessionID === "string" &&
          typeof props.permissionID === "string" &&
          (props.response === "once" || props.response === "always" || props.response === "reject")
        ) {
          // Only emit for root sessions
          if (!this.rootSessionIds.has(props.sessionID)) return;

          for (const listener of this.permissionListeners) {
            listener({
              type: "permission.replied",
              event: {
                sessionID: props.sessionID,
                permissionID: props.permissionID,
                response: props.response,
              },
            });
          }
        }
        return;
      }

      if (!data.properties?.sessionID) return;

      let sessionEvent: SessionStatus | null = null;

      switch (data.type) {
        case "session.status": {
          const statusType = data.properties.status?.type;
          if (statusType === "idle" || statusType === "busy") {
            sessionEvent = { type: statusType, sessionId: data.properties.sessionID };
          }
          break;
        }
        case "session.idle":
          sessionEvent = { type: "idle", sessionId: data.properties.sessionID };
          break;
        case "session.deleted":
          sessionEvent = { type: "deleted", sessionId: data.properties.sessionID };
          break;
      }

      if (sessionEvent) {
        this.emitSessionEvent(sessionEvent);
      }
    } catch {
      // Ignore parse errors for non-session events
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
