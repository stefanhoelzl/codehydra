/**
 * CodeHydra v2 API - Unified interface for all CodeHydra consumers.
 *
 * This module provides the public API surface for interacting with CodeHydra:
 *
 * ## Consumers
 * - **UI (Renderer)**: Full API via IPC (ICodeHydraApi)
 * - **MCP Server**: Core API subset (ICoreApi)
 * - **Future CLI**: Core API subset (ICoreApi)
 *
 * ## Key Types
 * - `ProjectId`: Branded string for type-safe project identification
 * - `WorkspaceName`: Branded string for type-safe workspace names
 * - `WorkspaceRef`: Reference to a workspace (includes path for efficiency)
 *
 * ## Key Interfaces
 * - `ICodeHydraApi`: Full API with projects, workspaces, ui, lifecycle
 * - `ICoreApi`: Subset excluding UI (for MCP/CLI consumers)
 * - `ApiEvents`: All events emitted by the API
 *
 * ## Usage in Renderer
 * ```typescript
 * import { projects, on } from '$lib/api';
 *
 * // List projects
 * const allProjects = await projects.list();
 *
 * // Subscribe to events
 * const unsub = on('project:opened', (event) => {
 *   console.log('Opened:', event.project.name);
 * });
 * ```
 *
 * @module @shared/api
 */

// Type definitions
export type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  AgentStatus,
  AgentStatusCounts,
  BaseInfo,
  SetupStep,
  SetupProgress,
  SetupResult,
  AppState,
} from "./types";

// Type guards and validation
export { isProjectId, isWorkspaceName, validateWorkspaceName } from "./types";

// API interfaces
export type {
  IProjectApi,
  IWorkspaceApi,
  IUiApi,
  ILifecycleApi,
  ICodeHydraApi,
  ICoreApi,
  ApiEvents,
  Unsubscribe,
} from "./interfaces";
