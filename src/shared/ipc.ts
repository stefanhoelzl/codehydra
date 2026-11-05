/**
 * IPC channel names and payload types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 * Validation schemas are in src/main/ipc/validation.ts.
 */

// ============ Branded Path Types ============
// zod is the single source of truth for these brands (src/intents/contract). This is a
// type-only re-export, erased at build, so this browser-safe module pulls no zod at runtime
// and renderer/preload keep importing ProjectPath/WorkspacePath from here unchanged.

export type { ProjectPath, ProjectRef, WorkspacePath, WorkspaceRef } from "../intents/contract";

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
 *
 * `changedAt` (ISO-8601) is when the workspace last moved between running no
 * agent (`none`), waiting (`idle`) and working (`busy` or `mixed`); a move
 * between busy and mixed, or a change of the counts alone, keeps it. Absent
 * while nothing has stamped it (a workspace that has reported no status yet).
 */
export type AggregatedAgentStatus =
  | {
      readonly status: "none";
      readonly counts: InternalAgentCounts;
      readonly changedAt?: string | undefined;
    }
  | {
      readonly status: "idle";
      readonly counts: InternalAgentCounts;
      readonly changedAt?: string | undefined;
    }
  | {
      readonly status: "busy";
      readonly counts: InternalAgentCounts;
      readonly changedAt?: string | undefined;
    }
  | {
      readonly status: "mixed";
      readonly counts: InternalAgentCounts;
      readonly changedAt?: string | undefined;
    };

// ============ UI Mode Types ============

/**
 * UI mode for the application. Computed by the presenter (main) and shipped in
 * the UiState snapshot; the renderer reads it from there.
 * - "workspace": Normal mode, workspace view has focus, UI behind workspace
 * - "shortcut": Shortcut mode active, UI on top, shows keyboard hints
 * - "dialog": Dialog open, UI on top, dialog has focus (blocks Alt+X)
 * - "hover": UI overlay active (sidebar hover), UI on top, no focus change (allows Alt+X)
 */
export type UIMode = "workspace" | "dialog" | "shortcut" | "hover";

// ============ API Layer IPC Channels ============
// All IPC channels use the api: prefix.
// Domain events are mapped to IPC channels by the UiIpc module.

/**
 * IPC channel names for main↔renderer communication.
 * All channels use the api: prefix convention.
 */
export const ApiIpcChannels = {
  // The complete main↔renderer surface is two channels. Renderer→main gestures
  // (open/close/switch/wake/hibernate/remove/quit), dialog/notification user
  // interactions, and logs all flow through the fire-and-forget ui:event union
  // (UI_EVENT); the presenter owns identity resolution and routing. All
  // main→renderer state — sidebar, frames, mode, dialogs, notifications, theme —
  // ships in the full ui:state snapshot (UI_STATE). No per-feature channels.
  // UI events (renderer → main, fire-and-forget; zod-validated union)
  UI_EVENT: "api:ui:event",
  // UI state snapshots (main → renderer)
  UI_STATE: "api:ui:state",
} as const satisfies Record<string, string>;

// ============ Lifecycle Event Payload Types ============

/**
 * Agent types for agent selection, and the agent info the selection dialog renders
 * (provided by per-agent modules via the register-agents hook).
 *
 * Type-only re-exports of the intent contract's `agentTypeSchema` / `agentInfoSchema`. zod is
 * the single source of truth and stays confined to the intent system; these re-exports are
 * erased at build, so renderer/preload keep importing from here without pulling zod in. There
 * used to be four hand-written declarations of this two-member union (here, api/types.ts,
 * config.ts, app-start.ts) — two of them sharing the name `ConfigAgentType`.
 */
export type { AgentType as LifecycleAgentType, AgentInfo } from "../intents/contract";

// ============ Log API Types ============

/** Context data for log entries; one declaration, shared with the extension protocol. */
export type { LogContext } from "./api-protocol";
