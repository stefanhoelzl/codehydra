/**
 * Domain event subscription helper.
 *
 * Extracts event subscriptions from MainView.svelte into a reusable helper.
 * This makes testing easier and centralizes the subscription logic.
 *
 * Uses the API types (ProjectId, WorkspaceRef) for type safety.
 */

import type { Unsubscribe } from "@shared/electron-api";
import type { ProjectId, WorkspaceName, WorkspaceRef, WorkspaceStatus } from "@shared/api/types";
import type { ApiEvents as IApiEvents } from "@shared/api/interfaces";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// =============================================================================
// API Event Types (WorkspaceRef-based)
// =============================================================================

/**
 * API event types - re-export from shared/api for convenience.
 * Uses the full ApiEvents interface which includes all domain events.
 */
export type ApiEvents = IApiEvents;

/**
 * API interface for event subscriptions.
 * Supports all events from the ApiEvents interface.
 */
export interface DomainEventApi {
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

/**
 * Store functions for handling domain events.
 * Uses API types (WorkspaceRef, ApiProject, etc.) instead of paths.
 */
export interface DomainStores {
  /** Add a project to the store (format with ID) */
  addProject: (project: Parameters<IApiEvents["project:opened"]>[0]["project"]) => void;
  /** Remove a project from the store by ID */
  removeProject: (projectId: Parameters<IApiEvents["project:closed"]>[0]["projectId"]) => void;
  /** Add a workspace to a project */
  addWorkspace: (
    projectId: Parameters<IApiEvents["workspace:created"]>[0]["projectId"],
    workspace: Parameters<IApiEvents["workspace:created"]>[0]["workspace"]
  ) => void;
  /** Remove a workspace by WorkspaceRef */
  removeWorkspace: (ref: WorkspaceRef) => void;
  /** Set active workspace by WorkspaceRef */
  setActiveWorkspace: (ref: WorkspaceRef | null) => void;
  /** Update agent status by WorkspaceRef */
  updateAgentStatus: (ref: WorkspaceRef, status: WorkspaceStatus) => void;
  /** Update a single metadata key on a workspace */
  updateWorkspaceMetadata: (
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    key: string,
    value: string | null
  ) => void;
}

/**
 * Options for setting up domain events.
 */
export interface DomainEventOptions {
  /** Optional notification service for DI (created automatically if not provided) */
  notificationService?: AgentNotificationService;
}

/**
 * Optional hooks for domain events.
 * These are called after the store update for additional side effects.
 */
export interface DomainEventHooks {
  /** Called after a project is added to the store */
  onProjectOpenedHook?: (project: Parameters<IApiEvents["project:opened"]>[0]["project"]) => void;
}

/**
 * Sets up API domain event subscriptions using WorkspaceRef-based events.
 *
 * This is the primary event setup function.
 * Uses the API `on()` method which subscribes to `api:*` prefixed channels.
 *
 * @param api - The API object with the `on()` method
 * @param stores - The store functions
 * @param hooks - Optional hooks for additional side effects
 * @param options - Optional configuration
 * @returns A cleanup function to unsubscribe from all events
 */
export function setupDomainEvents(
  api: DomainEventApi,
  stores: DomainStores,
  hooks?: DomainEventHooks,
  options?: DomainEventOptions
): () => void {
  const unsubscribes: (() => void)[] = [];

  // Create notification service if not provided
  const notificationService = options?.notificationService ?? new AgentNotificationService();

  // Project opened event
  unsubscribes.push(
    api.on("project:opened", (event) => {
      stores.addProject(event.project);
      hooks?.onProjectOpenedHook?.(event.project);
    })
  );

  // Project closed event
  unsubscribes.push(
    api.on("project:closed", (event) => {
      stores.removeProject(event.projectId);
    })
  );

  // Workspace created event
  unsubscribes.push(
    api.on("workspace:created", (event) => {
      stores.addWorkspace(event.projectId, event.workspace);
      // Switch to new workspace unless stealFocus is explicitly false
      if (event.stealFocus !== false) {
        stores.setActiveWorkspace({
          projectId: event.projectId,
          workspaceName: event.workspace.name,
          path: event.workspace.path,
        });
      }
    })
  );

  // Workspace removed event (uses WorkspaceRef)
  unsubscribes.push(
    api.on("workspace:removed", (event) => {
      stores.removeWorkspace(event);
      // Clean up notification service tracking
      notificationService.removeWorkspace(event.path);
    })
  );

  // Workspace switched event (uses WorkspaceRef | null)
  unsubscribes.push(
    api.on("workspace:switched", (event) => {
      stores.setActiveWorkspace(event);
    })
  );

  // Workspace status changed event (uses WorkspaceRef + WorkspaceStatus)
  unsubscribes.push(
    api.on("workspace:status-changed", (event) => {
      stores.updateAgentStatus(event, event.status);
      // Play chime when idle count increases (agent finished work)
      // Note: status uses AgentStatus type which has counts in the busy/idle/mixed variants
      if (event.status.agent.type !== "none" && "counts" in event.status.agent) {
        notificationService.handleStatusChange(event.path, event.status.agent.counts);
      }
    })
  );

  // Workspace metadata changed event
  unsubscribes.push(
    api.on("workspace:metadata-changed", (event) => {
      stores.updateWorkspaceMetadata(event.projectId, event.workspaceName, event.key, event.value);
    })
  );

  return () => {
    unsubscribes.forEach((unsub) => unsub());
  };
}
