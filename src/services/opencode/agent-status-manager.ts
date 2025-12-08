/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode providers and aggregates session statuses.
 */

import type { WorkspacePath, AgentStatusCounts, AggregatedAgentStatus } from "../../shared/ipc";
import type { IDisposable, Unsubscribe, SessionStatus } from "./types";
import { OpenCodeClient } from "./opencode-client";
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
   * Sync clients with discovered ports.
   */
  syncClients(ports: Set<number>): void {
    // Remove clients for ports that no longer exist
    for (const [port, client] of this.clients) {
      if (!ports.has(port)) {
        client.dispose();
        this.clients.delete(port);
      }
    }

    // Add clients for new ports
    for (const port of ports) {
      if (!this.clients.has(port)) {
        const client = new OpenCodeClient(port);
        client.onSessionEvent((event) => this.handleSessionEvent(event));
        client.connect();
        this.clients.set(port, client);
      }
    }
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
   */
  getAdjustedCounts(): { idle: number; busy: number } {
    let idle = 0;
    let busy = 0;

    for (const status of this.sessionStatuses.values()) {
      if (status.type === "idle") idle++;
      else if (status.type === "busy") busy++;
    }

    // IMPORTANT: When connected but no sessions, show as "1 idle" (green indicator)
    if (this.clients.size > 0 && idle === 0 && busy === 0) {
      idle = 1;
    }

    return { idle, busy };
  }

  /**
   * Fetch initial session statuses from all clients.
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
  }

  private handleSessionEvent(event: SessionStatus): void {
    if (event.type === "deleted") {
      this.sessionStatuses.delete(event.sessionId);
    } else {
      this.sessionStatuses.set(event.sessionId, event);
    }

    for (const listener of this.listeners) {
      listener(event);
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
    provider.onSessionEvent(() => this.updateStatus(path));

    // Get current ports for this workspace
    const ports = this.discoveryService.getPortsForWorkspace(path);
    provider.syncClients(ports);

    // Fetch initial statuses
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
      provider.syncClients(ports);
      // Fetch statuses from new/updated clients, then update
      void provider.fetchStatuses().then(() => this.updateStatus(workspace));
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
