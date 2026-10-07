/**
 * PollModule — the app's one periodic timer for scripts.
 *
 * Every tick dispatches `poll:tick` (intents/poll-tick.ts): modules describe the
 * scripts they want run, this module runs them all at once and hands each result
 * back to its owner. Automations (plugin-module) and wakeup scripts
 * (wakeup-module) are its owners today.
 *
 * Timing: the first tick runs on `app:started`, once every saved project is open
 * — so hibernated workspaces are known. After that `poll.interval` seconds is
 * the gap between the END of one tick and the start of the next: a chained
 * timer, so a slow tick never stacks. The value is re-read when each wait is
 * armed, so a change applies once the current wait elapses.
 *
 * Failures are this module's to announce, for every owner alike:
 * - a run that did not exit 0 (a timeout after `poll.timeout`, or the job's
 *   own), a script that could not start, or errors its owner returned from
 *   "result" (output that does not parse, a refused item) fail the job;
 * - exit 75 (`EX_TEMPFAIL`) is a temporary failure: listed at once, raised as a
 *   card only once it has gone on for ten minutes;
 * - one card per distinct message — a job failing every tick raises one card,
 *   not one per tick — and the failure is forgotten when the job next succeeds,
 *   or is no longer collected (its automation removed, its workspace woken).
 *
 * Every run writes its own log file, judged after its owner has read it: a run
 * whose output its owner refused is logged with the failures.
 */

import type { Dispatcher } from "../intents/lib/dispatcher";
import type { IntentModule } from "../intents/lib/module";
import type { Config } from "../boundaries/platform/config";
import type { Logger } from "../boundaries/platform/logging-types";
import { storeNumber, type PersistedAccessor } from "../boundaries/platform/store-definition";
import { defineEvents, defineHooks } from "../intents/declarations";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import {
  INTENT_POLL_TICK,
  POLL_TICK_OPERATION_ID,
  type PollJob,
  type PollRun,
  type PollTickIntent,
} from "../intents/poll-tick";
import { notify } from "./presentation/notification-card";
import { Path } from "../utils/path/path";
import { getErrorMessage } from "../shared/error-utils";
import { describeStatus, type PendingRun, type ScriptRunner } from "./scripts/script-runner";
import { ShellUnavailableError } from "./scripts/shells";

/** Default gap between the end of one tick and the start of the next. */
const DEFAULT_INTERVAL_SECONDS = 60;
/** Default limit on one run. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * The exit a script uses to say "temporary, try again next tick" —
 * `EX_TEMPFAIL` from sysexits.h, as mail servers use it.
 */
export const TEMPORARY_FAILURE_EXIT = 75;

/** How long temporary failures may go on before they are worth a card. */
const TEMPORARY_FAILURE_GRACE_MS = 10 * 60_000;

/** One job's last failure. */
export interface PollError {
  readonly owner: string;
  readonly id: string;
  readonly source: string;
  readonly entry: string;
  readonly message: string;
  /** The failed run's log file (native path). */
  readonly logPath?: string;
  /** ISO time it was recorded. */
  readonly at: string;
}

export interface PollModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly config: Config;
  readonly logger: Logger;
  readonly runner: ScriptRunner;
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

export interface PollModule extends IntentModule {
  /** The jobs failing right now, optionally of one owner. */
  errors(owner?: string): readonly PollError[];
}

function jobKey(job: Pick<PollJob, "owner" | "id">): string {
  return JSON.stringify([job.owner, job.id]);
}

function notStarted(failure: string): PollRun {
  return {
    status: "not-started",
    exitCode: null,
    stdout: "",
    stderr: "",
    failure,
    temporary: false,
  };
}

