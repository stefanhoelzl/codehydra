/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode providers and aggregates session statuses.
 */

import type { WorkspacePath, AgentStatusCounts, AggregatedAgentStatus } from "../../shared/ipc";
import type { IDisposable, Unsubscribe, SessionStatus } from "./types";
import { OpenCodeClient, type PermissionEvent } from "./opencode-client";
import type { DiscoveryService } from "./discovery-service";

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (
  workspacePath: WorkspacePath,
  status: AggregatedAgentStatus
) => void;

/**
 * Per-workspace provider that manages OpenCode client connections.
 */
class OpenCodeProvider implements IDisposable {
  private readonly clients = new Map<number, OpenCodeClient>();
  private readonly sessionStatuses = new Map<string, SessionStatus>();
  private readonly listeners = new Set<(status: SessionStatus) => void>();
  /**
   * Pending permissions per session.
   * Map<sessionId, Set<permissionId>>
   * Sessions with pending permissions should display as idle (green indicator).
   */
  private readonly pendingPermissions = new Map<string, Set<string>>();
  /**
   * Callbacks to notify when permission state changes.
   */
  private readonly permissionChangeListeners = new Set<() => void>();

  /**
   * Sync clients with discovered ports.
   * Returns ports that were newly added (need initialization).
   */
  syncClients(ports: Set<number>): Set<number> {
    const newPorts = new Set<number>();

    // Remove clients for ports that no longer exist
    for (const [port, client] of this.clients) {
      if (!ports.has(port)) {
        client.dispose();
        this.clients.delete(port);
        // Clear pending permissions for this client's sessions when it disconnects
        // (SSE reconnection safety - permission state should be re-discovered)
        this.pendingPermissions.clear();
      }
    }

    // Add clients for new ports (don't connect yet - need to fetch root sessions first)
    for (const port of ports) {
      if (!this.clients.has(port)) {
        const client = new OpenCodeClient(port);
        client.onSessionEvent((event) => this.handleSessionEvent(event));
        client.onPermissionEvent((event) => this.handlePermissionEvent(event));
        this.clients.set(port, client);
        newPorts.add(port);
      }
    }

    return newPorts;
  }

  /**
   * Get current session statuses.
   */
  getSessionStatuses(): Map<string, SessionStatus> {
    return new Map(this.sessionStatuses);
  }

  /**
   * Check if provider has any connected clients.
   */
  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get adjusted session counts.
   * When connected (has clients) but no sessions, returns { idle: 1, busy: 0 }
   * This ensures the indicator shows green when OpenCode is running.
   * Sessions with pending permissions count as idle (waiting for user).
   */
  getAdjustedCounts(): { idle: number; busy: number } {
    let idle = 0;
    let busy = 0;

    for (const [sessionId, status] of this.sessionStatuses.entries()) {
      // Sessions with pending permissions count as idle (waiting for user)
      if (this.pendingPermissions.has(sessionId)) {
        idle++;
      } else if (status.type === "idle") {
        idle++;
      } else if (status.type === "busy") {
        busy++;
      }
    }

    // IMPORTANT: When connected but no sessions, show as "1 idle" (green indicator)
    if (this.clients.size > 0 && idle === 0 && busy === 0) {
      idle = 1;
    }

    return { idle, busy };
  }

  /**
   * Initialize new clients by fetching root sessions and connecting.
   * Must be called after syncClients for newly added ports.
   */
  async initializeNewClients(newPorts: Set<number>): Promise<void> {
    for (const port of newPorts) {
      const client = this.clients.get(port);
      if (client) {
        // Fetch root sessions first to identify which sessions to track
        await client.fetchRootSessions();
        // Then connect to SSE for real-time updates
        client.connect();
      }
    }
  }

