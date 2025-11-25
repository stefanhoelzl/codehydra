// src/lib/services/workspaceInit.ts

import { SvelteMap } from 'svelte/reactivity';
import type { AgentStatusCounts } from '$lib/types/agentStatus';

/**
 * Workspace initialization state.
 * - 'loading': fetching URL / starting code-server
 * - 'initializing': iframe mounted but hidden, waiting for agent or timeout
 * - 'ready': iframe visible to user
 * - 'error': failed to start code-server
 */
export type WorkspaceState = 'loading' | 'initializing' | 'ready' | 'error';

/** Initialization timeout in milliseconds */
export const INIT_TIMEOUT_MS = 5000;

/**
 * Workspace initialization service.
 * Manages the state machine for workspace initialization with timeout handling.
 */
export class WorkspaceInitService {
  /** Consolidated state map for all workspaces */
  readonly workspaceState = new SvelteMap<string, WorkspaceState>();

  /** Error messages for workspaces in error state */
  readonly workspaceErrors = new SvelteMap<string, string>();

  /** Timeout tracking (plain Map, not reactive) */
  private readonly initTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Check if any agents are present for a workspace.
   * Returns true if idle > 0 OR busy > 0.
   */
  checkAgentsPresent(counts: AgentStatusCounts | undefined): boolean {
    if (!counts) return false;
    return counts.idle > 0 || counts.busy > 0;
  }

  /**
   * Start initialization for a workspace.
   * Sets state to 'initializing' and starts timeout, or 'ready' if agents already present.
   *
   * @param workspacePath - The workspace path
   * @param agentCounts - Current agent counts for the workspace (if any)
   */
  startInitialization(workspacePath: string, agentCounts?: AgentStatusCounts): void {
    // Guard: don't re-initialize if already in map
    if (this.workspaceState.has(workspacePath)) {
      return;
    }

    // Check if agents are already present (race condition guard)
    if (this.checkAgentsPresent(agentCounts)) {
      this.workspaceState.set(workspacePath, 'ready');
      return;
    }

    // No agents yet - enter initializing state with timeout
    this.workspaceState.set(workspacePath, 'initializing');

    const timeout = setTimeout(() => {
      this.markWorkspaceReady(workspacePath);
    }, INIT_TIMEOUT_MS);

    this.initTimeouts.set(workspacePath, timeout);
  }

  /**
   * Mark a workspace as ready.
   * Only transitions from 'initializing' state and clears any pending timeout.
   */
  markWorkspaceReady(workspacePath: string): void {
    const currentState = this.workspaceState.get(workspacePath);
    if (currentState === 'initializing') {
      this.workspaceState.set(workspacePath, 'ready');
      this.clearInitTimeout(workspacePath);
    }
  }

  /**
   * Set workspace to loading state.
   */
  setLoading(workspacePath: string): void {
    this.workspaceState.set(workspacePath, 'loading');
    // Clear any previous error
    this.workspaceErrors.delete(workspacePath);
  }

  /**
   * Set workspace to error state with an error message.
   */
  setError(workspacePath: string, error: string): void {
    this.workspaceState.set(workspacePath, 'error');
    this.workspaceErrors.set(workspacePath, error);
    this.clearInitTimeout(workspacePath);
  }

  /**
   * Clear the initialization timeout for a workspace.
   */
  clearInitTimeout(workspacePath: string): void {
    const timeout = this.initTimeouts.get(workspacePath);
    if (timeout) {
      clearTimeout(timeout);
      this.initTimeouts.delete(workspacePath);
    }
  }

  /**
   * Check if a workspace has a pending initialization timeout.
   */
  hasInitTimeout(workspacePath: string): boolean {
    return this.initTimeouts.has(workspacePath);
  }

  /**
   * Clean up all state for a workspace (when removed).
   */
  cleanupWorkspace(workspacePath: string): void {
    this.clearInitTimeout(workspacePath);
    this.workspaceState.delete(workspacePath);
    this.workspaceErrors.delete(workspacePath);
  }

  /**
   * Clean up all pending timeouts (for component destruction).
   */
  cleanupAllTimeouts(): void {
    for (const timeout of this.initTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.initTimeouts.clear();
  }

  /**
   * Get the current state for a workspace.
   */
  getState(workspacePath: string): WorkspaceState | undefined {
    return this.workspaceState.get(workspacePath);
  }

  /**
   * Get the error message for a workspace (if in error state).
   */
  getError(workspacePath: string): string | undefined {
    return this.workspaceErrors.get(workspacePath);
  }

  /**
   * Check all initializing workspaces against agent counts and mark ready if agents detected.
   */
  checkAndUpdateFromAgentCounts(allCounts: Map<string, AgentStatusCounts>): void {
    for (const [path, state] of this.workspaceState) {
      if (state === 'initializing') {
        const counts = allCounts.get(path);
        if (this.checkAgentsPresent(counts)) {
          this.markWorkspaceReady(path);
        }
      }
    }
  }
}
