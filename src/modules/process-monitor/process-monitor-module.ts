/**
 * ProcessMonitorModule — which processes run in each workspace, with CPU,
 * memory and listening ports.
 *
 * One scan covers every workspace: an OS-wide process snapshot
 * (ProcessRunner.listProcesses), attributed to workspaces by their
 * `_CH_WORKSPACE` variable, working directory and ancestry (attribution.ts), then the listening ports of the
 * attributed processes only.
 *
 * Three consumers, three rhythms:
 * - The sidebar's process summary (`sidebar.process-summary`, owned by the
 *   presenter): while it is on (`setWatching(true)`), a scan runs every
 *   POLL_INTERVAL_MS — a chained timer, so a slow scan never stacks — and the
 *   per-workspace totals are published (`summaries`, `onSummaries`), with the
 *   footer's totals of everything CodeHydra accounts for (`totals`: its own
 *   process tree and every workspace's processes). Off, no timer runs and
 *   nothing is scanned.
 * - Hibernate and delete (`teardownProcesses`, the cleanup modules' release
 *   sweep): a fresh scan of its own each time, without CPU or ports.
 * - `workspace.processes` (`ch ws processes`, MCP, the sidekick's Processes
 *   view): `list()` answers from a scan at most FRESH_MS old, joining one in
 *   flight rather than starting another. CPU is a rate, so a call with no
 *   recent scan to compare against takes one first and waits PRIME_DELAY_MS.
 *
 * Polling starts on app:started (every project is open, so every workspace is
 * known) and stops at app:shutdown.
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { ProcessRunner, ProcessSnapshot } from "../../boundaries/platform/process";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { WorkspaceRef } from "../../intents/contract";
import type {
  ProcessMonitorAccess,
  ProcessTotals,
  WorkspaceProcesses,
} from "../../api/entries/deps";
import { defineEvents, defineHooks } from "../../intents/declarations";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import { getErrorMessage } from "../../shared/error-utils";
import {
  attributeProcesses,
  buildWorkspaceProcesses,
  codeHydraTotals,
  cpuPercents,
  teardownProcesses,
  type CodeHydraTotals,
  type MonitoredWorkspace,
  type TeardownProcess,
  WORKSPACE_ENV_VAR,
} from "./attribution";

/** Gap between the end of one sidebar scan and the start of the next. */
export const POLL_INTERVAL_MS = 3000;
/** How old a scan `list()` may answer from. */
const FRESH_MS = 1500;
/** A previous scan older than this is too stale to compute CPU against. */
const CPU_BASELINE_MAX_AGE_MS = 30_000;
/** Wait between the priming scan and the real one, when CPU has no baseline. */
const PRIME_DELAY_MS = 500;

export interface ProcessMonitorModuleDeps {
  readonly processRunner: Pick<ProcessRunner, "listProcesses" | "findListeningPorts">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly logger: Logger;
  /** CodeHydra's own pid: attribution never inherits through it. */
  readonly appPid: number;
  /** Overrides for tests. */
  readonly timing?: {
    readonly pollIntervalMs?: number;
    readonly primeDelayMs?: number;
  };
}

export interface ProcessMonitorModule extends IntentModule, ProcessMonitorAccess {
  /** Each workspace's totals from the last sidebar scan; empty while not watching. */
  summaries(): ReadonlyMap<WorkspaceRef, ProcessTotals>;
  /**
   * Everything CodeHydra accounts for — its own process tree and every
   * workspace's processes — from the last sidebar scan; null while not watching.
   */
  totals(): CodeHydraTotals | null;
  /** Called after each sidebar scan, and when watching stops. */
  onSummaries(listener: () => void): Unsubscribe;
  /** Start or stop the sidebar's periodic scan. */
  setWatching(watching: boolean): void;
  /**
   * What tearing `workspace` down must stop, from a fresh scan (no CPU, no
   * ports): every process attributed to it and, with `cwdInside`, every process
   * whose working directory is in its worktree. Never the app or its
   * ancestors. Null when the scan failed.
   */
  teardownProcesses(
    workspace: MonitoredWorkspace,
    options: { readonly cwdInside: boolean }
  ): Promise<readonly TeardownProcess[] | null>;
}

interface Scan {
  readonly snapshot: ProcessSnapshot;
  readonly workspaces: ReadonlyMap<WorkspaceRef, WorkspaceProcesses>;
  readonly totals: CodeHydraTotals;
}

