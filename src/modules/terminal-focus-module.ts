/**
 * TerminalFocusModule - Initial terminal focus for a workspace.
 *
 * Fires exactly once per workspace (until it is deleted): after the first
 * focus, the in-frame focus tracker (installed by view-manager via the
 * boundary's installChildFrameScript) preserves wherever the user left off
 * (search input, editor, terminal, file explorer, etc.) across switches.
 *
 * Triggers:
 * - agent:status-updated → "idle" for the active workspace (most common path:
 *   agent boots, becomes idle while its workspace is on screen).
 * - workspace:switched to a workspace not yet focused whose current status is
 *   idle (covers auto-switch after delete and switch-to-already-idle cases).
 *
 * Dispatches workbench.action.terminal.focus via the sidekick, then refreshes
 * OS window focus and the in-window focus chain so keystrokes reach xterm.
 *
 * Hooks:
 * - vscode:modal-changed → "modal": tracks which workspaces have a modal open.
 *   While one is, the agent provider reports the workspace "idle" whatever the
 *   agent is doing, so that idle says nothing about the agent terminal: it can
 *   arrive before the sidekick has created it (the Migrate offer for old hooks
 *   is raised the moment the sidekick connects). A terminal.focus sent then
 *   makes VS Code create a terminal of its own, racing the sidekick's, and can
 *   hang until the command times out. Focusing behind a modal is wrong anyway,
 *   so nothing is sent while one is open; closing it re-reports the real status,
 *   which triggers the focus if the agent is idle. The edge is recorded long
 *   before that re-report lands (it is dispatched unawaited and resolves the
 *   workspace first); the agent modules' "modal" handlers require
 *   MODAL_RECORDED_CAPABILITY, which makes the order certain rather than likely.
 *
 * Subscribes to:
 * - workspace:deleted: forgets the workspace (also runtime teardown on
 *   project:close, so a reopened project focuses its terminals again).
 */

import type { IntentModule } from "../intents/lib/module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { HookOutput } from "../intents/lib/operation";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { VSCODE_MODAL_CHANGED_OPERATION_ID } from "../intents/vscode-modal-changed";
import { INTENT_VSCODE_COMMAND } from "../intents/vscode-command";
import type { VscodeCommandIntent } from "../intents/vscode-command";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../intents/get-workspace-status";
import type { WorkspaceRef } from "../intents/contract";
import { defineEvents, defineHooks } from "../intents/declarations";

/**
 * Capability the vscode:modal-changed "modal" handler provides once the modal
 * edge is recorded. The agent modules require it before re-reporting status.
 */
export const MODAL_RECORDED_CAPABILITY = "modal-recorded";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface TerminalFocusModuleDeps {
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** Whether the workspace's sidekick has a live socket (ApiServerModuleHandle.isConnected). */
  readonly isConnected: (workspaceRef: WorkspaceRef) => boolean;
  readonly viewManager: { focus(): void };
}

// =============================================================================
// Factory
// =============================================================================

export function createTerminalFocusModule(deps: TerminalFocusModuleDeps): IntentModule {
  const focused = new Set<WorkspaceRef>();
  /** Focus commands sent and not yet answered, so a burst of idle reports sends one. */
  const inFlight = new Set<WorkspaceRef>();
  const modalOpen = new Set<WorkspaceRef>();

  function focusTerminal(workspaceRef: WorkspaceRef): void {
    if (focused.has(workspaceRef) || inFlight.has(workspaceRef)) return;
    if (modalOpen.has(workspaceRef)) return;
    // Ask before dispatching. This fires on the first idle status, which can beat
    // the workspace's extension connecting — most visibly right after a wake, or
    // on a relaunch that rediscovers workspaces — and can also arrive after it has
    // gone, since the switch-driven trigger awaits a status query and a deletion
    // tears the extension host down while that is in flight. Dispatching
    // regardless still "works" (the catch below is exactly for that), but the
    // intent rejects and the dispatcher logs the rejection at error level, so a
    // routine ordering shows up in the log, and in every bug report, as a fault.
    // The retry on the next trigger is what actually focuses the terminal either way.
    //
    // `isConnected`, not `isReady`: a listening server says nothing about *this*
    // workspace, so the server-level check let exactly the torn-down case through.
    if (!deps.isConnected(workspaceRef)) return;

    inFlight.add(workspaceRef);
    void deps.dispatcher
      .dispatch<VscodeCommandIntent>({
        type: INTENT_VSCODE_COMMAND,
        payload: { workspaceRef, command: "workbench.action.terminal.focus" },
      })
      .then(() => {
        focused.add(workspaceRef);
        deps.viewManager.focus();
      })
      .catch(() => {
        /* sidekick not connected yet; will retry on next trigger */
      })
      .finally(() => {
        inFlight.delete(workspaceRef);
      });
  }

  return {
    name: "terminal-focus",
    hooks: defineHooks({
      [VSCODE_MODAL_CHANGED_OPERATION_ID]: {
        modal: {
          handler: async (ctx): Promise<HookOutput<void>> => {
            const { workspaceRef, open } = ctx;
            if (open) modalOpen.add(workspaceRef);
            else modalOpen.delete(workspaceRef);
            return { provides: { [MODAL_RECORDED_CAPABILITY]: true } };
          },
        },
      },
    }),
    events: defineEvents({
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef, active, status } = event.payload;
          if (status.status !== "idle") return;
          if (!active) return;
          focusTerminal(workspaceRef);
        },
      },
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event): Promise<void> => {
          const payload = event.payload;
          if (!payload) return;
          const path = payload.workspaceRef;
          if (focused.has(path)) return;
          void deps.dispatcher
            .dispatch<GetWorkspaceStatusIntent>({
              type: INTENT_GET_WORKSPACE_STATUS,
              payload: { workspaceRef: path },
            })
            .then((status) => {
              if (status.agent.type === "idle") focusTerminal(path);
            })
            .catch(() => {
              /* status query failed; agent-idle event will handle it later */
            });
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef } = event.payload;
          focused.delete(workspaceRef);
          modalOpen.delete(workspaceRef);
        },
      },
    }),
  };
}
