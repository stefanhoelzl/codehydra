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

// ============ IPC Handler Payload Types ============
// Payload types for IPC handlers registered in the UiIpc module.

/** projects.open */
export interface ProjectOpenPayload {
  readonly path?: string;
}

/** ui.switchWorkspace. `workspacePath: null` = deselect (no active workspace;
 *  the creation panel becomes the main view). */
export interface UiSwitchWorkspacePayload {
  readonly workspacePath: string | null;
  readonly focus?: boolean;
}

/** ui.setMode */
export interface UiSetModePayload {
  readonly mode: UIMode;
}

// ============ API Layer IPC Channels ============
// All IPC channels use the api: prefix.
// Domain events are mapped to IPC channels by the UiIpc module.

/**
 * IPC channel names for main↔renderer communication.
 * All channels use the api: prefix convention.
 */
export const ApiIpcChannels = {
  // Project commands (close is NOT an invoke: the close-project ui:event
  // requests the flow; main owns the confirmation dialog and dispatch)
  PROJECT_OPEN: "api:project:open",
  // Workspace commands (remove likewise goes through the remove-workspace
  // ui:event)
  WORKSPACE_HIBERNATE: "api:workspace:hibernate",
  WORKSPACE_WAKE: "api:workspace:wake",
  // UI commands
  UI_SWITCH_WORKSPACE: "api:ui:switch-workspace",
  UI_SET_MODE: "api:ui:set-mode",
  // Lifecycle commands
  LIFECYCLE_READY: "api:lifecycle:ready",
  LIFECYCLE_QUIT: "api:lifecycle:quit",
  // Lifecycle events (main → renderer)
  LIFECYCLE_SHOW_MAIN_VIEW: "api:lifecycle:show-main-view",
  // Dialog framework (main ↔ renderer)
  DIALOG_COMMAND: "api:dialog:command",
  DIALOG_EVENT: "api:dialog:event",
  // Notification framework (main ↔ renderer)
  NOTIFICATION_COMMAND: "api:notification:command",
  NOTIFICATION_EVENT: "api:notification:event",
  // UI events (renderer → main, fire-and-forget; zod-validated union)
  UI_EVENT: "api:ui:event",
  // UI state snapshots (main → renderer)
  UI_STATE: "api:ui:state",
  // Events (main → renderer)
  PROJECT_OPENED: "api:project:opened",
  PROJECT_CLOSED: "api:project:closed",
  PROJECT_BASES_UPDATED: "api:project:bases-updated",
  WORKSPACE_CREATED: "api:workspace:created",
  WORKSPACE_LOADING: "api:workspace:loading",
  WORKSPACE_CREATE_FAILED: "api:workspace:create-failed",
  WORKSPACE_REMOVED: "api:workspace:removed",
  WORKSPACE_HIBERNATED: "api:workspace:hibernated",
  WORKSPACE_HIBERNATE_FAILED: "api:workspace:hibernate-failed",
  WORKSPACE_WOKEN: "api:workspace:woken",
  WORKSPACE_WAKE_FAILED: "api:workspace:wake-failed",
  WORKSPACE_SWITCHED: "api:workspace:switched",
  WORKSPACE_STATUS_CHANGED: "api:workspace:status-changed",
  WORKSPACE_METADATA_CHANGED: "api:workspace:metadata-changed",
  WORKSPACE_DELETION_PROGRESS: "api:workspace:deletion-progress",
  UI_MODE_CHANGED: "api:ui:mode-changed",
  UI_THEME: "api:ui:theme",
  SHORTCUT_KEY: "api:shortcut:key",
} as const satisfies Record<string, string>;

// ============ Lifecycle Event Payload Types ============

/**
 * Agent types for agent selection.
 * Mirrors ConfigAgentType from api/types.ts but defined here to avoid circular imports.
 */
export type LifecycleAgentType = "opencode" | "claude";

/**
 * Agent info for the selection dialog.
 * Provided by per-agent modules via the register-agents hook.
 */
export interface AgentInfo {
  readonly agent: LifecycleAgentType;
  readonly label: string;
  readonly icon: string;
}

// ============ Log API Types ============

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety.
 */
export type LogContext = Record<string, string | number | boolean | null>;
