/**
 * CodeHydra v2 API - Unified interface for all CodeHydra consumers.
 *
 * This module provides the public API surface for interacting with CodeHydra:
 *
 * ## Key Types
 * - `ProjectId`: Branded string for type-safe project identification
 * - `WorkspaceName`: Branded string for type-safe workspace names
 * - `WorkspaceRef`: Reference to a workspace (includes path for efficiency)
 *
 * ## Key Interfaces
 * - `IProjectApi`, `IWorkspaceApi`, `IUiApi`, `ILifecycleApi`: Domain API contracts
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
export type { IProjectApi, IWorkspaceApi, IUiApi, ILifecycleApi, Unsubscribe } from "./interfaces";
