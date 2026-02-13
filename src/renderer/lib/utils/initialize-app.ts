/**
 * Initialize the application: signal ready, fetch agent statuses, set focus.
 *
 * Calls lifecycle.ready() which causes the main process to emit domain events
 * (project:opened, workspace:switched) for all current state. The renderer's
 * event bindings (set up before this function is called) populate the stores.
 *
 * @param options - Initialization options
 * @param apiImpl - API for data fetching (injectable for testing)
 * @returns Cleanup function (no-op for consistent composition pattern)
 */
import { tick } from "svelte";
import { projects, setLoaded, setError } from "$lib/stores/projects.svelte.js";
import { setAllStatuses } from "$lib/stores/agent-status.svelte.js";
import { setWorkspaceLoading } from "$lib/stores/workspace-loading.svelte.js";
import type { Project, WorkspaceStatus, AgentStatus } from "@shared/api/types";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

export interface InitializeAppOptions {
  /** Container element for focus management */
  containerRef: HTMLElement | undefined;
  /** Notification service to seed with initial agent counts */
  notificationService: AgentNotificationService;
}

export interface InitializeAppApi {
  lifecycle: { ready(): Promise<void> };
  workspaces: { getStatus(projectId: string, name: string): Promise<WorkspaceStatus> };
}

/**
 * Focus selector that includes VSCode Elements components.
 * VSCode Elements are custom elements that should be focusable.
 */
const FOCUSABLE_SELECTOR = [
  'vscode-button:not([disabled]):not([tabindex="-1"])',
  'vscode-textfield:not([disabled]):not([tabindex="-1"])',
  'vscode-checkbox:not([disabled]):not([tabindex="-1"])',
  'vscode-dropdown:not([disabled]):not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

async function fetchAllAgentStatuses(
  projectList: readonly Project[],
  apiImpl: InitializeAppApi
): Promise<Record<string, AgentStatus>> {
  const result: Record<string, AgentStatus> = {};
  const promises: Promise<void>[] = [];

  for (const project of projectList) {
    for (const workspace of project.workspaces) {
      promises.push(
        apiImpl.workspaces
          .getStatus(project.id, workspace.name)
          .then((status) => {
            result[workspace.path] = status.agent;
          })
          .catch(() => {
            // Individual workspace status fetch failures are non-critical
            // Continue with other workspaces
          })
      );
    }
  }
  await Promise.all(promises);
  return result;
}

// Default API implementation
const defaultApi: InitializeAppApi = {
  lifecycle: api.lifecycle,
  workspaces: api.workspaces,
};

/**
 * Initialize the application.
 *
 * Performs the following steps:
 * 1. Call lifecycle.ready() — main process emits domain events for current state
 * 2. Mark all workspaces as loading
 * 3. Focus first focusable element (including VSCode Elements)
 * 4. Fetch agent statuses for all workspaces
 * 5. Seed notification service with initial counts
 *
 * @param options - Initialization options
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function (no-op for consistent composition pattern)
 */
export async function initializeApp(
  options: InitializeAppOptions,
  apiImpl: InitializeAppApi = defaultApi
): Promise<() => void> {
  const { containerRef, notificationService } = options;

  try {
    // Signal ready — main process emits initial state events.
    // Events are processed synchronously via IPC before this resolves.
    await apiImpl.lifecycle.ready();

    // Mark all existing workspaces as loading (handles race with workspace:loading-changed)
    for (const project of projects.value) {
      for (const workspace of project.workspaces) {
        setWorkspaceLoading(workspace.path, true);
      }
    }

    setLoaded();

    // Focus first focusable element (including VSCode Elements)
    await tick();
    const firstFocusable = containerRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    // Fetch agent statuses using store data (populated by events above)
    try {
      const statuses = await fetchAllAgentStatuses(projects.value, apiImpl);
      setAllStatuses(statuses);

      // Seed notification service with initial counts for chime detection
      const initialCounts = Object.fromEntries(
        Object.entries(statuses).map(([path, status]) => [
          path,
          status.type === "none"
            ? { idle: 0, busy: 0 }
            : { idle: status.counts.idle, busy: status.counts.busy },
        ])
      );
      notificationService.seedInitialCounts(initialCounts);
    } catch {
      // Agent status is optional, don't fail initialization
    }
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : "Failed to load projects");
  }

  // Return no-op cleanup for consistent composition pattern
  return () => {};
}