export function createPollModule(deps: PollModuleDeps): PollModule {
  const now = deps.now ?? Date.now;

  const interval: PersistedAccessor<number> = deps.config.register("poll.interval", {
    default: DEFAULT_INTERVAL_SECONDS,
    description:
      "Seconds between the end of one poll (automations, wakeup scripts) and the start of the " +
      "next (a change applies after the current wait elapses)",
    applies: "live",
    ...storeNumber({ min: 1 }),
    legacyNames: Object.fromEntries(
      ["automations.poll-interval", "auto-workspace.poll-interval"].map((name) => [
        name,
        (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : undefined,
      ])
    ),
  });
  const timeout: PersistedAccessor<number> = deps.config.register("poll.timeout", {
    default: DEFAULT_TIMEOUT_SECONDS,
    description: "Seconds a poll script (automation, wakeup script) may run before it is killed",
    applies: "live",
    ...storeNumber({ min: 1 }),
  });

  // ---------------------------------------------------------------------------
  // Failures
  // ---------------------------------------------------------------------------

  const failures = new Map<string, PollError>();
  /** When each job's current run of temporary failures began. */
  const temporarySince = new Map<string, number>();
  /** Jobs reported in the tick in progress. */
  let reported = new Set<string>();

  function fail(job: PollJob, message: string, logPath?: Path, quiet = false): void {
    const key = jobKey(job);
    const previous = failures.get(key);
    const entry: PollError = {
      owner: job.owner,
      id: job.id,
      source: job.source,
      entry: job.entry,
      message,
      ...(logPath !== undefined && { logPath: logPath.toNative() }),
      at: new Date(now()).toISOString(),
    };
    failures.set(key, entry);
    if (quiet || previous?.message === message) return;
    notify(deps.dispatcher, {
      type: "error",
      title: job.failure.title,
      message: `${job.source} ${job.entry}: ${message} — ${job.failure.pointer}`,
      dismissible: true,
    });
  }

  /**
   * Exit 75: listed at once, raised as a card only once the failures have gone
   * on for the grace period — then as an ordinary `exit 75`, whose new message
   * is what raises the card.
   */
  function failTemporarily(job: PollJob, logPath?: Path): void {
    const key = jobKey(job);
    const since = temporarySince.get(key) ?? now();
    temporarySince.set(key, since);
    deps.logger.debug("Poll job failed temporarily, retrying next tick", {
      owner: job.owner,
      id: job.id,
    });
    if (now() - since >= TEMPORARY_FAILURE_GRACE_MS) {
      fail(job, `exit ${TEMPORARY_FAILURE_EXIT}`, logPath);
    } else {
      fail(job, `temporary failure (exit ${TEMPORARY_FAILURE_EXIT}), retrying`, logPath, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Running
  // ---------------------------------------------------------------------------

  /** Runs between "run" and "report", whose logs are written once judged. */
  const pending = new Map<string, PendingRun>();
  /** Aborted at shutdown: kills every running job and silences its report. */
  const shutdown = new AbortController();

  async function runJob(job: PollJob): Promise<PollRun> {
    let run: PendingRun;
    try {
      run = await deps.runner.run({
        source: job.source,
        entry: job.entry,
        shell: job.shell,
        script: job.script,
        cwd: new Path(job.cwd),
        input: job.input,
        logDir: new Path(job.logDir),
        ...(job.env !== undefined && { env: job.env }),
        ...(job.pluginDir !== undefined && { pluginDir: new Path(job.pluginDir) }),
        ...(job.workspaceDir !== undefined && { workspaceDir: new Path(job.workspaceDir) }),
        signal: shutdown.signal,
        timeoutMs: job.timeoutMs ?? timeout.get() * 1000,
      });
    } catch (error) {
      return notStarted(
        error instanceof ShellUnavailableError
          ? error.message
          : `could not start: ${getErrorMessage(error)}`
      );
    }
    pending.set(jobKey(job), run);

    const { result } = run;
    const ok = result.status === "exited" && result.exitCode === 0;
    const temporary = result.status === "exited" && result.exitCode === TEMPORARY_FAILURE_EXIT;
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      temporary,
      ...(!ok && {
        failure: temporary
          ? `temporary failure (exit ${TEMPORARY_FAILURE_EXIT})`
          : describeStatus(result),
      }),
    };
  }

  async function reportJob(job: PollJob, run: PollRun, errors: readonly string[]): Promise<void> {
    const key = jobKey(job);
    const finished = pending.get(key);
    pending.delete(key);
    const failure = run.failure ?? (errors.length > 0 ? errors.join("; ") : undefined);
    const logPath = await finished?.finish(
      failure === undefined ? { outcome: "ok" } : { outcome: "failed", reason: failure }
    );
    // A run killed by quitting failed for no reason of its own.
    if (shutdown.signal.aborted) return;
    reported.add(key);

    if (run.failure !== undefined && run.temporary) {
      failTemporarily(job, logPath);
      return;
    }
    temporarySince.delete(key);
    if (failure === undefined) {
      failures.delete(key);
      return;
    }
    deps.logger.warn("Poll job failed", { owner: job.owner, id: job.id, reason: failure });
    fail(job, failure, logPath);
  }

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------

  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  /** Interval the last wait was armed with, so a live change is logged once. */
  let armedSeconds: number | null = null;

  async function tick(): Promise<void> {
    reported = new Set();
    try {
      await deps.dispatcher.dispatch<PollTickIntent>({ type: INTENT_POLL_TICK, payload: {} });
    } catch (error) {
      deps.logger.warn("Poll tick failed", { error: getErrorMessage(error) });
      return;
    }
    if (stopped) return;
    // A job no longer collected (its automation removed, its workspace woken)
    // has nothing left to fail.
    for (const key of [...failures.keys()]) {
      if (!reported.has(key)) failures.delete(key);
    }
    for (const key of [...temporarySince.keys()]) {
      if (!reported.has(key)) temporarySince.delete(key);
    }
  }

  function scheduleNext(): void {
    if (stopped || timer) return;
    const seconds = interval.get();
    if (armedSeconds !== null && armedSeconds !== seconds) {
      deps.logger.info("Poll interval changed", { from: armedSeconds, to: seconds });
    }
    armedSeconds = seconds;
    timer = setTimeout(() => {
      timer = null;
      void tick().finally(scheduleNext);
    }, seconds * 1000);
  }

  function stop(): void {
    stopped = true;
    shutdown.abort();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const hooks = defineHooks({
    [POLL_TICK_OPERATION_ID]: {
      run: { handler: async (ctx) => ({ result: { run: await runJob(ctx.job) } }) },
      report: { handler: (ctx) => reportJob(ctx.job, ctx.run, ctx.errors) },
    },
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: { handler: async () => stop() },
    },
  });

  const events = defineEvents({
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        if (stopped || started) return;
        started = true;
        deps.logger.info("Polling started", { intervalSeconds: interval.get() });
        await tick();
        scheduleNext();
      },
    },
  });

  return {
    name: "poll",
    hooks,
    events,
    errors: (owner) =>
      [...failures.values()].filter((entry) => owner === undefined || entry.owner === owner),
  };
}
