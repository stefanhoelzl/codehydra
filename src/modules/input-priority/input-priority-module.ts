/**
 * InputPriorityModule — keeps typing in workspace terminals responsive when the
 * machine is overloaded (Windows).
 *
 * Every process a keystroke passes through (input-path.ts) runs at normal
 * priority, like the builds and agents loading the machine. With far more
 * demand than cores, each of them waits its turn on every key, and the waits
 * add up to seconds. Raising them to above normal puts the keystroke path ahead
 * of that load; what a shell or agent starts stays at normal priority, because
 * Windows does not pass a raised priority on.
 *
 * Terminals come and go, so the module looks again every SCAN_INTERVAL_MS
 * (a chained timer: a slow scan never stacks) and raises every keystroke-path
 * process it finds, again each time — cheap, and it undoes the renderer being
 * set back by Chromium. Raising is one way: a process stays raised until it
 * exits, so turning `terminal.priority-boost` off applies after a restart.
 *
 * Windows only (`ProcessRunner.increasePriority` can raise nothing elsewhere).
 * Starts on app:started, stops at app:shutdown.
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Config } from "../../boundaries/platform/config";
import { storeBoolean } from "../../boundaries/platform/store-definition";
import { defineEvents, defineHooks } from "../../intents/declarations";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { getErrorMessage } from "../../shared/error-utils";
import { inputPathPids } from "./input-path";

/** Gap between the end of one scan and the start of the next. */
export const SCAN_INTERVAL_MS = 5000;

export interface InputPriorityModuleDeps {
  readonly processRunner: Pick<ProcessRunner, "listProcesses" | "increasePriority">;
  readonly configService: Config;
  readonly logger: Logger;
  readonly platform: NodeJS.Platform;
  /** CodeHydra's own pid: only its descendants are raised. */
  readonly appPid: number;
  /** Overrides for tests. */
  readonly timing?: { readonly scanIntervalMs?: number };
}

export function createInputPriorityModule(deps: InputPriorityModuleDeps): IntentModule {
  const boostConfig = deps.configService.register("terminal.priority-boost", {
    default: true,
    description:
      "Windows: run the processes terminal typing passes through at above-normal priority, so it stays responsive under heavy load",
    ...storeBoolean(),
  });
  const scanIntervalMs = deps.timing?.scanIntervalMs ?? SCAN_INTERVAL_MS;

  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** `pid:startedAt` of every process raised so far: each is logged once. */
  const raised = new Set<string>();

  async function scan(): Promise<void> {
    const snapshot = await deps.processRunner.listProcesses();
    if (snapshot === null || stopped) return;
    const entries = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
    for (const pid of inputPathPids(snapshot.processes, deps.appPid)) {
      if (!deps.processRunner.increasePriority(pid)) continue;
      const entry = entries.get(pid);
      const identity = `${pid}:${entry?.startedAt ?? "?"}`;
      if (raised.has(identity)) continue;
      raised.add(identity);
      deps.logger.debug("Raised process priority", { pid, name: entry?.name ?? "?" });
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, scanIntervalMs);
  }

  async function tick(): Promise<void> {
    try {
      await scan();
    } catch (error) {
      deps.logger.warn("Input priority scan failed", { error: getErrorMessage(error) });
    }
    scheduleNext();
  }

  const hooks = defineHooks({
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: {
        handler: async () => {
          stopped = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        },
      },
    },
  });

  const events = defineEvents({
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        if (started || stopped) return;
        started = true;
        if (deps.platform !== "win32" || !boostConfig.get()) return;
        deps.logger.info("Raising terminal input priority", { intervalMs: scanIntervalMs });
        void tick();
      },
    },
  });

  return { name: "input-priority", hooks, events };
}
