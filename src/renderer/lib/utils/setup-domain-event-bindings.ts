/**
 * Setup function for domain event subscriptions with store bindings.
 * Subscribes to the API domain events and wires them to the renderer stores.
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
import type { Unsubscribe } from "@shared/electron-api";
import type { ApiEvents } from "@shared/api/interfaces";
import type { Workspace, WorkspaceRef } from "@shared/api/types";
import { createLogger } from "$lib/logging";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

const logger = createLogger("ui");

/**
 * API interface for event subscriptions.
 * Supports all events from the ApiEvents interface.
 */
export interface DomainEventApi {
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

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
  const unsubscribes: (() => void)[] = [];

  // Set active workspace by WorkspaceRef, cleaning up a pending placeholder
  // when switching away from it. Shared by workspace:created and
  // workspace:switched.
  const applyActiveWorkspace = (ref: WorkspaceRef | null): void => {
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
  };

  // Project opened event.
  // NOTE: no auto-open on project:opened. All interactive project opens
  // now originate from the creation panel itself (folder-open / git-clone
  // side-flows, with the panel already visible); a background clone
  // completing must land silently — the project just appears in the
  // sidebar and seeds the panel's next reset (creation module).
  unsubscribes.push(
    apiImpl.on("project:opened", (event) => {
      addProject(event.project);
      logger.debug("Store updated", { store: "projects" });
    })
  );

  // Project closed event
  unsubscribes.push(
    apiImpl.on("project:closed", (event) => {
      const project = projects.value.find((p) => p.id === event.projectId);
      if (project) {
        removeProject(project.path);
        logger.debug("Store updated", { store: "projects" });
      }
    })
  );

  // Workspace created event
  unsubscribes.push(
    apiImpl.on("workspace:created", (event) => {
      const project = projects.value.find((p) => p.id === event.projectId);
      if (project) {
        // Replace pending placeholder if one exists for this workspace
        const pendingPath = findCreatingByName(project.path, event.workspace.name);
        if (pendingPath) {
          removeWorkspace(project.path, pendingPath);
          clearLifecycle(pendingPath);
        }
        addWorkspace(project.path, event.workspace);
        logger.debug("Store updated", { store: "projects" });
      }
      // Switch to new workspace unless stealFocus is explicitly false
      if (event.stealFocus !== false) {
        applyActiveWorkspace({
          projectId: event.projectId,
          workspaceName: event.workspace.name,
          path: event.workspace.path,
        });
      }
    })
  );

  // Workspace removed event (uses WorkspaceRef)
  unsubscribes.push(
    apiImpl.on("workspace:removed", (event) => {
      const project = projects.value.find((p) => p.id === event.projectId);
      if (project) {
        removeWorkspace(project.path, event.path);
        logger.debug("Store updated", { store: "projects" });
      }
      // Clean up notification service tracking
      notificationService.removeWorkspace(event.path);
    })
  );

  // Workspace switched event (uses WorkspaceRef | null)
  unsubscribes.push(
    apiImpl.on("workspace:switched", (event) => {
      applyActiveWorkspace(event);
    })
  );

  // Workspace status changed event (uses WorkspaceRef + WorkspaceStatus)
  unsubscribes.push(
    apiImpl.on("workspace:status-changed", (event) => {
      updateStatus(event.path, event.status.agent);
      logger.debug("Store updated", { store: "agent-status" });
      // Play chime when idle count increases (agent finished work).
      // Treat "none" (agent gone — e.g. agent terminal closed) as zero idle so a
      // later gray → green transition (reopening the terminal) registers as an
      // idle increase and chimes. The "none" variant carries no counts.
      const counts =
        "counts" in event.status.agent ? event.status.agent.counts : { idle: 0, busy: 0 };
      notificationService.handleStatusChange(event.path, counts);
    })
  );

  // Workspace metadata changed event
  unsubscribes.push(
    apiImpl.on("workspace:metadata-changed", (event) => {
      const matched = updateWorkspaceMetadata(
        event.projectId,
        event.workspaceName,
        event.key,
        event.value
      );
      if (!matched) {
        logger.warn("Metadata update did not match any workspace", {
          projectId: event.projectId,
          workspaceName: event.workspaceName,
          key: event.key,
        });
        return;
      }
      logger.debug("Store updated", { store: "projects", key: event.key });
    })
  );

  // Project bases updated — refresh the project's default base branch so a
  // default that went stale during the session heals (absent = no default found).
  unsubscribes.push(
    apiImpl.on("project:bases-updated", (event) => {
      const project = projects.value.find((p) => p.id === event.projectId);
      if (project) {
        setProjectDefaultBaseBranch(project.path, event.defaultBaseBranch);
        logger.debug("Store updated", { store: "projects", key: "defaultBaseBranch" });
      }
    })
  );

  // Workspace loading event — a creation (or wake) is about to start slow
  // work. Mirror what the old NewWorkspaceView submit did — optimistic
  // placeholder, lifecycle "creating", switch to the (loading) placeholder,
  // and leave the creation panel. Name-guarded: workspace:loading also fires
  // for wakes/reopens of existing workspaces (and a duplicate event for an
  // existing placeholder), which must not create a duplicate sidebar entry.
  unsubscribes.push(
    apiImpl.on("workspace:loading", ({ workspaceName, projectPath, base }) => {
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
    })
  );

  // Workspace create-failed event — roll back the optimistic placeholder
  // created by the workspace:loading handler.
  unsubscribes.push(
    apiImpl.on("workspace:create-failed", ({ workspaceName, projectPath }) => {
      const pendingPath = findCreatingByName(projectPath, workspaceName);
      if (!pendingPath) return;
      clearLifecycle(pendingPath);
      removeWorkspace(projectPath, pendingPath);
      if (activeWorkspacePath.value === pendingPath) {
        setActiveWorkspace(null);
      }
    })
  );

  return () => {
    unsubscribes.forEach((unsub) => unsub());
  };
}
