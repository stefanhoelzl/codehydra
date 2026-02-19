/**
 * API Registry Type Definitions.
 * Single source of truth for all API methods.
 */

import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  InitialPrompt,
  AgentSession,
} from "../../shared/api/types";
import type { UIMode } from "../../shared/ipc";
import type { ApiEvents, Unsubscribe, ICodeHydraApi } from "../../shared/api/interfaces";

// =============================================================================
// Payload Types - Define the shape of each method's input
// =============================================================================

/** Methods with no input - use empty object {} */
export type EmptyPayload = object;

/** projects.open */
export interface ProjectOpenPayload {
  readonly path: string;
}

/** projects.close */
export interface ProjectClosePayload {
  readonly projectId: ProjectId;
  /** If true and project has remoteUrl, delete the entire project directory including cloned repo */
  readonly removeLocalRepo?: boolean;
}

/** projects.clone */
export interface ProjectClonePayload {
  readonly url: string;
}

/** projects.get, projects.fetchBases */
export interface ProjectIdPayload {
  readonly projectId: ProjectId;
}

/** workspaces.create */
export interface WorkspaceCreatePayload {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly base: string;
  /** Optional initial prompt to send after workspace is created */
  readonly initialPrompt?: InitialPrompt;
  /** If true, don't switch to the new workspace (default: false = switch to it) */
  readonly keepInBackground?: boolean;
}

/** workspaces.remove */
export interface WorkspaceRemovePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly keepBranch?: boolean;
  /** If true, don't switch away from this workspace when it's active. Used for retry. */
  readonly skipSwitch?: boolean;
  /** If true, force remove (skip cleanup, ignore errors). Replaces old forceRemove. */
  readonly force?: boolean;
  /** Workspace path for retry/dismiss signaling. Provided by renderer on retry/dismiss only. */
  readonly workspacePath?: string;
}

/** workspaces.getStatus, workspaces.getAgentSession, workspaces.getMetadata */
export interface WorkspaceRefPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

/** workspaces.setMetadata */
export interface WorkspaceSetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly key: string;
  readonly value: string | null;
}

/** workspaces.executeCommand */
export interface WorkspaceExecuteCommandPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly command: string;
  readonly args?: readonly unknown[];
}

/** ui.switchWorkspace */
export interface UiSwitchWorkspacePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly focus?: boolean;
}

/** ui.setMode */
export interface UiSetModePayload {
  readonly mode: UIMode;
}

// =============================================================================
// Method Registry - Single Source of Truth
// =============================================================================

/**
 * Single source of truth for all API methods.
 * Maps method path to: (payload) => Promise<result>
 *
 * MethodPath format: `<namespace>.<method>` (e.g., 'projects.open', 'workspaces.create')
 */
export interface MethodRegistry {
  // Lifecycle
  "lifecycle.ready": (payload: EmptyPayload) => Promise<void>;
  "lifecycle.quit": (payload: EmptyPayload) => Promise<void>;

  // Projects
  "projects.open": (payload: ProjectOpenPayload) => Promise<Project>;
  "projects.close": (payload: ProjectClosePayload) => Promise<void>;
  "projects.clone": (payload: ProjectClonePayload) => Promise<Project>;
  "projects.fetchBases": (
    payload: ProjectIdPayload
  ) => Promise<{ readonly bases: readonly BaseInfo[] }>;

  // Workspaces
  "workspaces.create": (payload: WorkspaceCreatePayload) => Promise<Workspace>;
  "workspaces.remove": (payload: WorkspaceRemovePayload) => Promise<{ started: boolean }>;
  "workspaces.getStatus": (payload: WorkspaceRefPayload) => Promise<WorkspaceStatus>;
  "workspaces.getAgentSession": (payload: WorkspaceRefPayload) => Promise<AgentSession | null>;
  "workspaces.restartAgentServer": (payload: WorkspaceRefPayload) => Promise<number>;
  "workspaces.setMetadata": (payload: WorkspaceSetMetadataPayload) => Promise<void>;
  "workspaces.getMetadata": (
    payload: WorkspaceRefPayload
  ) => Promise<Readonly<Record<string, string>>>;
  "workspaces.executeCommand": (payload: WorkspaceExecuteCommandPayload) => Promise<unknown>;

