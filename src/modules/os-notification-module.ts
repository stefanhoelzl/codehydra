/**
 * OsNotificationModule - Raises an OS notification when an agent goes idle
 * while CodeHydra is in the background.
 *
 * The sidebar already says which workspaces are working, so a notification only
 * earns its place when the sidebar is not on screen. Every notification is
 * therefore gated on the window not having OS focus at the moment of the
 * transition, and on the `notification` config key:
 *
 * - "disabled"        — never notify
 * - "each-workspace"  — notify on every workspace that goes idle
 * - "first-workspace" — notify only when nothing was idle beforehand, i.e. the
 *                       moment the fleet stops being uniformly busy and there
 *                       is finally something for the user to look at
 *
 * Subscribes to:
 * - agent:status-updated: the transition to evaluate
 * - workspace:deleted: evicts the workspace (covers full deletion and the
 *   runtime teardown project:close performs, which both emit it)
 *
 * Hooks:
 * - app-shutdown/stop: closes notifications still on screen — one whose click
 *   would focus a dead app is a dead end.
 *
 * Unlike badge-module and power-module this does not use
 * createWorkspaceStatusCache: that helper reports *that* something changed, and
 * every question here is about the transition itself — which workspace moved,
 * and what its counts were beforehand. Both need the event payload and a map
 * the handler updates itself, so the shared cache would be carried alongside
 * that map rather than replacing it.
 *
 * Distinct from clone-notification-module and error-notification-module, which
 * despite the name drive *sidebar* notifications through the presenter. This is
 * the only module that raises OS-level toasts.
 */

import type { EventDeclarations, IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { WorkspacePath, InternalAgentCounts } from "../shared/ipc";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { WorkspaceDeletedEvent } from "../intents/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "../intents/switch-workspace";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { OsNotificationBoundary } from "../boundaries/shell/os-notification";
import type { WindowManager } from "../boundaries/shell/window-manager";
import type { Config } from "../boundaries/platform/config";
import { storeEnum } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import { getErrorMessage } from "../shared/error-utils";

// =============================================================================
// Config
// =============================================================================

/** Allowed values for the `notification` config key. */
export const NOTIFICATION_MODES = ["disabled", "each-workspace", "first-workspace"] as const;

/** When CodeHydra raises an OS notification for an idle agent. */
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/**
 * Fixed title. The workspace name goes in the body: the title is identical on
 * every toast, so spending the one line the OS renders prominently on it would
 * make a stack of them unreadable.
 */
const NOTIFICATION_TITLE = "CodeHydra agent needs your attention";

// =============================================================================
// Transition detection (pure functions)
// =============================================================================

/** What the module remembers about a workspace between status reports. */
interface TrackedWorkspace {
  readonly counts: InternalAgentCounts;
}

/**
 * Whether a status change means "an agent just became available".
 *
 * Deliberately the same rule as the renderer's chime (AgentNotificationService):
 * any increase in the idle count, plus the first report that already has idle
 * agents. That first-report case is what turns a workspace green when its agent
 * connects; treating it as a non-event would leave the toast and the chime
 * disagreeing about the same moment. The cost is that a batch of workspaces
 * reporting in at once — app start, project open, waking from hibernation — can
 * each notify if the window happens to be unfocused.
 *
 * @param previous - Counts from the last report, or undefined on the first
 * @param next - Counts from this report
 */
export function isIdleIncrease(
  previous: InternalAgentCounts | undefined,
  next: InternalAgentCounts
): boolean {
  return previous === undefined ? next.idle > 0 : next.idle > previous.idle;
}

/**
 * Whether every workspace with a live agent was busy — nothing idle anywhere.
 *
 * The precondition for "first-workspace": if this held immediately before an
 * idle increase, the workspace that just finished is the first one free. It
 * stops holding the moment anything is idle, so the mode re-arms itself and
 * cannot fire again until the fleet is uniformly busy once more.
 *
 * Workspaces with no agent (hibernated, still starting) count for neither side,
 * matching how the badge treats "none": they are not evidence of work in
 * progress, and they must not suppress the notification forever either.
 *
 * @param tracked - Per-workspace state as it was before the change
 */
export function wasEveryAgentBusy(tracked: ReadonlyMap<WorkspacePath, TrackedWorkspace>): boolean {
  let hasBusy = false;
  for (const workspace of tracked.values()) {
    if (workspace.counts.idle > 0) return false;
    if (workspace.counts.busy > 0) hasBusy = true;
  }
  return hasBusy;
}

// =============================================================================
// Dependencies
// =============================================================================

export interface OsNotificationModuleDeps {
  readonly osNotificationLayer: OsNotificationBoundary;
  readonly windowManager: Pick<WindowManager, "isFocused" | "focus">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly configService: Config;
  readonly logger: Logger;
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create the OS notification module, registering its `notification` config key.
 *
 * @param deps - Boundary, window, dispatcher and config dependencies
 * @returns IntentModule with event subscriptions and a shutdown hook
 */
export function createOsNotificationModule(deps: OsNotificationModuleDeps): IntentModule {
  const { osNotificationLayer, windowManager, dispatcher, logger } = deps;

  // Read through the accessor on every transition rather than caching it:
  // flipping the setting then takes effect on the very next idle agent.
  const modeConfig = deps.configService.register<NotificationMode>("notification", {
    default: "first-workspace",
    description:
      "When to notify while CodeHydra is in the background: disabled|each-workspace|first-workspace",
    applies: "live",
    ...storeEnum(NOTIFICATION_MODES),
  });

  /** Workspace state as of its previous status report — the "before" side. */
  const tracked = new Map<WorkspacePath, TrackedWorkspace>();

  function notify(workspacePath: WorkspacePath, workspaceName: string): void {
    osNotificationLayer.show({
      title: NOTIFICATION_TITLE,
      body: workspaceName,
      onClick: () => {
        // Being told which workspace finished is only useful if getting there
        // is one click rather than a hunt through the sidebar — so come to the
        // front *and* land on it.
        windowManager.focus();
        void dispatcher
          .dispatch<SwitchWorkspaceIntent>({
            type: INTENT_SWITCH_WORKSPACE,
            payload: { workspacePath, focus: true },
          })
          .catch((error: unknown) => {
            logger.warn("Failed to switch to workspace from notification click", {
              workspacePath,
              error: getErrorMessage(error),
            });
          });
      },
    });
    logger.debug("Idle-agent notification shown", { workspaceName });
  }

  const events: EventDeclarations = {
    [EVENT_AGENT_STATUS_UPDATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspace, status } = (event as AgentStatusUpdatedEvent).payload;
        const path = workspace.path as WorkspacePath;

        const previous = tracked.get(path);
        // Both questions are about the world *before* this report, so ask them
        // while the map still describes it.
        const idleIncrease = isIdleIncrease(previous?.counts, status.counts);
        const everyAgentWasBusy = wasEveryAgentBusy(tracked);

        tracked.set(path, { counts: { ...status.counts } });

        if (!idleIncrease) return;

        const mode = modeConfig.get();
        if (mode === "disabled") return;
        // Notifying about a window the user is already looking at is exactly
        // the noise this feature exists to remove. Sampled now, not earlier:
        // focus can change between reports.
        if (windowManager.isFocused()) return;
        if (mode === "first-workspace" && !everyAgentWasBusy) return;

        notify(path, workspace.name);
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        tracked.delete(workspacePath as WorkspacePath);
      },
    },
  };

  return {
    name: "os-notification",
    events,
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            osNotificationLayer.closeAll();
          },
        },
      },
    },
  };
}