  /**
   * Fetch initial session statuses from all clients.
   * Only returns statuses for root sessions (without parentID).
   */
  async fetchStatuses(): Promise<void> {
    for (const client of this.clients.values()) {
      const result = await client.getSessionStatuses();
      if (result.ok) {
        for (const status of result.value) {
          this.sessionStatuses.set(status.sessionId, status);
        }
      }
    }
  }

  /**
   * Subscribe to session events.
   */
  onSessionEvent(callback: (status: SessionStatus) => void): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.sessionStatuses.clear();
    this.listeners.clear();
    this.pendingPermissions.clear();
    this.permissionChangeListeners.clear();
  }

  private handleSessionEvent(event: SessionStatus): void {
    if (event.type === "deleted") {
      this.sessionStatuses.delete(event.sessionId);
      // Also clear pending permissions for deleted session
      this.pendingPermissions.delete(event.sessionId);
    } else {
      this.sessionStatuses.set(event.sessionId, event);
    }

    for (const listener of this.listeners) {
      listener(event);
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
      this.notifyPermissionChange();
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
      this.notifyPermissionChange();
    }
  }

  /**
   * Notify permission change listeners.
   */
  private notifyPermissionChange(): void {
    for (const listener of this.permissionChangeListeners) {
      listener();
    }
  }

  /**
   * Subscribe to permission state changes.
   */
  onPermissionChange(callback: () => void): Unsubscribe {
    this.permissionChangeListeners.add(callback);
    return () => this.permissionChangeListeners.delete(callback);
  }
}

/**
 * Agent Status Manager - aggregates status across all workspaces.
 */
export class AgentStatusManager implements IDisposable {
  private readonly providers = new Map<WorkspacePath, OpenCodeProvider>();
  private readonly statuses = new Map<WorkspacePath, AggregatedAgentStatus>();
  private readonly listeners = new Set<StatusChangedCallback>();
  private discoveryUnsubscribe: Unsubscribe | null = null;

  constructor(private readonly discoveryService: DiscoveryService) {
    // Subscribe to discovery service for port changes
    this.discoveryUnsubscribe = discoveryService.onInstancesChanged((workspace, ports) => {
      this.handleInstancesChanged(workspace as WorkspacePath, ports);
    });
  }

  /**
   * Initialize a workspace for agent tracking.
   */
  async initWorkspace(path: WorkspacePath): Promise<void> {
    if (this.providers.has(path)) {
      return;
    }

    const provider = new OpenCodeProvider();
    provider.onSessionEvent(() => this.updateStatus(path));
    // Subscribe to permission changes to update status when permission state changes
    provider.onPermissionChange(() => this.updateStatus(path));

    // Get current ports for this workspace
    const ports = this.discoveryService.getPortsForWorkspace(path);
    const newPorts = provider.syncClients(ports);

    // Initialize new clients (fetch root sessions + connect SSE)
    await provider.initializeNewClients(newPorts);

    // Fetch initial statuses (only root sessions)
    await provider.fetchStatuses();

    this.providers.set(path, provider);
    this.updateStatus(path);
  }

  /**
   * Remove a workspace from agent tracking.
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
    if (this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe();
      this.discoveryUnsubscribe = null;
    }

    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this.statuses.clear();
    this.listeners.clear();
  }

  private handleInstancesChanged(workspace: WorkspacePath, ports: Set<number>): void {
    const provider = this.providers.get(workspace);
    if (provider) {
      const newPorts = provider.syncClients(ports);
      // Initialize new clients (fetch root sessions + connect SSE), then fetch statuses
      void provider
        .initializeNewClients(newPorts)
        .then(() => provider.fetchStatuses())
        .then(() => this.updateStatus(workspace));
    }
  }

  private updateStatus(path: WorkspacePath): void {
    const provider = this.providers.get(path);
    if (!provider) {
      return;
    }

    // Use adjusted counts that account for "connected but no sessions"
    const counts = provider.getAdjustedCounts();
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

  private aggregateStatus(counts: AgentStatusCounts): AggregatedAgentStatus {
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
