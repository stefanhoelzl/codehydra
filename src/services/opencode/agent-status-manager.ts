/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode clients per workspace with direct port assignment.
 *
 * Ports are provided by OpenCodeServerManager via callbacks routed through AppState.
 */

import type { WorkspacePath, InternalAgentCounts, AggregatedAgentStatus } from "../../shared/ipc";
import type { IDisposable, Unsubscribe, ClientStatus } from "./types";
import { OpenCodeClient, type PermissionEvent, type SdkClientFactory } from "./opencode-client";
import type { Logger } from "../logging";

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (
  workspacePath: WorkspacePath,
  status: AggregatedAgentStatus
) => void;

/**
 * Per-workspace provider that manages a single OpenCode client connection.
 * Each workspace has exactly one managed OpenCode server.
 */
class OpenCodeProvider implements IDisposable {
  private client: OpenCodeClient | null = null;
  private clientStatus: ClientStatus = "idle";
  private readonly sdkFactory: SdkClientFactory | undefined;
  private readonly logger: Logger;

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

  constructor(logger: Logger, sdkFactory: SdkClientFactory | undefined) {
    this.logger = logger;
    this.sdkFactory = sdkFactory;
  }

  /**
   * Check if provider has a connected client.
   */
  hasClient(): boolean {
    return this.client !== null;
  }

  /**
   * Get effective counts accounting for permission state.
   * Ports with pending permissions count as idle (waiting for user).
   */
  getEffectiveCounts(): { idle: number; busy: number } {
    if (!this.client) {
      return { idle: 0, busy: 0 };
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
   * Creates OpenCodeClient, fetches root sessions, and connects to SSE.
   * Handles connection failures gracefully - client will still be created
   * but may not receive real-time updates.
   */
  async initializeClient(port: number): Promise<void> {
    if (this.client) {
      // Already initialized
      return;
    }

    const client = new OpenCodeClient(port, this.logger, this.sdkFactory);

    // Subscribe to status changes from client
    client.onStatusChanged((status) => this.handleStatusChanged(status));
    // Subscribe to session events for permission correlation
    client.onSessionEvent((event) => this.handleSessionEvent(port, event));
    // Subscribe to permission events
    client.onPermissionEvent((event) => this.handlePermissionEvent(event));

    this.client = client;

    try {
      // Fetch root sessions first to identify which sessions to track
      await client.fetchRootSessions();
      // Then connect to SSE for real-time updates
      await client.connect();
    } catch {
      // Connection failed - client is still created but may not have real-time updates
      // This can happen if the server is not ready yet or network issues
      // The client can retry later or will receive updates when connection is established
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

  dispose(): void {
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    this.clientStatus = "idle";
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
   */
  private handleSessionEvent(port: number, event: { type: string; sessionId: string }): void {
    if (event.type === "deleted") {
      this.sessionToPort.delete(event.sessionId);
      this.pendingPermissions.delete(event.sessionId);
    } else {
      // Map session to port for permission correlation
      this.sessionToPort.set(event.sessionId, port);
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

  constructor(logger: Logger, sdkFactory: SdkClientFactory | undefined = undefined) {
    this.logger = logger;
    this.sdkFactory = sdkFactory;
  }

  /**
   * Initialize a workspace for agent tracking with the given port.
   * Called by AppState when OpenCodeServerManager reports server started.
   */
  async initWorkspace(path: WorkspacePath, port: number): Promise<void> {
    if (this.providers.has(path)) {
      return;
    }

    const provider = new OpenCodeProvider(this.logger, this.sdkFactory);
    // Subscribe to status changes (includes permission changes)
    provider.onStatusChange(() => this.updateStatus(path));

    // Initialize client with the provided port
    await provider.initializeClient(port);

    // Fetch initial status from the client
    await provider.fetchStatus();

    this.providers.set(path, provider);
    this.updateStatus(path);
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

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this.statuses.clear();
    this.listeners.clear();
  }

  private updateStatus(path: WorkspacePath): void {
    const provider = this.providers.get(path);
    if (!provider) {
      return;
    }

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
