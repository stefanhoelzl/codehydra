/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode clients per workspace with direct port assignment.
 *
 * Ports are provided by OpenCodeServerManager via callbacks routed through AppState.
 */

import type { WorkspacePath, InternalAgentCounts, AggregatedAgentStatus } from "../../shared/ipc";
import {
  type IDisposable,
  type Unsubscribe,
  type ClientStatus,
  type Result,
  type Session,
  err,
} from "./types";
import { OpenCodeClient, type PermissionEvent, type SdkClientFactory } from "./client";
import { OpenCodeError } from "../../services/errors";
import { findMatchingSession } from "./session-utils";
import type { Logger } from "../../services/logging";

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (
  workspacePath: WorkspacePath,
  status: AggregatedAgentStatus
) => void;

/**
 * Session info returned by getSession().
 */
export interface OpenCodeSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}

/**
 * Per-workspace provider that manages a single OpenCode client connection.
 * Each workspace has exactly one managed OpenCode server.
 *
 * Created by AppState and registered with AgentStatusManager via addProvider().
 */
export class OpenCodeProvider implements IDisposable {
  private client: OpenCodeClient | null = null;
  private clientStatus: ClientStatus = "idle";
  private readonly sdkFactory: SdkClientFactory | undefined;
  private readonly logger: Logger;
  private readonly workspacePath: string;

  /**
   * Port of the OpenCode server for this workspace.
   * Set during initializeClient(), preserved during restart.
   */
  private _port: number | null = null;

  /**
   * Primary session ID for this workspace.
   * Created or found during initializeClient(), preserved during restart.
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
  private readonly statusChangeListeners = new Set<() => void>();

  constructor(workspacePath: string, logger: Logger, sdkFactory: SdkClientFactory | undefined) {
    this.workspacePath = workspacePath;
    this.logger = logger;
    this.sdkFactory = sdkFactory;
  }

  /**
   * Returns the primary session info for this workspace.
   * Returns null if not initialized or if session creation failed.
   */
  getSession(): OpenCodeSessionInfo | null {
    if (this._port === null || this._primarySessionId === null) {
      return null;
    }
    return { port: this._port, sessionId: this._primarySessionId };
  }

  /**
   * Check if provider has a connected client.
   */
  hasClient(): boolean {
    return this.client !== null;
  }

