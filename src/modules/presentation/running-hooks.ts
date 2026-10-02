/**
 * Running plugin hooks, and the Cancel each one is offered.
 *
 * The plugin module registers every blocking hook for the length of its process
 * (`track`). An `open` hook's Cancel lives on the loading surface — the startup
 * screen or the active workspace's loading panel, both projected by the startup
 * surface from `openHooks()` — or, when no loading surface shows it, on a sidebar
 * notification this collaborator reconciles. A `delete` hook's Cancel lives on
 * the deletion panel, which calls `cancelFor`.
 */

import type { WorkspaceRef } from "../../intents/contract";
import type { NotificationConfig } from "../../shared/notification-types";
import type { NotificationManager } from "./sessions";

/**
 * A blocking plugin hook that is running, and how to stop it.
 *
 * Registered by the hooks module for the length of one process, so every
 * surface that could leave the user staring at a hook that never ends has a
 * Cancel to offer.
 */
export interface RunningHook {
  readonly workspaceRef: WorkspaceRef;
  readonly workspaceName: string;
  /** The hook's on-disk entry name — what the user sees. */
  readonly entry: string;
  /**
   * Where its Cancel lives. An `open` hook is offered on the loading surface
   * (the startup screen, the active workspace's loading panel) or, when none
   * shows it, on a sidebar notification. A `delete` hook is offered by the
   * deletion panel, which calls `cancelRunningHooks`.
   */
  readonly phase: "open" | "delete";
  /** Kill it. Idempotent; the run then fails as a canceled hook. */
  cancel(): void;
}

/** How long a background hook runs before it gets a notification. */
const HOOK_NOTIFICATION_DELAY_MS = 1500;

/** Everything known about one running hook. */
interface TrackedHook {
  readonly hook: RunningHook;
  /** The grace-period timer, until it fires (`open` hooks only). */
  timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Old enough for a notification. Most hooks finish in well under a second,
   * and a card per background creation that flashes and vanishes would be
   * noise; only one still running after the grace period gets a card.
   */
  notifiable: boolean;
  /** The sidebar card standing in for it while no loading surface shows it. */
  cardId: string | undefined;
}

export interface RunningHooksDeps {
  readonly notifications: Pick<NotificationManager, "show" | "showAndWait" | "close">;
  readonly scheduleUpdate: () => void;
  /** What a card calls the workspace's project. */
  readonly projectName: (workspaceRef: WorkspaceRef) => string;
}

export interface RunningHooks {
  /** Offer a Cancel for a running hook until the returned function is called. */
  track(hook: RunningHook): () => void;
  /** Cancel every running hook of a workspace (the deletion panel's Cancel). */
  cancelFor(workspaceRef: WorkspaceRef): void;
  /** Cancel one hook by its registration id (a loading surface's Cancel). */
  cancel(id: number): void;
  /** The running `open` hooks, by registration id. */
  openHooks(): Array<[number, RunningHook]>;
  /**
   * Give each running open hook that no loading surface shows (`covered` says
   * which are shown) a notification with its own Cancel — a background
   * creation, a wake or project open of a workspace that is not the active one.
   * Without it the hook could only be stopped by killing its process. Closes
   * the card of a hook that has become covered. Reconciled on every push.
   */
  reconcileNotifications(covered: (hook: RunningHook) => boolean): void;
}

export function createRunningHooks(deps: RunningHooksDeps): RunningHooks {
  const { notifications, scheduleUpdate } = deps;
  const hooks = new Map<number, TrackedHook>();
  let nextId = 0;

  function showCard(tracked: TrackedHook): string {
    const { hook } = tracked;
    const config: NotificationConfig = {
      type: "spinner",
      title: `Running ${hook.entry}`,
      message: `${hook.workspaceName} in ${deps.projectName(hook.workspaceRef)}`,
      actions: [{ id: "cancel", label: "Cancel", variant: "secondary" }],
    };
    // Open, then wait on that same card: the wait takes the card's only hold,
    // so `close` ends it, and a click answers it.
    const cardId = notifications.show({ config });
    void notifications.showAndWait({ config, id: cardId }, {}).then((choice) => {
      if (choice === "cancel") hook.cancel();
    });
    return cardId;
  }

  return {
    track(hook) {
      const id = nextId++;
      const tracked: TrackedHook = {
        hook,
        timer: undefined,
        notifiable: false,
        cardId: undefined,
      };
      if (hook.phase === "open") {
        tracked.timer = setTimeout(() => {
          tracked.timer = undefined;
          tracked.notifiable = true;
          scheduleUpdate();
        }, HOOK_NOTIFICATION_DELAY_MS);
      }
      hooks.set(id, tracked);
      scheduleUpdate();
      return () => {
        if (hooks.get(id) !== tracked) return;
        hooks.delete(id);
        clearTimeout(tracked.timer);
        // No-op when the user already dismissed the card.
        if (tracked.cardId !== undefined) notifications.close(tracked.cardId);
        scheduleUpdate();
      };
    },

    cancelFor(workspaceRef) {
      for (const { hook } of hooks.values()) {
        if (hook.workspaceRef === workspaceRef) hook.cancel();
      }
    },

    cancel(id) {
      hooks.get(id)?.hook.cancel();
    },

    openHooks() {
      const open: Array<[number, RunningHook]> = [];
      for (const [id, { hook }] of hooks) {
        if (hook.phase === "open") open.push([id, hook]);
      }
      return open;
    },

    reconcileNotifications(covered) {
      for (const tracked of hooks.values()) {
        if (tracked.hook.phase !== "open") continue;
        const isCovered = covered(tracked.hook);
        if (tracked.cardId !== undefined) {
          if (isCovered) {
            // No-op when the user already dismissed the card.
            notifications.close(tracked.cardId);
            tracked.cardId = undefined;
          }
          continue;
        }
        if (tracked.notifiable && !isCovered) tracked.cardId = showCard(tracked);
      }
    },
  };
}
