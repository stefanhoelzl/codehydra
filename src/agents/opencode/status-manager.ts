/**
 * Agent Status Manager - owns status aggregation and workspace lifecycle.
 * Manages OpenCode clients per workspace with direct port assignment.
 *
 * Ports are provided by OpenCodeServerManager via callbacks routed through AppState.
 */

import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { IDisposable, Unsubscribe } from "./types";
import type { SdkClientFactory } from "./client";
import type { Logger } from "../../services/logging";
import { OpenCodeProvider } from "./provider";
import type { AgentSessionInfo, AgentStatus } from "../types";

// Re-export OpenCodeProvider for backward compatibility
export { OpenCodeProvider } from "./provider";

// Re-export AgentSessionInfo as OpenCodeSessionInfo for backward compatibility
export type OpenCodeSessionInfo = AgentSessionInfo;

/**
 * Callback for status changes.
 */
export type StatusChangedCallback = (
  workspacePath: WorkspacePath,
  status: AggregatedAgentStatus
) => void;

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

    // Subscribe to status changes - callback receives computed status directly
    provider.onStatusChange((status) => this.handleStatusUpdate(path, status));

    // Restore TUI attached state if workspace had TUI attached before (e.g., after restart)
    if (this.tuiAttachedWorkspaces.has(path)) {
      provider.markActive();
    }

    this.providers.set(path, provider);
    // Trigger initial status update
    this.handleStatusUpdate(path, this.getProviderStatus(provider));
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
   * Mark agent as active for a workspace.
   * Called when the first MCP request is received.
   */
  markActive(path: WorkspacePath): void {
    // Track that this workspace has had TUI attached (persists across restarts)
    this.tuiAttachedWorkspaces.add(path);
    const provider = this.providers.get(path);
    if (provider) {
      provider.markActive();
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
      // Trigger status update after reconnection
      this.handleStatusUpdate(path, this.getProviderStatus(provider));
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

  /**
   * Get current status from a provider by calling its internal calculation.
   * Used for initial status fetch and reconnection.
   */
  private getProviderStatus(provider: OpenCodeProvider): AgentStatus {
    // Provider's getEffectiveCounts is still available for this calculation
    const counts = provider.getEffectiveCounts();
    if (counts.idle === 0 && counts.busy === 0) {
      return "none";
    }
    if (counts.busy > 0) {
      return "busy";
    }
    return "idle";
  }

  /**
   * Handle status update from a provider.
   * Converts simple status to AggregatedAgentStatus for backward compatibility.
   */
  private handleStatusUpdate(path: WorkspacePath, agentStatus: AgentStatus): void {
    // Convert simple status to AggregatedAgentStatus
    const status = this.convertToAggregatedStatus(agentStatus);

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

  /**
   * Convert simple AgentStatus to AggregatedAgentStatus.
   * Single workspace = counts are always 0/1.
   */
  private convertToAggregatedStatus(status: AgentStatus): AggregatedAgentStatus {
    switch (status) {
      case "none":
        return { status: "none", counts: { idle: 0, busy: 0 } };
      case "idle":
        return { status: "idle", counts: { idle: 1, busy: 0 } };
      case "busy":
        return { status: "busy", counts: { idle: 0, busy: 1 } };
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
