/**
 * Setup function for domain event subscriptions with store bindings.
 * Thin wrapper around setupDomainEvents that wires events to stores.
 *
 * @param notificationService - Service for agent completion chimes
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe from all events
 */
import {
  projects,
  activeWorkspacePath,
  addProject,
  removeProject,
  setActiveWorkspace,
  addWorkspace,
  removeWorkspace,
  updateWorkspaceMetadata,
} from "$lib/stores/projects.svelte.js";
import { bootstrap } from "$lib/stores/bootstrap.svelte.js";
import { updateStatus } from "$lib/stores/agent-status.svelte.js";
import { dialogState } from "$lib/stores/dialogs.svelte.js";
import { newWorkspaceView, openNewWorkspaceView } from "$lib/stores/new-workspace-view.svelte.js";
import { hasSpinnerNotifications } from "$lib/stores/notification-store.svelte.js";
import {
  findPendingByName,
  removePending,
  isPending,
} from "$lib/stores/pending-workspaces.svelte.js";
import { setupDomainEvents, type DomainEventApi } from "$lib/utils/domain-events";
import { createLogger } from "$lib/logging";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

const logger = createLogger("ui");

// Default API implementation - cast to DomainEventApi for type-safe event subscriptions.
// We use a direct cast here instead of the lazy-loading pattern (getDefaultApi) because:
// 1. This module doesn't have circular dependency issues with $lib/api
// 2. Simpler code - no need for lazy initialization or require()
// 3. The api module is always loaded before this setup function is called
const defaultApi: DomainEventApi = api as DomainEventApi;

/**
 * Setup domain event subscriptions with store bindings.
 *
 * Wires the following events to stores:
 * - project:opened → addProject
 * - project:closed → removeProject
 * - workspace:created → addWorkspace, setActiveWorkspace
 * - workspace:removed → removeWorkspace
 * - workspace:switched → setActiveWorkspace
 * - workspace:status-changed → updateAgentStatus
 *
 * @param notificationService - Service for agent completion chimes
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function to unsubscribe from all events
 */
export function setupDomainEventBindings(
  notificationService: AgentNotificationService,
  apiImpl: DomainEventApi = defaultApi
): () => void {
  // Setup domain events
  const cleanupDomainEvents = setupDomainEvents(
    apiImpl,
    {
      addProject: (project) => {
        addProject(project);
        logger.debug("Store updated", { store: "projects" });
      },
      removeProject: (projectId) => {
        const project = projects.value.find((p) => p.id === projectId);
        if (project) {
          removeProject(project.path);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      addWorkspace: (projectId, workspace) => {
        const project = projects.value.find((p) => p.id === projectId);
        if (project) {
          // Replace pending placeholder if one exists for this workspace
          const pendingPath = findPendingByName(project.path, workspace.name);
          if (pendingPath) {
            removeWorkspace(project.path, pendingPath);
            removePending(pendingPath);
          }
          addWorkspace(project.path, workspace);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      removeWorkspace: (ref) => {
        const project = projects.value.find((p) => p.id === ref.projectId);
        if (project) {
          removeWorkspace(project.path, ref.path);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      setActiveWorkspace: (ref) => {
        // Clean up pending placeholder if switching away from it
        const currentPath = activeWorkspacePath.value;
        if (currentPath && isPending(currentPath) && ref?.path !== currentPath) {
          removePending(currentPath);
          // Find and remove the placeholder from the project
          for (const project of projects.value) {
            if (project.workspaces.some((w) => w.path === currentPath)) {
              removeWorkspace(project.path, currentPath);
              break;
            }
          }
        }
        setActiveWorkspace(ref?.path ?? null);
        logger.debug("Store updated", { store: "projects" });
      },
      updateAgentStatus: (ref, status) => {
        updateStatus(ref.path, status.agent);
        logger.debug("Store updated", { store: "agent-status" });
      },
      updateWorkspaceMetadata: (projectId, workspaceName, key, value) => {
        const matched = updateWorkspaceMetadata(projectId, workspaceName, key, value);
        if (!matched) {
          logger.warn("Metadata update did not match any workspace", {
            projectId,
            workspaceName,
            key,
          });
          return;
        }
        logger.debug("Store updated", { store: "projects", key });
      },
    },
    {
      onProjectOpenedHook: (project) => {
        // Only auto-open during normal operation, not during initial startup loading.
        // The auto-open $effect in MainView.svelte handles the post-load empty case.
        // Skip when a background clone just completed — the project appears silently.
        if (
          bootstrap.initialized &&
          project.workspaces.length === 0 &&
          dialogState.value.type === "closed" &&
          !newWorkspaceView.isOpen &&
          !hasSpinnerNotifications.value
        ) {
          // Open the New workspace view with the freshly opened project selected.
          openNewWorkspaceView(project.id);
        }
      },
    },
    { notificationService }
  );

  return cleanupDomainEvents;
}
