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
  setProjectDefaultBaseBranch,
} from "$lib/stores/projects.svelte.js";
import { updateStatus } from "$lib/stores/agent-status.svelte.js";
import { closeNewWorkspaceView } from "$lib/stores/new-workspace-view.svelte.js";
import {
  createPendingPath,
  setCreating,
  findCreatingByName,
  clearLifecycle,
  getLifecycle,
} from "$lib/stores/workspace-lifecycle.svelte.js";
import { setupDomainEvents, type DomainEventApi } from "$lib/utils/domain-events";
import type { Workspace } from "@shared/api/types";
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
          const pendingPath = findCreatingByName(project.path, workspace.name);
          if (pendingPath) {
            removeWorkspace(project.path, pendingPath);
            clearLifecycle(pendingPath);
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
        if (currentPath && getLifecycle(currentPath) === "creating" && ref?.path !== currentPath) {
          clearLifecycle(currentPath);
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
      setProjectDefaultBaseBranch: (projectId, defaultBaseBranch) => {
        const project = projects.value.find((p) => p.id === projectId);
        if (project) {
          setProjectDefaultBaseBranch(project.path, defaultBaseBranch);
          logger.debug("Store updated", { store: "projects", key: "defaultBaseBranch" });
        }
      },
    },
    {
      // A workspace creation is starting: mirror what the old NewWorkspaceView
      // submit did — optimistic placeholder, lifecycle "creating", switch to
      // the (loading) placeholder, and leave the creation panel. Name-guarded:
      // workspace:loading also fires for wakes/reopens of existing workspaces
      // (and a duplicate event for an existing placeholder), which must not
      // create a duplicate sidebar entry.
      onWorkspaceLoadingHook: ({ workspaceName, projectPath, base }) => {
        const project = projects.value.find((p) => p.path === projectPath);
        if (!project) return;
        const nameLower = workspaceName.toLowerCase();
        if (project.workspaces.some((w) => w.name.toLowerCase() === nameLower)) return;
        const pendingPath = createPendingPath(projectPath, workspaceName);
        addWorkspace(projectPath, {
          projectId: project.id,
          name: workspaceName as Workspace["name"],
          branch: base ?? null,
          metadata: {},
          path: pendingPath,
        });
        setCreating(pendingPath, projectPath, workspaceName);
        // Landing in the (loading) placeholder is the visual confirmation the
        // workspace is being made.
        setActiveWorkspace(pendingPath);
        closeNewWorkspaceView();
      },
      // Creation failed: roll back the optimistic placeholder.
      onWorkspaceCreateFailedHook: ({ workspaceName, projectPath }) => {
        const pendingPath = findCreatingByName(projectPath, workspaceName);
        if (!pendingPath) return;
        clearLifecycle(pendingPath);
        removeWorkspace(projectPath, pendingPath);
        if (activeWorkspacePath.value === pendingPath) {
          setActiveWorkspace(null);
        }
      },
      // NOTE: no onProjectOpenedHook auto-open. All interactive project opens
      // now originate from the creation panel itself (folder-open / git-clone
      // side-flows, with the panel already visible); a background clone
      // completing must land silently — the project just appears in the
      // sidebar and seeds the panel's next reset (creation module).
    },
    { notificationService }
  );

  return cleanupDomainEvents;
}
