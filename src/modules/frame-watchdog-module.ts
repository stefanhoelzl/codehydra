/**
 * FrameWatchdogModule - Reloads workspace frames that stopped showing a workbench.
 *
 * Two ways a mounted frame goes blank, each with its own witness.
 *
 * **Its renderer process died.** All workspace iframes are same-site (the one
 * IDE server port), so Chromium hosts them in one shared renderer process,
 * separate from the UI page's. When it dies every workbench blanks at once, and
 * Electron emits nothing for a subframe process (PostHog issue 019fb265). The
 * frames' main-process objects do report themselves destroyed, so this module
 * polls for that (`getDeadFrameIds`) and, on any dead frame, reloads every
 * frame: they shared the process, so one dead frame means all of them, and a
 * reload is cheap because the workbench session lives on the IDE server. Each
 * dead frame is reloaded once; one still dead a grace period later is logged,
 * not retried, so a reload that cannot help never loops.
 *
 * **Its IDE went away on its own.** The workbench ends its own lifecycle, or
 * the frame navigates off the workbench. The frame then shows a blank page in a
 * live process, so the poll above cannot see it (PostHog issue 01a08399). What
 * does notice is the sidekick: the workbench's extension host goes with it, and
 * its socket drops.
 *
 * So the signal is a sidekick disconnect that we did not cause and that is not
 * followed by a reconnect. A reload-window or an extension-host restart
 * reconnects within seconds; a dead workbench never does. After the grace
 * period the frame is reloaded — once. If that does not bring the sidekick
 * back either, the IDE end is broken in a way a reload cannot fix, and
 * reloading again would only loop.
 *
 * Subscribes to:
 * - API server transport connect/disconnect (not intents: the sidekick socket is
 *   the only witness, and it lives in the API server)
 * - ide-server:restarted / ide-server:sessions-stale: those already reload
 *   every frame, so pending verdicts are dropped rather than reloading twice
 *
 * Hooks:
 * - app-start/start: starts the renderer poll
 * - app-shutdown/stop: unsubscribes, stops the poll and clears timers
 */

import type { WorkspaceRef } from "../intents/contract";
import type { IntentModule } from "../intents/lib/module";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE } from "../intents/app-resume";
import type { Logger } from "../boundaries/platform/logging";
import type { WorkspaceDisconnect } from "./api-server-module";
import type { UiPresenter } from "./presentation/presentation-module";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";

/**
 * How long a sidekick gets to reconnect before its frame is judged dead, and
 * again after the reload before the watchdog gives up. A reload-window or an
 * extension-host restart reconnects in a few seconds; a cold workbench load on
 * a busy machine can take longer, so this leaves room.
 */
export const RECONNECT_GRACE_MS = 15_000;

/**
 * How often the workspace frames' renderer process is checked. The read is a
 * main-process property access per frame, with no round trip to any renderer.
 */
export const RENDERER_POLL_MS = 2_000;

interface WatchdogTransport {
  onWorkspaceConnected(listener: (workspaceRef: WorkspaceRef) => void): () => void;
  onWorkspaceDisconnected(listener: (disconnect: WorkspaceDisconnect) => void): () => void;
}

export interface FrameWatchdogModuleDeps {
  readonly transport: WatchdogTransport;
  readonly frames: Pick<UiPresenter, "reloadFrame">;
  readonly renderer: Pick<IViewManager, "getDeadFrameIds" | "reloadFrames">;
  readonly logger: Logger;
}

