/**
 * FrameWatchdogModule - Reloads a workspace frame whose IDE went away on its own.
 *
 * A workspace's IDE can shut down while its iframe stays mounted: the workbench
 * ends its own lifecycle, or the frame navigates off the workbench. The frame
 * then shows a blank page that still answers the renderer's liveness probe, so
 * nothing else notices (PostHog issue 01a08399). What does notice is the
 * sidekick: the workbench's extension host goes with it, and its socket drops.
 *
 * So the signal is a sidekick disconnect that we did not cause and that is not
 * followed by a reconnect. A reload-window or an extension-host restart
 * reconnects within seconds; a dead workbench never does. After the grace
 * period the frame is reloaded — once. If that does not bring the sidekick
 * back either, the IDE end is broken in a way a reload cannot fix, and
 * reloading again would only loop.
 *
 * Subscribes to:
 * - plugin transport connect/disconnect (not intents: the sidekick socket is
 *   the only witness, and it lives in the plugin server)
 * - ide-server:restarted / ide-server:sessions-stale: those already reload
 *   every frame, so pending verdicts are dropped rather than reloading twice
 *
 * Hooks:
 * - app-shutdown/stop: unsubscribes and clears timers
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE } from "../intents/app-resume";
import type { Logger } from "../boundaries/platform/logging";
import type { WorkspaceDisconnect } from "./plugin-server-module";
import type { UiPresenter } from "./presentation/presentation-module";

/**
 * How long a sidekick gets to reconnect before its frame is judged dead, and
 * again after the reload before the watchdog gives up. A reload-window or an
 * extension-host restart reconnects in a few seconds; a cold workbench load on
 * a busy machine can take longer, so this leaves room.
 */
export const RECONNECT_GRACE_MS = 15_000;

interface WatchdogTransport {
  onWorkspaceConnected(listener: (workspacePath: string) => void): () => void;
  onWorkspaceDisconnected(listener: (disconnect: WorkspaceDisconnect) => void): () => void;
}

export interface FrameWatchdogModuleDeps {
  readonly transport: WatchdogTransport;
  readonly frames: Pick<UiPresenter, "reloadFrame">;
  readonly logger: Logger;
}

/** One workspace waiting on its sidekick, before or after its frame was reloaded. */
interface Watch {
  readonly phase: "waiting" | "reloaded";
  readonly reason: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createFrameWatchdogModule(deps: FrameWatchdogModuleDeps): IntentModule {
  const { transport, frames, logger } = deps;
  const watches = new Map<string, Watch>();

  function forget(workspacePath: string): Watch | undefined {
    const watch = watches.get(workspacePath);
    if (watch) {
      clearTimeout(watch.timer);
      watches.delete(workspacePath);
    }
    return watch;
  }

  function forgetAll(): void {
    for (const workspacePath of [...watches.keys()]) forget(workspacePath);
  }

  function arm(workspacePath: string, phase: Watch["phase"], reason: string): void {
    const timer = setTimeout(() => {
      watches.delete(workspacePath);
      if (phase === "waiting") {
        judgeDead(workspacePath, reason);
      } else {
        logger.warn("Workspace IDE still disconnected after reloading its frame; leaving it", {
          workspace: workspacePath,
          reason,
        });
      }
    }, RECONNECT_GRACE_MS);
    watches.set(workspacePath, { phase, reason, timer });
  }

  function judgeDead(workspacePath: string, reason: string): void {
    // The presenter decides whether there is a frame at all: one hibernated,
    // released for deletion, or closed since the disconnect has nothing to
    // reload, and its IDE is supposed to be gone.
    if (!frames.reloadFrame(workspacePath)) {
      logger.debug("Workspace IDE disconnected but its frame is gone; nothing to reload", {
        workspace: workspacePath,
        reason,
      });
      return;
    }
    logger.warn("Workspace IDE disconnected and did not come back; reloaded its frame", {
      workspace: workspacePath,
      reason,
      graceMs: RECONNECT_GRACE_MS,
    });
    arm(workspacePath, "reloaded", reason);
  }

  const unsubscribes = [
    transport.onWorkspaceDisconnected(({ workspacePath, reason, initiatedByUs }) => {
      forget(workspacePath);
      // Our own hang-ups (hibernate, delete, project close, quit) mean the IDE
      // is meant to be gone.
      if (initiatedByUs) return;
      arm(workspacePath, "waiting", reason);
    }),
    transport.onWorkspaceConnected((workspacePath) => {
      const watch = forget(workspacePath);
      if (watch?.phase === "reloaded") {
        logger.info("Workspace IDE reconnected after its frame was reloaded", {
          workspace: workspacePath,
        });
      }
    }),
  ];

  return {
    name: "frame-watchdog",
    events: {
      // Both already reload every frame; a verdict pending here would only
      // reload one of them a second time.
      [EVENT_IDE_SERVER_RESTARTED]: {
        handler: async (): Promise<void> => {
          forgetAll();
        },
      },
      [EVENT_IDE_SERVER_SESSIONS_STALE]: {
        handler: async (): Promise<void> => {
          forgetAll();
        },
      },
    },
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            for (const unsubscribe of unsubscribes) unsubscribe();
            forgetAll();
          },
        },
      },
    },
  };
}
