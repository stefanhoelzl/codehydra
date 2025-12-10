/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode providers and aggregates port-based statuses.
 */

import type { WorkspacePath, AgentStatusCounts, AggregatedAgentStatus } from "../../shared/ipc";
import type { IDisposable, Unsubscribe, ClientStatus } from "./types";
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
 * Uses port-based status tracking (1 agent per port).
 */
class OpenCodeProvider implements IDisposable {
  private readonly clients = new Map<number, OpenCodeClient>();
  /**
   * Port-based status tracking.
   * Map<port, ClientStatus>
   */
  private readonly clientStatuses = new Map<number, ClientStatus>();
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
        this.clientStatuses.delete(port);
        // Clear session mappings and permissions for sessions on this port
        for (const [sessionId, sessionPort] of this.sessionToPort) {
          if (sessionPort === port) {
            this.sessionToPort.delete(sessionId);
            this.pendingPermissions.delete(sessionId);
          }
        }
      }
    }

    // Add clients for new ports (don't connect yet - need to fetch root sessions first)
    for (const port of ports) {
      if (!this.clients.has(port)) {
        const client = new OpenCodeClient(port);
        // Subscribe to status changes from client
        client.onStatusChanged((status) => this.handleStatusChanged(port, status));
        // Subscribe to session events for permission correlation
        client.onSessionEvent((event) => this.handleSessionEvent(port, event));
        // Subscribe to permission events
        client.onPermissionEvent((event) => this.handlePermissionEvent(event));
        this.clients.set(port, client);
        newPorts.add(port);
      }
    }

    return newPorts;
  }

  /**
   * Check if provider has any connected clients.
   */
  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get effective counts accounting for permission state.
   * Ports with pending permissions count as idle (waiting for user).
   */
  getEffectiveCounts(): { idle: number; busy: number } {
    let idle = 0;
    let busy = 0;

    for (const [port, status] of this.clientStatuses.entries()) {
      // Check if any session on this port has pending permission
      const hasPermissionPending = [...this.sessionToPort.entries()]
        .filter(([, p]) => p === port)
        .some(([sessionId]) => this.pendingPermissions.has(sessionId));

      if (hasPermissionPending) {
        idle++;
      } else if (status === "idle") {
        idle++;
      } else {
        busy++;
      }
    }

    // IMPORTANT: When connected but no client statuses yet, show as "1 idle" (green indicator)
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
   * Fetch initial status from all clients.
   * Uses the new getStatus() API that returns aggregated ClientStatus.
   */
  async fetchStatuses(): Promise<void> {
    for (const [port, client] of this.clients.entries()) {
      const result = await client.getStatus();
      if (result.ok) {
        this.clientStatuses.set(port, result.value);
      }
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
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.clientStatuses.clear();
    this.sessionToPort.clear();
    this.pendingPermissions.clear();
    this.statusChangeListeners.clear();
  }

  /**
   * Handle status change from a client.
   */
  private handleStatusChanged(port: number, status: ClientStatus): void {
    this.clientStatuses.set(port, status);
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
    // Subscribe to status changes (includes permission changes)
    provider.onStatusChange(() => this.updateStatus(path));

    // Get current ports for this workspace
    const ports = this.discoveryService.getPortsForWorkspace(path);
    const newPorts = provider.syncClients(ports);

    // Initialize new clients (fetch root sessions + connect SSE)
    await provider.initializeNewClients(newPorts);

    // Fetch initial statuses from all clients
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
