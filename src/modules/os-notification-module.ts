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
 * Tracks statuses through createWorkspaceStatusCache, like badge-module and
 * power-module; every question here is about the transition itself — which
 * workspace moved, and what its counts were beforehand — which the cache's
 * change callback carries.
 *
 * Distinct from clone-notification-module and error-notification-module, which
 * despite the name drive *sidebar* notifications through the presenter. This is
 * the only module that raises OS-level toasts.
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { AggregatedAgentStatus, InternalAgentCounts } from "../shared/ipc";
import type { WorkspaceRef } from "../intents/contract";
import { createWorkspaceStatusCache } from "./workspace-status-cache";
import { workspaceNameOf } from "../utils/ref";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "../intents/switch-workspace";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { OsNotificationBoundary } from "../boundaries/shell/os-notification";
import type { WindowManager } from "../boundaries/shell/window-manager";
import type { Config } from "../boundaries/platform/config";
import { storeEnum } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import { getErrorMessage } from "../shared/error-utils";
import { defineEvents, defineHooks } from "../intents/declarations";

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
 * @param counts - Every tracked workspace's counts as they were before the change
 */
export function wasEveryAgentBusy(counts: Iterable<InternalAgentCounts>): boolean {
  let hasBusy = false;
  for (const workspace of counts) {
    if (workspace.idle > 0) return false;
    if (workspace.busy > 0) hasBusy = true;
  }
  return hasBusy;
}

/**
 * The counts of every tracked workspace as they were before `changed` moved
 * from `previous` (undefined = it was not tracked).
 */
function countsBefore(
  statuses: ReadonlyMap<WorkspaceRef, AggregatedAgentStatus>,
  changed: WorkspaceRef,
  previous: AggregatedAgentStatus | undefined
): InternalAgentCounts[] {
  const counts: InternalAgentCounts[] = [];
  for (const [ref, status] of statuses) {
    if (ref !== changed) counts.push(status.counts);
  }
  if (previous !== undefined) counts.push(previous.counts);
  return counts;
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

  function notify(workspaceRef: WorkspaceRef, workspaceName: string): void {
    osNotificationLayer.show({
      title: NOTIFICATION_TITLE,
      body: workspaceName,
      onClick: () => {
        // Being told which workspace finished is only useful if getting there
        // is one click rather than a hunt through the sidebar — so come to the
        // front *and* land on it.
        windowManager.focus();
        void dispatcher
          .dispatch<SwitchWorkspaceIntent>(
            {
              type: INTENT_SWITCH_WORKSPACE,
              payload: { workspaceRef, focus: true },
            },
            { origin: "notification" }
          )
          .catch((error: unknown) => {
            logger
              .scoped({ workspace: workspaceRef })
              .warn("Failed to switch to workspace from notification click", {
                error: getErrorMessage(error),
              });
          });
      },
    });
    logger.debug("Idle-agent notification shown", { workspaceName });
  }

  function onStatusChange(
    ref: WorkspaceRef,
    previous: AggregatedAgentStatus | undefined,
    next: AggregatedAgentStatus | undefined
  ): void {
    if (next === undefined) return;
    // Both questions are about the world *before* this report.
    if (!isIdleIncrease(previous?.counts, next.counts)) return;

    const mode = modeConfig.get();
    if (mode === "disabled") return;
    // Notifying about a window the user is already looking at is exactly
    // the noise this feature exists to remove. Sampled now, not earlier:
    // focus can change between reports.
    if (windowManager.isFocused()) return;
    if (mode === "first-workspace" && !wasEveryAgentBusy(countsBefore(statuses, ref, previous))) {
      return;
    }

    notify(ref, workspaceNameOf(ref));
  }

  const { statuses, events } = createWorkspaceStatusCache(onStatusChange);

  return {
    name: "os-notification",
    events: defineEvents(events),
    hooks: defineHooks({
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            osNotificationLayer.closeAll();
          },
        },
      },
    }),
  };
}