  // UI
  "ui.selectFolder": (payload: EmptyPayload) => Promise<string | null>;
  "ui.getActiveWorkspace": (payload: EmptyPayload) => Promise<WorkspaceRef | null>;
  "ui.switchWorkspace": (payload: UiSwitchWorkspacePayload) => Promise<void>;
  "ui.setMode": (payload: UiSetModePayload) => Promise<void>;
}

// =============================================================================
// Derived Types - No Duplication!
// =============================================================================

/**
 * Union of all valid method paths.
 * Derived from MethodRegistry keys.
 */
export type MethodPath = keyof MethodRegistry;

/**
 * Grouped method paths for better organization.
 * @internal Exported for testing only - used for type-level verification
 */
export type LifecyclePath = "lifecycle.ready" | "lifecycle.quit";
/** @internal Exported for testing only */
export type ProjectPath =
  | "projects.open"
  | "projects.close"
  | "projects.clone"
  | "projects.fetchBases";
/** @internal Exported for testing only */
export type WorkspacePath =
  | "workspaces.create"
  | "workspaces.remove"
  | "workspaces.getStatus"
  | "workspaces.getAgentSession"
  | "workspaces.restartAgentServer"
  | "workspaces.setMetadata"
  | "workspaces.getMetadata"
  | "workspaces.executeCommand";
/** @internal Exported for testing only */
export type UiPath =
  | "ui.selectFolder"
  | "ui.getActiveWorkspace"
  | "ui.switchWorkspace"
  | "ui.setMode";

/**
 * Get the handler signature for a method path.
 */
export type MethodHandler<P extends MethodPath> = MethodRegistry[P];

/**
 * Get the payload type for a method path.
 */
export type MethodPayload<P extends MethodPath> = Parameters<MethodRegistry[P]>[0];

/**
 * Get the return type for a method path.
 */
export type MethodResult<P extends MethodPath> = Awaited<ReturnType<MethodRegistry[P]>>;

/**
 * Complete list of all method paths - used for completeness verification.
 * This array must contain all keys from MethodRegistry.
 */
export const ALL_METHOD_PATHS = [
  "lifecycle.ready",
  "lifecycle.quit",
  "projects.open",
  "projects.close",
  "projects.clone",
  "projects.fetchBases",
  "workspaces.create",
  "workspaces.remove",
  "workspaces.getStatus",
  "workspaces.getAgentSession",
  "workspaces.restartAgentServer",
  "workspaces.setMetadata",
  "workspaces.getMetadata",
  "workspaces.executeCommand",
  "ui.selectFolder",
  "ui.getActiveWorkspace",
  "ui.switchWorkspace",
  "ui.setMode",
] as const satisfies readonly MethodPath[];

// =============================================================================
// Registration Options
// =============================================================================

/**
 * Options for method registration.
 */
export interface RegistrationOptions {
  /**
   * IPC channel name for this method.
   * If provided, an IPC handler is automatically registered.
   * Must be a value from ApiIpcChannels (explicit, not derived from path).
   */
  readonly ipc?: string;
}

// =============================================================================
// Module Interface
// =============================================================================

/**
 * Interface that all API modules must implement.
 * Formalizes the module contract for consistency and testing.
 */
export interface IApiModule {
  /**
   * Dispose module resources.
   * Called during shutdown in reverse order of creation.
   */
  dispose(): void;
}

// =============================================================================
// Registry Interface
// =============================================================================

/**
 * API Registry interface - used by modules to register methods.
 * Events reuse ApiEvents from src/shared/api/interfaces.ts.
 */
export interface IApiRegistry {
  /**
   * Register an API method.
   * Type-safe: path must exist in MethodRegistry, handler must match signature.
   * @throws Error if path is already registered (prevents accidental overwrites)
   */
  register<P extends MethodPath>(
    path: P,
    handler: MethodHandler<P>,
    options?: RegistrationOptions
  ): void;

  /**
   * Emit an event to all subscribers.
   * Uses ApiEvents from src/shared/api/interfaces.ts.
   */
  emit<E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void;

  /**
   * Subscribe to an event.
   */
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;

  /**
   * Get the typed public API interface.
   * Builds ICodeHydraApi facade from registered methods.
   * @throws Error if not all methods are registered
   */
  getInterface(): ICodeHydraApi;

  /**
   * Cleanup all subscriptions and IPC handlers.
   * Safe to call multiple times (idempotent).
   */
  dispose(): Promise<void>;
}

// Re-export ApiEvents and related types for convenience
export type { ApiEvents, Unsubscribe, ICodeHydraApi };
