/**
 * OpenCode Provider - manages a single OpenCode client connection per workspace.
 *
 * Each workspace has exactly one managed OpenCode server. The provider handles:
 * - Client connection lifecycle
 * - Session creation and tracking
 * - Status aggregation (idle/busy counts)
 * - Permission tracking for status display
 */

import type { AgentProvider, AgentSessionInfo, AgentStatus } from "../types";
import type { IDisposable, Unsubscribe, ClientStatus, Result, Session } from "./types";
import { OpenCodeClient, type PermissionEvent, type SdkClientFactory } from "./client";
import { OpenCodeError } from "../../services/errors";
import { findMatchingSession } from "./session-utils";
import { err } from "./types";
import type { Logger } from "../../services/logging";

/**
 * Per-workspace provider that manages a single OpenCode client connection.
 * Each workspace has exactly one managed OpenCode server.
 *
 * Implements AgentProvider interface for use in the agent abstraction layer.
 */
export class OpenCodeProvider implements AgentProvider, IDisposable {
  private client: OpenCodeClient | null = null;
  private clientStatus: ClientStatus = "idle";
  private readonly sdkFactory: SdkClientFactory | undefined;
  private readonly logger: Logger;
  private readonly workspacePath: string;

  /**
   * Port of the OpenCode server for this workspace.
   * Set during connect(), preserved during restart.
   */
  private _port: number | null = null;

  /**
   * Primary session ID for this workspace.
   * Created or found during connect(), preserved during restart.
   */
  private _primarySessionId: string | null = null;

  /**
   * Whether TUI has attached (first MCP request received).
   * Used to determine when to show status vs "none".
   */
  private tuiAttached = false;

  /**
   * Session to port mapping for permission correlation.
   * Map<sessionId, port>
   */
  private readonly sessionToPort = new Map<string, number>();
  /**
   * Pending permissions per session.
   * Map<sessionId, Set<permissionId>>
   * Ports with pending permissions should display as idle (green indicator).
   */
  private readonly pendingPermissions = new Map<string, Set<string>>();
  /**
   * Callbacks to notify when status changes.
   */
  private readonly statusChangeListeners = new Set<(status: AgentStatus) => void>();

  constructor(workspacePath: string, logger: Logger, sdkFactory: SdkClientFactory | undefined) {
    this.workspacePath = workspacePath;
    this.logger = logger;
    this.sdkFactory = sdkFactory;
  }

  /**
   * Returns the primary session info for this workspace.
   * Returns null if not initialized or if session creation failed.
   */
  getSession(): AgentSessionInfo | null {
    if (this._port === null || this._primarySessionId === null) {
      return null;
    }
    return { port: this._port, sessionId: this._primarySessionId };
  }

  /**
   * Get environment variables needed for terminal integration.
   * These are set by the sidekick extension for all new terminals.
   */
  getEnvironmentVariables(): Record<string, string> {
    const session = this.getSession();
    if (!session) {
      return {};
    }
    return {
      CODEHYDRA_OPENCODE_PORT: String(session.port),
      CODEHYDRA_OPENCODE_SESSION_ID: session.sessionId,
      CODEHYDRA_WORKSPACE_PATH: this.workspacePath,
    };
  }

  /**
   * Check if provider has a connected client.
   */
  hasClient(): boolean {
    return this.client !== null;
  }

  /**
   * Mark agent as active for this workspace.
   * Called when the first MCP request is received.
   */
  markActive(): void {
    if (!this.tuiAttached) {
      this.tuiAttached = true;
      this.notifyStatusChange();
    }
  }

  /**
   * Get effective counts accounting for permission state.
   * Ports with pending permissions count as idle (waiting for user).
   * Returns { idle: 0, busy: 0 } if TUI has not attached yet (no MCP request received).
   */
  getEffectiveCounts(): { idle: number; busy: number } {
    // No client or TUI not attached yet - show "none"
    if (!this.client || !this.tuiAttached) {
      return { idle: 0, busy: 0 };
    }

    // TUI attached - show status based on client state
    // If no sessions yet, show as idle (ready to use)
    if (this.sessionToPort.size === 0) {
      return { idle: 1, busy: 0 };
    }

    // Check if any session has pending permission
    const hasPermissionPending = [...this.sessionToPort.keys()].some((sessionId) =>
      this.pendingPermissions.has(sessionId)
    );

    if (hasPermissionPending) {
      return { idle: 1, busy: 0 };
    }

    if (this.clientStatus === "idle") {
      return { idle: 1, busy: 0 };
    }

    return { idle: 0, busy: 1 };
  }

