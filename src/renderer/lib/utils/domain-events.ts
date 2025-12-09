/**
 * Domain event subscription helper.
 *
 * Extracts event subscriptions from MainView.svelte into a reusable helper.
 * This makes testing easier and centralizes the subscription logic.
 */

import type {
  Project,
  ProjectPath,
  Workspace,
  AggregatedAgentStatus,
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceCreatedEvent,
  WorkspaceRemovedEvent,
  WorkspaceSwitchedEvent,
  AgentStatusChangedEvent,
} from "@shared/ipc";
import type { Unsubscribe } from "@shared/electron-api";

/**
 * Function type for unsubscribing from events.
 */
type CleanupFunction = () => void;

/**
 * API functions needed for domain event subscriptions.
 */
export interface DomainEventApi {
  onProjectOpened: (callback: (event: ProjectOpenedEvent) => void) => Unsubscribe;
  onProjectClosed: (callback: (event: ProjectClosedEvent) => void) => Unsubscribe;
  onWorkspaceCreated: (callback: (event: WorkspaceCreatedEvent) => void) => Unsubscribe;
  onWorkspaceRemoved: (callback: (event: WorkspaceRemovedEvent) => void) => Unsubscribe;
  onWorkspaceSwitched: (callback: (event: WorkspaceSwitchedEvent) => void) => Unsubscribe;
  onAgentStatusChanged: (callback: (event: AgentStatusChangedEvent) => void) => Unsubscribe;
}

/**
 * Store functions for handling domain events.
 *
 * Note: Uses branded types where the store functions use them (ProjectPath),
 * and plain strings where stores use strings. The event payloads have branded
 * types which are compatible with plain strings (branded types are subtypes).
 */
export interface DomainStores {
  /** Add a project to the store */
  addProject: (project: Project) => void;
  /** Remove a project from the store by path */
  removeProject: (path: ProjectPath) => void;
  /** Add a workspace to a project */
  addWorkspace: (projectPath: ProjectPath, workspace: Workspace) => void;
  /** Remove a workspace from a project - projectPath is branded, workspacePath is plain string */
  removeWorkspace: (projectPath: ProjectPath, workspacePath: string) => void;
  /** Set the active workspace - uses plain string to match store */
  setActiveWorkspace: (path: string | null) => void;
  /** Update agent status for a workspace - uses plain string to match store */
  updateAgentStatus: (workspacePath: string, status: AggregatedAgentStatus) => void;
}

/**
 * Sets up all domain event subscriptions.
 *
 * This helper centralizes the wiring between IPC events and store updates.
 * It returns a cleanup function that unsubscribes from all events.
 *
 * @param api - The API object with event subscription methods
 * @param stores - The store update functions
 * @returns A cleanup function to unsubscribe from all events
 *
 * @example
 * ```typescript
 * const cleanup = setupDomainEvents(api, {
 *   addProject: (p) => projectsStore.addProject(p),
 *   removeProject: (path) => projectsStore.removeProject(path),
 *   // ... more store functions
 * });
 *
 * // On unmount:
 * cleanup();
 * ```
 */
export function setupDomainEvents(api: DomainEventApi, stores: DomainStores): CleanupFunction {
  const unsubscribes: CleanupFunction[] = [];

  // Project events
  unsubscribes.push(
    api.onProjectOpened((event) => {
      stores.addProject(event.project);
    })
  );

  unsubscribes.push(
    api.onProjectClosed((event) => {
      stores.removeProject(event.path);
    })
  );

  // Workspace events
  unsubscribes.push(
    api.onWorkspaceCreated((event) => {
      stores.addWorkspace(event.projectPath, event.workspace);
    })
  );

  unsubscribes.push(
    api.onWorkspaceRemoved((event) => {
      stores.removeWorkspace(event.projectPath, event.workspacePath);
    })
  );

  unsubscribes.push(
    api.onWorkspaceSwitched((event) => {
      stores.setActiveWorkspace(event.workspacePath);
    })
  );

  // Agent status events
  unsubscribes.push(
    api.onAgentStatusChanged((event) => {
      stores.updateAgentStatus(event.workspacePath, event.status);
    })
  );

  // Return cleanup function
  return () => {
    unsubscribes.forEach((unsub) => unsub());
  };
}