  /**
   * Mark TUI as attached for this workspace.
   * Called when the first MCP request is received.
   */
  setTuiAttached(): void {
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
   * Initialize client with the given port.
   * Creates OpenCodeClient, finds or creates a session, and connects to SSE.
   * Handles connection failures gracefully - client will still be created
   * but may not receive real-time updates.
   */
  async initializeClient(port: number): Promise<void> {
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
   */
  onStatusChange(callback: () => void): Unsubscribe {
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
   * Notify status change listeners.
   */
  private notifyStatusChange(): void {
    for (const listener of this.statusChangeListeners) {
      listener();
    }
  }
}

/**
 * Agent Status Manager - aggregates status across all workspaces.
 * Receives port assignments from OpenCodeServerManager via AppState callbacks.
 */
export class AgentStatusManager implements IDisposable {
  private readonly providers = new Map<WorkspacePath, OpenCodeProvider>();
  private readonly statuses = new Map<WorkspacePath, AggregatedAgentStatus>();
  private readonly listeners = new Set<StatusChangedCallback>();
  private readonly sdkFactory: SdkClientFactory | undefined;
  private readonly logger: Logger;
  /**
   * Track workspaces that have had TUI attached.
   * Persists across provider recreations (e.g., server restart) so we can
   * restore the attached state without waiting for a new MCP request.
   */
  private readonly tuiAttachedWorkspaces = new Set<WorkspacePath>();

  constructor(logger: Logger, sdkFactory: SdkClientFactory | undefined = undefined) {
    this.logger = logger;
    this.sdkFactory = sdkFactory;
  }

  /**
   * Get the SDK factory for creating providers.
   * Used by AppState when creating OpenCodeProvider instances.
   */
  getSdkFactory(): SdkClientFactory | undefined {
    return this.sdkFactory;
  }

  /**
   * Get the logger for creating providers.
   * Used by AppState when creating OpenCodeProvider instances.
   */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Add an externally-created provider for a workspace.
   * Called by AppState after creating and initializing the provider.
   *
   * @param path - Workspace path
   * @param provider - Initialized OpenCodeProvider
   */
  addProvider(path: WorkspacePath, provider: OpenCodeProvider): void {
    if (this.providers.has(path)) {
      return;
    }

    // Subscribe to status changes (includes permission changes)
    provider.onStatusChange(() => this.updateStatus(path));

    // Restore TUI attached state if workspace had TUI attached before (e.g., after restart)
    if (this.tuiAttachedWorkspaces.has(path)) {
      provider.setTuiAttached();
    }

    this.providers.set(path, provider);
    this.updateStatus(path);
  }

  /**
   * Check if a provider exists for a workspace.
   * Used to detect restart vs first start.
   */
  hasProvider(path: WorkspacePath): boolean {
    return this.providers.has(path);
  }

  /**
   * Remove a workspace from agent tracking.
   * Called by AppState when OpenCodeServerManager reports server stopped.
   */
  removeWorkspace(path: WorkspacePath): void {
    const provider = this.providers.get(path);
    if (provider) {
      provider.dispose();
      this.providers.delete(path);
      this.statuses.delete(path);
      this.notifyListeners(path, this.createNoneStatus());
    }
  }

  /**
   * Mark TUI as attached for a workspace.
   * Called when the first MCP request is received.
   */
  setTuiAttached(path: WorkspacePath): void {
    // Track that this workspace has had TUI attached (persists across restarts)
    this.tuiAttachedWorkspaces.add(path);
    const provider = this.providers.get(path);
    if (provider) {
      provider.setTuiAttached();
    }
  }

  /**
   * Disconnect a workspace for server restart.
   * Keeps the provider and session ID, only disconnects the client.
   * Call reconnectWorkspace() after the server has restarted.
   */
  disconnectWorkspace(path: WorkspacePath): void {
    const provider = this.providers.get(path);
    if (provider) {
      provider.disconnect();
    }
  }

  /**
   * Reconnect a workspace after server restart.
   * Uses the preserved port and session ID from disconnect.
   */
  async reconnectWorkspace(path: WorkspacePath): Promise<void> {
    const provider = this.providers.get(path);
    if (provider) {
      await provider.reconnect();
      this.updateStatus(path);
    }
  }

  /**
   * Get the session info for a workspace.
   * Returns port and sessionId for the primary session.
   */
  getSession(path: WorkspacePath): OpenCodeSessionInfo | null {
    const provider = this.providers.get(path);
    return provider?.getSession() ?? null;
  }

  /**
   * Get status for a specific workspace.
   */
  getStatus(path: WorkspacePath): AggregatedAgentStatus {
    return this.statuses.get(path) ?? this.createNoneStatus();
  }

  /**
   * Get all statuses.
   */
  getAllStatuses(): Map<WorkspacePath, AggregatedAgentStatus> {
    return new Map(this.statuses);
  }

  /**
   * Subscribe to status changes.
   */
  onStatusChanged(callback: StatusChangedCallback): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Clear TUI tracking for a workspace (for permanent deletion).
   * This removes the workspace from the persistent tuiAttachedWorkspaces set,
   * so if the workspace is recreated, it won't have TUI attached state restored.
   *
   * Note: This is separate from removeWorkspace which is also called during restart.
   * During restart, we want to preserve the tuiAttachedWorkspaces tracking.
   */
  clearTuiTracking(path: WorkspacePath): void {
    this.tuiAttachedWorkspaces.delete(path);
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this.statuses.clear();
    this.listeners.clear();
    this.tuiAttachedWorkspaces.clear();
  }

  private updateStatus(path: WorkspacePath): void {
    const provider = this.providers.get(path);
    if (!provider) return;

    // Use effective counts that account for permissions and port status
    const counts = provider.getEffectiveCounts();
    const status = this.aggregateStatus(counts);

    const previousStatus = this.statuses.get(path);
    const hasChanged =
      !previousStatus ||
      previousStatus.status !== status.status ||
      previousStatus.counts.idle !== status.counts.idle ||
      previousStatus.counts.busy !== status.counts.busy;

    if (hasChanged) {
      this.statuses.set(path, status);
      this.notifyListeners(path, status);
    }
  }

  private aggregateStatus(counts: InternalAgentCounts): AggregatedAgentStatus {
    const { idle, busy } = counts;

    if (idle === 0 && busy === 0) {
      return { status: "none", counts };
    } else if (busy === 0) {
      return { status: "idle", counts };
    } else if (idle === 0) {
      return { status: "busy", counts };
    } else {
      return { status: "mixed", counts };
    }
  }

  private createNoneStatus(): AggregatedAgentStatus {
    return { status: "none", counts: { idle: 0, busy: 0 } };
  }

  private notifyListeners(path: WorkspacePath, status: AggregatedAgentStatus): void {
    for (const listener of this.listeners) {
      listener(path, status);
    }
  }
}
