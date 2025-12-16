/**
 * API interface definitions for CodeHydra.
 * Stub file - implementation coming in Step 1.4.
 */

import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupResult,
  SetupProgress,
  AppState,
} from "./types";
import type { UIMode, UIModeChangedEvent } from "../ipc";

/**
 * Interface for objects that can be disposed.
 * Duplicated here to avoid importing from services.
 */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

// =============================================================================
// Domain API Interfaces - Stubs
// =============================================================================

export interface IProjectApi {
  open(path: string): Promise<Project>;
  close(projectId: ProjectId): Promise<void>;
  list(): Promise<readonly Project[]>;
  get(projectId: ProjectId): Promise<Project | undefined>;
  fetchBases(projectId: ProjectId): Promise<{ readonly bases: readonly BaseInfo[] }>;
}

export interface IWorkspaceApi {
  create(projectId: ProjectId, name: string, base: string): Promise<Workspace>;
  /**
   * Start workspace removal (fire-and-forget).
   * Progress is emitted via workspace:deletion-progress events.
   * Returns immediately with { started: true }.
   */
  remove(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    keepBranch?: boolean
  ): Promise<{ started: true }>;
  /**
   * Force remove a workspace (skip cleanup operations).
   * Used for "Close Anyway" when deletion fails.
   * Removes workspace from internal state without running cleanup.
   */
  forceRemove(projectId: ProjectId, workspaceName: WorkspaceName): Promise<void>;
  get(projectId: ProjectId, workspaceName: WorkspaceName): Promise<Workspace | undefined>;
  getStatus(projectId: ProjectId, workspaceName: WorkspaceName): Promise<WorkspaceStatus>;
  /**
   * Set a metadata value for a workspace.
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @param key Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value Value to set, or null to delete the key
   * @throws Error if project or workspace not found, or key format invalid
   */
  setMetadata(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    key: string,
    value: string | null
  ): Promise<void>;
  /**
   * Get all metadata for a workspace.
   * Always includes `base` key (with fallback if not in config).
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @returns Metadata record with at least `base` key
   * @throws Error if project or workspace not found
   */
  getMetadata(
    projectId: ProjectId,
    workspaceName: WorkspaceName
  ): Promise<Readonly<Record<string, string>>>;
}

export interface IUiApi {
  selectFolder(): Promise<string | null>;
  getActiveWorkspace(): Promise<WorkspaceRef | null>;
  switchWorkspace(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    focus?: boolean
  ): Promise<void>;
  /**
   * Sets the UI mode.
   * - "workspace": UI at z-index 0, focus active workspace
   * - "shortcut": UI on top, focus UI layer
   * - "dialog": UI on top, no focus change
   *
   * Mode transitions are idempotent - setting the same mode twice does not emit an event.
   *
   * @param mode - The new UI mode
   */
  setMode(mode: UIMode): Promise<void>;
}

export interface ILifecycleApi {
  getState(): Promise<AppState>;
  setup(): Promise<SetupResult>;
  quit(): Promise<void>;
}

// =============================================================================
// Event Types
// =============================================================================

export interface ApiEvents {
  "project:opened": (event: { readonly project: Project }) => void;
  "project:closed": (event: { readonly projectId: ProjectId }) => void;
  "project:bases-updated": (event: {
    readonly projectId: ProjectId;
    readonly bases: readonly BaseInfo[];
  }) => void;
  "workspace:created": (event: {
    readonly projectId: ProjectId;
    readonly workspace: Workspace;
  }) => void;
  "workspace:removed": (event: WorkspaceRef) => void;
  "workspace:switched": (event: WorkspaceRef | null) => void;
  "workspace:status-changed": (event: WorkspaceRef & { readonly status: WorkspaceStatus }) => void;
  "workspace:metadata-changed": (event: {
    readonly projectId: ProjectId;
    readonly workspaceName: WorkspaceName;
    readonly key: string;
    readonly value: string | null; // null means deleted
  }) => void;
  "ui:mode-changed": (event: UIModeChangedEvent) => void;
  "setup:progress": (event: SetupProgress) => void;
}

// =============================================================================
// Main API Interface
// =============================================================================

export type Unsubscribe = () => void;

export interface ICodeHydraApi extends IDisposable {
  readonly projects: IProjectApi;
  readonly workspaces: IWorkspaceApi;
  readonly ui: IUiApi;
  readonly lifecycle: ILifecycleApi;
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

// =============================================================================
// Core API (subset for MCP/CLI)
// =============================================================================

export type ICoreApi = Pick<ICodeHydraApi, "projects" | "workspaces" | "on" | "dispose">;
