/**
 * ProcessMonitorModule — which processes run in each workspace, with CPU,
 * memory and listening ports.
 *
 * One scan covers every workspace: an OS-wide process snapshot
 * (ProcessRunner.listProcesses), attributed to workspaces by their
 * `_CH_WORKSPACE` variable, working directory and ancestry (attribution.ts), then the listening ports of the
 * processes CodeHydra accounts for.
 *
 * A workspace's extension host has neither the variable nor a working
 * directory in the worktree; its sidekick names its pid when it connects
 * (`extensionHosts`). The pin holds while that pid is a child of the IDE
 * server with the start time first seen for it, so a reused pid never
 * inherits it.
 *
 * Four consumers:
 * - The sidebar's process summary (`sidebar.process-summary`, owned by the
 *   presenter): while it is on (`setWatching(true)`), a scan runs every
 *   POLL_INTERVAL_MS — a chained timer, so a slow scan never stacks — and the
 *   per-workspace totals are published (`summaries`, `onSummaries`), with the
 *   process bar's totals of everything CodeHydra accounts for (`totals`: its
 *   own process tree and every workspace's processes) and the trees
 *   (`trees`). Off, no timer runs and nothing is scanned.
 * - Hibernate and delete (`teardownProcesses`, the cleanup modules' release
 *   sweep): a fresh scan of its own each time, without CPU or ports.
 * - The sidebar tree's kill button (`killProcess`): a fresh scan, to check the
 *   process is still the one shown and still a workspace's.
 * - `workspace.processes` (`ch ws processes`, MCP): `list()` answers from a
 *   scan at most FRESH_MS old, joining one in flight rather than starting
 *   another. CPU is a rate, so a call with no recent scan to compare against
 *   takes one first and waits PRIME_DELAY_MS.
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
  codeHydraGroups,
  codeHydraTotals,
  cpuPercents,
  isPlausibleParent,
  killTargets,
  teardownProcesses,
  type CodeHydraGroup,
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
/** Wait after SIGTERM, and again after SIGKILL, when killing from the sidebar. */
const KILL_TIMEOUT_MS = 5_000;
/** Slack for an extension host's start against its sidekick's connect (whole-second start times). */
const START_TOLERANCE_MS = 1000;

/** An extension host's pid, as its sidekick named it, and when that sidekick connected (epoch ms). */
export interface ExtensionHostPid {
  readonly pid: number;
  readonly connectedAt: number;
}

export interface ProcessMonitorModuleDeps {
  readonly processRunner: Pick<ProcessRunner, "listProcesses" | "findListeningPorts" | "kill">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly logger: Logger;
  /** CodeHydra's own pid: attribution never inherits through it. */
  readonly appPid: number;
  /** The IDE server's pid while it runs: the root of the code server's processes. */
  readonly ideServerPid?: () => number | null;
  /**
   * Each workspace's extension host, as its sidekick last named it (kept
   * after a disconnect, so a teardown after the frame is gone still finds it).
   */
  readonly extensionHosts?: () => ReadonlyMap<WorkspaceRef, ExtensionHostPid>;
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
  /**
   * Every process CodeHydra accounts for as trees — each workspace's, the code
   * server's and the rest of CodeHydra's — from the last sidebar scan; null
   * while not watching.
   */
  trees(): ProcessTrees | null;
  /** Called after each sidebar scan, and when watching stops. */
  onSummaries(listener: () => void): Unsubscribe;
  /**
   * Stop a workspace's process, started at `startedAt` (ISO), and every
   * process below it in the same workspace. Checked against a fresh scan
   * first: false, and nothing killed, when it is gone, the pid now names
   * another process, or it belongs to no workspace. True once they are all
   * gone; false when one survived.
   */
  killProcess(pid: number, startedAt: string | null): Promise<boolean>;
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

/** Every process CodeHydra accounts for, as trees. */
export interface ProcessTrees {
  readonly workspaces: ReadonlyMap<WorkspaceRef, WorkspaceProcesses>;
  /** The code server's and the rest of CodeHydra's; a part with no process is absent. */
  readonly groups: ReadonlyMap<CodeHydraGroup, WorkspaceProcesses>;
}

interface Scan {
  readonly snapshot: ProcessSnapshot;
  readonly workspaces: ReadonlyMap<WorkspaceRef, WorkspaceProcesses>;
  readonly groups: ReadonlyMap<CodeHydraGroup, WorkspaceProcesses>;
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
  let trees: ProcessTrees | null = null;
  /** The last scan failed: logged once, again only after a success. */
  let failing = false;