/** One workspace waiting on its sidekick, before or after its frame was reloaded. */
interface Watch {
  readonly phase: "waiting" | "reloaded";
  readonly reason: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createFrameWatchdogModule(deps: FrameWatchdogModuleDeps): IntentModule {
  const { transport, frames, renderer, logger } = deps;
  const watches = new Map<WorkspaceRef, Watch>();

  /**
   * Dead frames already reloaded, by frame id. A reloaded frame keeps reading
   * dead until its new page commits, so one is only reported once it has
   * stayed dead past the grace period, and then only once. An id leaves when
   * its frame is alive again or gone (hibernated, deleted).
   */
  const revived = new Map<number, { readonly reloadedAt: number; reported: boolean }>();

  function pollRenderer(): void {
    const dead = new Set(renderer.getDeadFrameIds());
    for (const id of [...revived.keys()]) {
      if (!dead.has(id)) revived.delete(id);
    }

    const now = Date.now();
    const stuck = [...revived.values()].filter(
      (entry) => !entry.reported && now - entry.reloadedAt >= RECONNECT_GRACE_MS
    );
    for (const entry of stuck) entry.reported = true;
    if (stuck.length > 0) {
      logger.warn("Workspace frames still dead after reloading them; leaving them", {
        frames: stuck.length,
        graceMs: RECONNECT_GRACE_MS,
      });
    }

    const newlyDead = [...dead].filter((id) => !revived.has(id));
    if (newlyDead.length === 0) return;
    for (const id of newlyDead) revived.set(id, { reloadedAt: now, reported: false });
    logger.warn("Workspace renderer process died; reloading every workspace frame", {
      deadFrames: dead.size,
    });
    renderer.reloadFrames();
  }

  // Armed at app:start → start: no timer may run during the synchronous
  // startup phases (AsyncWatcher), and there are no frames before then anyway.
  let rendererPoll: ReturnType<typeof setInterval> | undefined = undefined;

  function forget(workspaceRef: WorkspaceRef): Watch | undefined {
    const watch = watches.get(workspaceRef);
    if (watch) {
      clearTimeout(watch.timer);
      watches.delete(workspaceRef);
    }
    return watch;
  }

  function forgetAll(): void {
    for (const workspaceRef of [...watches.keys()]) forget(workspaceRef);
  }

  function arm(workspaceRef: WorkspaceRef, phase: Watch["phase"], reason: string): void {
    const timer = setTimeout(() => {
      watches.delete(workspaceRef);
      if (phase === "waiting") {
        judgeDead(workspaceRef, reason);
      } else {
        logger
          .scoped({ workspace: workspaceRef })
          .warn("Workspace IDE still disconnected after reloading its frame; leaving it", {
            reason,
          });
      }
    }, RECONNECT_GRACE_MS);
    watches.set(workspaceRef, { phase, reason, timer });
  }

  function judgeDead(workspaceRef: WorkspaceRef, reason: string): void {
    // The presenter decides whether there is a frame at all: one hibernated,
    // released for deletion, or closed since the disconnect has nothing to
    // reload, and its IDE is supposed to be gone.
    if (!frames.reloadFrame(workspaceRef)) {
      logger
        .scoped({ workspace: workspaceRef })
        .debug("Workspace IDE disconnected but its frame is gone; nothing to reload", { reason });
      return;
    }
    logger
      .scoped({ workspace: workspaceRef })
      .warn("Workspace IDE disconnected and did not come back; reloaded its frame", {
        reason,
        graceMs: RECONNECT_GRACE_MS,
      });
    arm(workspaceRef, "reloaded", reason);
  }

  const unsubscribes = [
    transport.onWorkspaceDisconnected(({ workspaceRef, reason, initiatedByUs }) => {
      forget(workspaceRef);
      // Our own hang-ups (hibernate, delete, project close, quit) mean the IDE
      // is meant to be gone.
      if (initiatedByUs) return;
      arm(workspaceRef, "waiting", reason);
    }),
    transport.onWorkspaceConnected((workspaceRef) => {
      const watch = forget(workspaceRef);
      if (watch?.phase === "reloaded") {
        logger
          .scoped({ workspace: workspaceRef })
          .info("Workspace IDE reconnected after its frame was reloaded");
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
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            rendererPoll ??= setInterval(pollRenderer, RENDERER_POLL_MS);
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            for (const unsubscribe of unsubscribes) unsubscribe();
            clearInterval(rendererPoll);
            rendererPoll = undefined;
            forgetAll();
          },
        },
      },
    },
  };
}