  /**
   * Connect to the OpenCode server at the given port.
   * Creates OpenCodeClient, finds or creates a session, and connects to SSE.
   * Handles connection failures gracefully - client will still be created
   * but may not receive real-time updates.
   */
  async connect(port: number): Promise<void> {
    if (this.client) return;

    // Store the port
    this._port = port;

    const client = new OpenCodeClient(port, this.logger, this.sdkFactory);

    // Subscribe to status changes from client
    client.onStatusChanged((status) => this.handleStatusChanged(status));
    // Subscribe to session events for permission correlation
    client.onSessionEvent((event) => this.handleSessionEvent(port, event));
    // Subscribe to permission events
    client.onPermissionEvent((event) => this.handlePermissionEvent(event));

    this.client = client;

    try {
      // List existing sessions to find a matching one
      const sessionsResult = await client.listSessions();
      if (sessionsResult.ok) {
        const matchingSession = findMatchingSession(sessionsResult.value, this.workspacePath);
        if (matchingSession) {
          this._primarySessionId = matchingSession.id;
          client.addRootSession(matchingSession.id);
          this.logger.info("Found existing session", {
            workspacePath: this.workspacePath,
            sessionId: matchingSession.id,
          });
        } else {
          // No matching session found, create a new one
          const createResult = await client.createSession();
          if (createResult.ok) {
            this._primarySessionId = createResult.value.id;
            this.logger.info("Created new session", {
              workspacePath: this.workspacePath,
              sessionId: createResult.value.id,
            });
          } else {
            this.logger.error("Failed to create session", {
              workspacePath: this.workspacePath,
              error: createResult.error.message,
            });
          }
        }
      } else {
        // listSessions failed, try to create a new session instead
        this.logger.warn("Failed to list sessions, creating new session", {
          workspacePath: this.workspacePath,
          error: sessionsResult.error.message,
        });
        const createResult = await client.createSession();
        if (createResult.ok) {
          this._primarySessionId = createResult.value.id;
          this.logger.info("Created new session", {
            workspacePath: this.workspacePath,
            sessionId: createResult.value.id,
          });
        } else {
          this.logger.error("Failed to create session", {
            workspacePath: this.workspacePath,
            error: createResult.error.message,
          });
        }
      }

      // Connect to SSE for real-time updates
      await client.connect();
    } catch (error) {
      // Connection failed - client is still created but may not have real-time updates
      // This can happen if the server is not ready yet or network issues
      // The client can retry later or will receive updates when connection is established
      this.logger.warn("Failed to initialize client", {
        workspacePath: this.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Fetch initial status from the client.
   * Uses the getStatus() API that returns aggregated ClientStatus.
   */
  async fetchStatus(): Promise<void> {
    if (!this.client) {
      return;
    }

    const result = await this.client.getStatus();
    if (result.ok) {
      this.clientStatus = result.value;
    }
  }

  /**
   * Subscribe to status changes.
   * Callback receives computed status ("none" | "idle" | "busy").
   * Returns an unsubscribe function.
   */
  onStatusChange(callback: (status: AgentStatus) => void): Unsubscribe {
    this.statusChangeListeners.add(callback);
    return () => this.statusChangeListeners.delete(callback);
  }

  /**
   * Create a new session.
   * The session is immediately tracked before SSE events arrive.
   *
   * @returns The full session object on success, or an error
   */
  async createSession(): Promise<Result<Session, OpenCodeError>> {
    if (!this.client) {
      return err(new OpenCodeError("Not connected", "NOT_CONNECTED"));
    }
    return this.client.createSession();
  }

  /**
   * Send a prompt to an existing session.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: { agent?: string; model?: { providerID: string; modelID: string } }
  ): Promise<Result<void, OpenCodeError>> {
    if (!this.client) {
      return err(new OpenCodeError("Not connected", "NOT_CONNECTED"));
    }
    return this.client.sendPrompt(sessionId, prompt, options);
  }

  /**
   * Disconnect from the OpenCode server for restart.
   * Disposes the client but keeps port and sessionId for reconnection.
   * Call reconnect() after the server has restarted.
   */
  disconnect(): void {
    this.logger.info("Disconnecting for restart", { workspacePath: this.workspacePath });
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    this.clientStatus = "idle";
    this.sessionToPort.clear();
    this.pendingPermissions.clear();
    // Note: _port and _primarySessionId are preserved for reconnect
    // tuiAttached is preserved so we don't lose status visibility
  }

  /**
   * Reconnect to the OpenCode server after restart.
   * Creates a new client using the preserved port and sessionId.
   * Call disconnect() before server restart, then reconnect() after.
   */
  async reconnect(): Promise<void> {
    if (this._port === null) {
      this.logger.error("Cannot reconnect: no port stored", {
        workspacePath: this.workspacePath,
      });
      return;
    }

    this.logger.info("Reconnecting after restart", {
      workspacePath: this.workspacePath,
      port: this._port,
      sessionId: this._primarySessionId,
    });

    const client = new OpenCodeClient(this._port, this.logger, this.sdkFactory);

    // Subscribe to events
    client.onStatusChanged((status) => this.handleStatusChanged(status));
    client.onSessionEvent((event) => this.handleSessionEvent(this._port!, event));
    client.onPermissionEvent((event) => this.handlePermissionEvent(event));

    this.client = client;

    try {
      // Connect to SSE for real-time updates
      await client.connect();
    } catch (error) {
      this.logger.warn("Failed to reconnect", {
        workspacePath: this.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Dispose the provider completely.
   * Clears all state including port and sessionId.
   * Use for workspace deletion, not server restart.
   */
  dispose(): void {
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    this._port = null;
    this._primarySessionId = null;
    this.clientStatus = "idle";
    this.tuiAttached = false;
    this.sessionToPort.clear();
    this.pendingPermissions.clear();
    this.statusChangeListeners.clear();
  }

  /**
   * Handle status change from a client.
   */
  private handleStatusChanged(status: ClientStatus): void {
    this.clientStatus = status;
    this.notifyStatusChange();
  }

  /**
   * Handle session events from a client.
   * Updates sessionToPort mapping for permission correlation.
   * Notifies listeners on session add/delete as this affects getEffectiveCounts().
   */
  private handleSessionEvent(port: number, event: { type: string; sessionId: string }): void {
    if (event.type === "deleted") {
      this.sessionToPort.delete(event.sessionId);
      this.pendingPermissions.delete(event.sessionId);
      // Notify: session count changed (could transition from "idle" to "none")
      this.notifyStatusChange();
    } else {
      // Map session to port for permission correlation
      this.sessionToPort.set(event.sessionId, port);
      // Notify: session count changed (could transition from "none" to "idle")
      this.notifyStatusChange();
    }
  }

  /**
   * Handle permission events from clients.
   * Tracks pending permissions to override busy status.
   */
  private handlePermissionEvent(event: PermissionEvent): void {
    if (event.type === "permission.updated") {
      // Add permission to pending set
      const sessionId = event.event.sessionID;
      const permissionId = event.event.id;

      if (!this.pendingPermissions.has(sessionId)) {
        this.pendingPermissions.set(sessionId, new Set());
      }
      this.pendingPermissions.get(sessionId)?.add(permissionId);

      // Notify listeners that status may have changed
      this.notifyStatusChange();
    } else if (event.type === "permission.replied") {
      // Remove permission from pending set
      const sessionId = event.event.sessionID;
      const permissionId = event.event.permissionID;

      const permissions = this.pendingPermissions.get(sessionId);
      if (permissions) {
        permissions.delete(permissionId);
        if (permissions.size === 0) {
          this.pendingPermissions.delete(sessionId);
        }
      }

      // Notify listeners that status may have changed
      this.notifyStatusChange();
    }
  }

  /**
   * Calculate the current status from effective counts.
   */
  private calculateStatus(): AgentStatus {
    const counts = this.getEffectiveCounts();
    if (counts.idle === 0 && counts.busy === 0) {
      return "none";
    }
    if (counts.busy > 0) {
      return "busy";
    }
    return "idle";
  }

  /**
   * Notify status change listeners with calculated status.
   */
  private notifyStatusChange(): void {
    const status = this.calculateStatus();
    for (const listener of this.statusChangeListeners) {
      listener(status);
    }
  }
}
