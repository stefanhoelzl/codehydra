/**
 * Initialize the application: load projects, agent statuses, set focus, auto-open picker.
 *
 * This is an async setup function that returns a cleanup callback for consistent
 * composition, even though the cleanup is a no-op (initialization is one-time).
 *
 * @param options - Initialization options
 * @param apiImpl - API for data fetching (injectable for testing)
 * @returns Cleanup function (no-op for consistent composition pattern)
 */
import { tick } from "svelte";
import {
  setProjects,
  setActiveWorkspace,
  setLoaded,
  setError,
} from "$lib/stores/projects.svelte.js";
import { setAllStatuses } from "$lib/stores/agent-status.svelte.js";
import type { Project, WorkspaceStatus, AgentStatus } from "@shared/api/types";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

export interface InitializeAppOptions {
  /** Container element for focus management */
  containerRef: HTMLElement | undefined;
  /** Notification service to seed with initial agent counts */
  notificationService: AgentNotificationService;
  /** Callback when no projects exist (first launch experience) */
  onAutoOpenProject?: () => Promise<void>;
}

export interface InitializeAppApi {
  projects: { list(): Promise<readonly Project[]> };
  workspaces: { getStatus(projectId: string, name: string): Promise<WorkspaceStatus> };
  ui: { getActiveWorkspace(): Promise<{ path: string } | null> };
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
  projects: api.projects,
  workspaces: api.workspaces,
  ui: api.ui,
};

/**
 * Initialize the application.
 *
 * Performs the following steps:
 * 1. Load projects from API
 * 2. Get initial active workspace
 * 3. Focus first focusable element (including VSCode Elements)
 * 4. Fetch agent statuses for all workspaces
 * 5. Seed notification service with initial counts
 * 6. Auto-open project picker if no projects exist
 *
 * @param options - Initialization options
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function (no-op for consistent composition pattern)
 */
export async function initializeApp(
  options: InitializeAppOptions,
  apiImpl: InitializeAppApi = defaultApi
): Promise<() => void> {
  const { containerRef, notificationService, onAutoOpenProject } = options;

  try {
    // Load projects
    const projectList = await apiImpl.projects.list();
    setProjects([...projectList]);

    // Get initial active workspace (always set, even if null)
    const activeRef = await apiImpl.ui.getActiveWorkspace();
    setActiveWorkspace(activeRef?.path ?? null);
    setLoaded();

    // Focus first focusable element (including VSCode Elements)
    await tick();
    const firstFocusable = containerRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    // Fetch agent statuses (optional, don't fail on error)
    try {
      const statuses = await fetchAllAgentStatuses(projectList, apiImpl);
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

    // Auto-open project picker on first launch (no projects)
    if (projectList.length === 0 && onAutoOpenProject) {
      await onAutoOpenProject();
    }
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : "Failed to load projects");
  }

  // Return no-op cleanup for consistent composition pattern
  return () => {};
}
