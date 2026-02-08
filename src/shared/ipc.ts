/**
 * IPC channel names and payload types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 * Validation schemas are in src/main/ipc/validation.ts.
 */

// ============ Branded Path Types ============

declare const ProjectPathBrand: unique symbol;
declare const WorkspacePathBrand: unique symbol;

/**
 * Branded type for project paths (git repository root directories).
 */
export type ProjectPath = string & { readonly [ProjectPathBrand]: true };

/**
 * Branded type for workspace paths (git worktree directories).
 */
export type WorkspacePath = string & { readonly [WorkspacePathBrand]: true };

// ============ Domain Types ============

// NOTE: Most domain types have been moved to src/shared/api/types.ts
// This file retains only types needed for IPC communication.

// ============ Agent Status Types ============

/**
 * Internal counts of agents in each status for aggregation.
 * This is used internally for status computation - external consumers
 * should use AgentStatusCounts from api/types.ts which includes `total`.
 */
export interface InternalAgentCounts {
  readonly idle: number;
  readonly busy: number;
}

/**
 * Aggregated agent status for a workspace (discriminated union).
 * Used internally for status aggregation.
 */
export type AggregatedAgentStatus =
  | { readonly status: "none"; readonly counts: InternalAgentCounts }
  | { readonly status: "idle"; readonly counts: InternalAgentCounts }
  | { readonly status: "busy"; readonly counts: InternalAgentCounts }
  | { readonly status: "mixed"; readonly counts: InternalAgentCounts };

// ============ UI Mode Types ============

/**
 * UI mode for the application.
 * - "workspace": Normal mode, workspace view has focus, UI behind workspace
 * - "shortcut": Shortcut mode active, UI on top, shows keyboard hints
 * - "dialog": Dialog open, UI on top, dialog has focus (blocks Alt+X)
 * - "hover": UI overlay active (sidebar hover), UI on top, no focus change (allows Alt+X)
 */
export type UIMode = "workspace" | "dialog" | "shortcut" | "hover";

/**
 * Event payload for UI mode changes.
 */
export interface UIModeChangedEvent {
  readonly mode: UIMode;
  readonly previousMode: UIMode;
}

// ============ API Layer IPC Channels ============
// All IPC channels use the api: prefix and work with ICodeHydraApi.
// Internal events (e.g., "project:opened") are mapped to IPC channels (e.g., "api:project:opened")
// by the preload script's on() function and wireApiEvents() in api-handlers.ts.

/**
 * IPC channel names for main↔renderer communication.
 * All channels use the api: prefix convention.
 */
export const ApiIpcChannels = {
  // Project commands
  PROJECT_OPEN: "api:project:open",
  PROJECT_CLOSE: "api:project:close",
  PROJECT_CLONE: "api:project:clone",
  PROJECT_LIST: "api:project:list",
  PROJECT_GET: "api:project:get",
  PROJECT_FETCH_BASES: "api:project:fetch-bases",
  // Workspace commands
  WORKSPACE_CREATE: "api:workspace:create",
  WORKSPACE_REMOVE: "api:workspace:remove",
  WORKSPACE_GET: "api:workspace:get",
  WORKSPACE_GET_STATUS: "api:workspace:get-status",
  WORKSPACE_GET_AGENT_SESSION: "api:workspace:get-agent-session",
  WORKSPACE_RESTART_AGENT_SERVER: "api:workspace:restart-agent-server",
  WORKSPACE_SET_METADATA: "api:workspace:set-metadata",
  WORKSPACE_GET_METADATA: "api:workspace:get-metadata",
  // UI commands
  UI_SELECT_FOLDER: "api:ui:select-folder",
  UI_GET_ACTIVE_WORKSPACE: "api:ui:get-active-workspace",
  UI_SWITCH_WORKSPACE: "api:ui:switch-workspace",
  UI_SET_MODE: "api:ui:set-mode",
  // Lifecycle commands
  LIFECYCLE_GET_STATE: "api:lifecycle:get-state",
  LIFECYCLE_SET_AGENT: "api:lifecycle:set-agent",
  LIFECYCLE_SETUP: "api:lifecycle:setup",
  LIFECYCLE_START_SERVICES: "api:lifecycle:start-services",
  LIFECYCLE_QUIT: "api:lifecycle:quit",
  // Lifecycle events (main → renderer)
  LIFECYCLE_SETUP_PROGRESS: "api:lifecycle:setup-progress",
  // Log commands (renderer → main)
  LOG_DEBUG: "api:log:debug",
  LOG_INFO: "api:log:info",
  LOG_WARN: "api:log:warn",
  LOG_ERROR: "api:log:error",
  // Events (main → renderer)
  PROJECT_OPENED: "api:project:opened",
  PROJECT_CLOSED: "api:project:closed",
  PROJECT_BASES_UPDATED: "api:project:bases-updated",
  WORKSPACE_CREATED: "api:workspace:created",
  WORKSPACE_REMOVED: "api:workspace:removed",
  WORKSPACE_SWITCHED: "api:workspace:switched",
  WORKSPACE_STATUS_CHANGED: "api:workspace:status-changed",
  WORKSPACE_METADATA_CHANGED: "api:workspace:metadata-changed",
  WORKSPACE_DELETION_PROGRESS: "api:workspace:deletion-progress",
  WORKSPACE_LOADING_CHANGED: "api:workspace:loading-changed",
  UI_MODE_CHANGED: "api:ui:mode-changed",
  SHORTCUT_KEY: "api:shortcut:key",
} as const satisfies Record<string, string>;

// ============ Workspace Loading Types ============

/**
 * Payload for workspace loading state change events.
 * Sent when a workspace starts or finishes loading.
 */
export interface WorkspaceLoadingChangedPayload {
  /** Path to the workspace */
  readonly path: WorkspacePath;
  /** True when loading starts, false when loading ends */
  readonly loading: boolean;
}

// ============ Log API Types ============

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety.
 */
export type LogContext = Record<string, string | number | boolean | null>;

/**
 * Payload for api:log:* commands.
 */
export interface ApiLogPayload {
  /** Logger name/scope (e.g., 'ui', 'api') */
  readonly logger: string;
  /** Log message */
  readonly message: string;
  /** Optional context data */
  readonly context?: LogContext;
}
