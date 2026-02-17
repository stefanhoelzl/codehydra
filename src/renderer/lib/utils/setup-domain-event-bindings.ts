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
  loadingState,
  addProject,
  removeProject,
  setActiveWorkspace,
  addWorkspace,
  removeWorkspace,
} from "$lib/stores/projects.svelte.js";
import { updateStatus } from "$lib/stores/agent-status.svelte.js";
import { setWorkspaceLoading } from "$lib/stores/workspace-loading.svelte.js";
import { dialogState, openCreateDialog } from "$lib/stores/dialogs.svelte.js";
import { setupDomainEvents, type DomainEventApi } from "$lib/utils/domain-events";
import { createLogger } from "$lib/logging";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";
import type { WorkspaceLoadingChangedPayload } from "@shared/ipc";

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
  // Subscribe to workspace loading state changes
  const unsubLoading = api.on<WorkspaceLoadingChangedPayload>(
    "workspace:loading-changed",
    (payload) => {
      setWorkspaceLoading(payload.path, payload.loading);
      logger.debug("Store updated", {
        store: "workspace-loading",
        path: payload.path,
        loading: payload.loading,
      });
    }
  );

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
          addWorkspace(project.path, workspace);
          // Mark newly created workspaces as loading immediately.
          // This prevents a race condition where workspace:loading-changed event
          // might arrive after workspace:created, causing the overlay to not show.
          // The subsequent loading-changed(true) event will be a no-op.
          // loading-changed(false) will clear the state when the workspace is ready.
          setWorkspaceLoading(workspace.path, true);
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
        setActiveWorkspace(ref?.path ?? null);
        logger.debug("Store updated", { store: "projects" });
      },
      updateAgentStatus: (ref, status) => {
        updateStatus(ref.path, status.agent);
        logger.debug("Store updated", { store: "agent-status" });
      },
    },
    {
      onProjectOpenedHook: (project) => {
        // Only auto-open during normal operation, not during initial startup loading.
        // The auto-show $effect in MainView.svelte handles the post-load case.
        if (
          loadingState.value === "loaded" &&
          project.workspaces.length === 0 &&
          dialogState.value.type === "closed"
        ) {
          openCreateDialog(project.id);
        }
      },
    },
    { notificationService }
  );

  // Return combined cleanup function
  return () => {
    unsubLoading();
    cleanupDomainEvents();
  };
}
