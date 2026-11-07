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
 * Sends workbench.action.terminal.focus via the sidekick (best-effort, past the
 * intent pipeline: see ApiServerModuleHandle.tryCommand), then refreshes OS
 * window focus and the in-window focus chain so keystrokes reach xterm.
 *
 * Hooks:
 * - vscode:modal-changed → "modal": tracks which workspaces have a modal open in
 *   their editor (a waiting sidebar card is not in front of the terminal).
 *   While one is, the agent provider reports the workspace "idle" whatever the
 *   agent is doing, so that idle says nothing about the agent terminal: it can
 *   arrive before the sidekick has created it (a modal can be raised the moment
 *   the sidekick connects). A terminal.focus sent then
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
  /** Best-effort command to the workspace's sidekick (ApiServerModuleHandle.tryCommand). */
  readonly tryCommand: (workspaceRef: WorkspaceRef, command: string) => Promise<boolean>;
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
    // Not dispatched as a vscode:command intent. The first idle can beat the
    // workspace's sidekick connecting, most visibly right after a wake or on a
    // relaunch that rediscovers workspaces. It can also come after the sidekick
    // has gone: the switch-driven trigger awaits a status query, and a deletion
    // or app shutdown tears the connection down while that is in flight, or
    // while the intent itself is still resolving its workspace. A rejected intent
    // is logged at error level, so a routine ordering would show up in the log,
    // and in every bug report, as a fault. Checking for a connection before
    // dispatching cannot close that gap. tryCommand looks the socket up when it
    // sends, and "not delivered" is just false. The retry on the next trigger is
    // what actually focuses the terminal either way.
    inFlight.add(workspaceRef);
    void deps
      .tryCommand(workspaceRef, "workbench.action.terminal.focus")
      .then((delivered) => {
        if (!delivered) return;
        focused.add(workspaceRef);
        deps.viewManager.focus();
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
            const { workspaceRef, source, open } = ctx;
            if (source === "editor") {
              if (open) modalOpen.add(workspaceRef);
              else modalOpen.delete(workspaceRef);
            }
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