  /**
   * The extension host pins that hold in `current`: the pid is a child of the
   * IDE server that started before its sidekick connected — a process reusing
   * the pid of one that exited started after.
   */
  function extensionHostPins(current: ProcessSnapshot): Map<number, WorkspaceRef> {
    const named = deps.extensionHosts?.() ?? new Map<WorkspaceRef, ExtensionHostPid>();
    const ideServerPid = deps.ideServerPid?.() ?? null;
    const byPid = new Map(current.processes.map((entry) => [entry.pid, entry]));
    const pins = new Map<number, WorkspaceRef>();
    for (const [ref, { pid, connectedAt }] of named) {
      const entry = byPid.get(pid);
      const parent = entry === undefined ? undefined : byPid.get(entry.ppid);
      if (entry === undefined || parent === undefined || parent.pid !== ideServerPid) continue;
      if (!isPlausibleParent(entry, parent)) continue;
      if (entry.startedAt !== null && entry.startedAt > connectedAt + START_TOLERANCE_MS) continue;
      pins.set(pid, ref);
    }
    return pins;
  }

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

    const owners = attributeProcesses(
      current.processes,
      known,
      deps.appPid,
      extensionHostPins(current)
    );
    const groups = codeHydraGroups(
      current.processes,
      owners,
      deps.appPid,
      deps.ideServerPid?.() ?? null
    );
    const cpu = cpuPercents(current, baseline);
    const ports = await deps.processRunner.findListeningPorts([...owners.keys(), ...groups.keys()]);
    const scan: Scan = {
      snapshot: current,
      workspaces: buildWorkspaceProcesses(current, owners, cpu, ports),
      groups: buildWorkspaceProcesses(current, groups, cpu, ports),
      totals: codeHydraTotals(current.processes, owners, groups, cpu),
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
      trees = { workspaces: scan.workspaces, groups: scan.groups };
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
      trees = null;
      for (const listener of listeners) listener();
    },

    trees: () => trees,

    async killProcess(pid, startedAt) {
      try {
        const [current, known] = await Promise.all([snapshot(), workspaces()]);
        if (current === null) return false;
        const owners = attributeProcesses(
          current.processes,
          known,
          deps.appPid,
          extensionHostPins(current)
        );
        const targets = killTargets(current.processes, owners, pid, startedAt, deps.appPid);
        if (targets.length === 0) {
          deps.logger.info("Not killing: no longer a workspace's process", { pid });
          return false;
        }
        deps.logger.info("Killing process from the sidebar", {
          pids: targets.map((target) => target.pid).join(","),
        });
        const results = await Promise.all(
          targets.map((target) =>
            deps.processRunner.kill(target.pid, KILL_TIMEOUT_MS, KILL_TIMEOUT_MS)
          )
        );
        const survived = results.some((result) => !result.success);
        if (survived) deps.logger.warn("A killed process survived", { pid });
        // Show the result without waiting for the next poll.
        if (watching && !stopped) void scanOnce().then(publish);
        return !survived;
      } catch (error) {
        deps.logger.warn("Killing a process failed", { pid, error: getErrorMessage(error) });
        return false;
      }
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
        const owners = attributeProcesses(
          current.processes,
          monitored,
          deps.appPid,
          extensionHostPins(current)
        );
        return teardownProcesses(current.processes, owners, workspace, deps.appPid, options);
      } catch (error) {
        deps.logger.warn("Process scan for teardown failed", { error: getErrorMessage(error) });
        return null;
      }
    },
  };
}
