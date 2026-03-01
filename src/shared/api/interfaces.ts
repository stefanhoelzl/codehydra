/**
 * API event type definitions for CodeHydra.
 *
 * ApiEvents defines the IPC event contract between the main process and renderer.
 * These event types are used by:
 * - The IPC event bridge (domain events → sendToUI)
 * - The renderer (event type definitions for IPC listeners)
 */

import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupScreenProgress,
} from "./types";
import type { UIModeChangedEvent, SetupErrorPayload } from "../ipc";

// Re-export for consumers that import from this module
export type { Unsubscribe } from "../types";

// =============================================================================
// Domain Event Types (shared with renderer)
// =============================================================================

/**
 * Typed event map for domain events sent to the renderer via IPC.
 * Used by the renderer to type-check event handlers on `api.on()`.
 */
export interface ApiEvents {
  "project:opened": (event: { readonly project: Project }) => void;
  "project:closed": (event: { readonly projectId: ProjectId }) => void;
  "project:bases-updated": (event: {
    readonly projectId: ProjectId;
    readonly projectPath: string;
    readonly bases: readonly BaseInfo[];
  }) => void;
  "workspace:created": (event: {
    readonly projectId: ProjectId;
    readonly workspace: Workspace;
    /** True if an initial prompt was provided for the workspace */
    readonly hasInitialPrompt?: boolean;
    /** If false, workspace should not steal focus (but still switches when nothing is active) */
    readonly stealFocus?: boolean;
  }) => void;
  "workspace:removed": (event: WorkspaceRef) => void;
  "workspace:switched": (event: WorkspaceRef | null) => void;
  "workspace:status-changed": (event: WorkspaceRef & { readonly status: WorkspaceStatus }) => void;
  "workspace:metadata-changed": (event: {
    readonly projectId: ProjectId;
    readonly workspaceName: WorkspaceName;
    readonly key: string;
    readonly value: string | null;
  }) => void;
  "ui:mode-changed": (event: UIModeChangedEvent) => void;
  "lifecycle:setup-progress": (event: SetupScreenProgress) => void;
  "lifecycle:setup-error": (event: SetupErrorPayload) => void;
}