export function createProcessMonitorModule(deps: ProcessMonitorModuleDeps): ProcessMonitorModule {
  const pollIntervalMs = deps.timing?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const primeDelayMs = deps.timing?.primeDelayMs ?? PRIME_DELAY_MS;
  const listeners = new Set<() => void>();

  let watching = false;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The last snapshot taken, scan or priming: the baseline for CPU. */
  let previous: ProcessSnapshot | null = null;
  let lastScan: Scan | null = null;
  let inFlight: Promise<Scan | null> | null = null;
  let summaries = new Map<WorkspaceRef, ProcessTotals>();
  let totals: CodeHydraTotals | null = null;
  /** The last scan failed: logged once, again only after a success. */
  let failing = false;

  async function workspaces(): Promise<MonitoredWorkspace[]> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {} as Record<string, never>,
    });
    return (projects ?? []).flatMap((project) =>
      project.workspaces.map((workspace) => ({ ref: workspace.ref, path: workspace.path }))
    );
  }

  async function snapshot(): Promise<ProcessSnapshot | null> {
    const taken = await deps.processRunner.listProcesses({ envVar: WORKSPACE_ENV_VAR });
    if (taken === null) {
      if (!failing) deps.logger.warn("Process scan failed; will retry");
      failing = true;
    } else {
      failing = false;
    }
    return taken;
  }

  async function runScan(): Promise<Scan | null> {
    const baselineStale =
      previous === null || Date.now() - previous.takenAt > CPU_BASELINE_MAX_AGE_MS;
    if (baselineStale) {
      // CPU is a rate: without a recent snapshot there is nothing to compare
      // against, so take one now and the real one a moment later.
      previous = (await snapshot()) ?? previous;
      await new Promise((resolve) => setTimeout(resolve, primeDelayMs));
    }
    const [current, known] = await Promise.all([snapshot(), workspaces()]);
    if (current === null) return null;
    const baseline = previous;
    previous = current;

    const owners = attributeProcesses(current.processes, known, deps.appPid);
    const cpu = cpuPercents(current, baseline);
    const ports = await deps.processRunner.findListeningPorts([...owners.keys()]);
    const scan: Scan = {
      snapshot: current,
      workspaces: buildWorkspaceProcesses(current, owners, cpu, ports),
      totals: codeHydraTotals(current.processes, owners, cpu, deps.appPid),
    };
    lastScan = scan;
    return scan;
  }

  /** The running scan if there is one, else a new one. */
  function scanOnce(): Promise<Scan | null> {
    inFlight ??= runScan()
      .catch((error: unknown) => {
        deps.logger.warn("Process scan failed", { error: getErrorMessage(error) });
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function publish(scan: Scan | null): void {
    // A failed scan keeps the last totals: a blip should not blank the sidebar.
    if (scan !== null) {
      summaries = new Map([...scan.workspaces].map(([ref, entry]) => [ref, entry.total]));
      totals = scan.totals;
    }
    for (const listener of listeners) listener();
  }

  async function tick(): Promise<void> {
    const scan = await scanOnce();
    if (watching && !stopped) publish(scan);
  }

  function scheduleNext(): void {
    if (!watching || stopped || !started || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().finally(scheduleNext);
    }, pollIntervalMs);
  }

  function startPolling(): void {
    if (!watching || stopped || !started || timer !== null) return;
    void tick().finally(scheduleNext);
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const hooks = defineHooks({
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: {
        handler: async () => {
          stopped = true;
          stopPolling();
        },
      },
    },
  });

  const events = defineEvents({
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        if (started || stopped) return;
        started = true;
        startPolling();
      },
    },
  });

  return {
    name: "process-monitor",
    hooks,
    events,

    summaries: () => summaries,

    totals: () => totals,

    onSummaries(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setWatching(next) {
      if (next === watching) return;
      watching = next;
      if (watching) {
        deps.logger.info("Process monitoring started", { intervalMs: pollIntervalMs });
        startPolling();
        return;
      }
      deps.logger.info("Process monitoring stopped");
      stopPolling();
      summaries = new Map();
      totals = null;
      for (const listener of listeners) listener();
    },

    async list(workspace) {
      const recent = lastScan;
      const scan =
        recent !== null && Date.now() - recent.snapshot.takenAt <= FRESH_MS
          ? recent
          : await scanOnce();
      if (scan === null) return null;
      return (
        scan.workspaces.get(workspace) ?? {
          scannedAt: new Date(scan.snapshot.takenAt).toISOString(),
          total: { cpuPercent: 0, rssBytes: 0, count: 0 },
          processes: [],
        }
      );
    },

    async teardownProcesses(workspace, options) {
      try {
        // Always fresh: the shutdown just before it stopped (and started) things.
        const [current, known] = await Promise.all([snapshot(), workspaces()]);
        // The app is always running: a snapshot without it did not see the
        // machine, and "nothing to stop" from it would be a guess.
        if (current === null || !current.processes.some((entry) => entry.pid === deps.appPid)) {
          return null;
        }
        // A workspace being deleted may already be gone from the list.
        const monitored = known.some((entry) => entry.ref === workspace.ref)
          ? known
          : [...known, workspace];
        const owners = attributeProcesses(current.processes, monitored, deps.appPid);
        return teardownProcesses(current.processes, owners, workspace, deps.appPid, options);
      } catch (error) {
        deps.logger.warn("Process scan for teardown failed", { error: getErrorMessage(error) });
        return null;
      }
    },
  };
}
