// @vitest-environment node
/**
 * Integration tests for the process monitor: scans through a behavioral
 * ProcessRunner mock, the workspaces from a project:list dispatch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import type { ProcessSnapshot, ProcessSnapshotEntry } from "../../boundaries/platform/process";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { HookContext } from "../../intents/lib/operation";
import type { WorkspaceRef } from "../../intents/contract";
import { createProcessMonitorModule } from "./process-monitor-module";

const APP_PID = 1;
const ALPHA = "ch::m::p::alpha" as WorkspaceRef;
const BETA = "ch::m::p::beta" as WorkspaceRef;
const POLL_MS = 3000;

function proc(pid: number, ppid: number, cwd: string | null, cpuTimeMs = 0): ProcessSnapshotEntry {
  return {
    pid,
    ppid,
    name: `p${pid}`,
    commandLine: `p${pid}`,
    cwd,
    rssBytes: 1024 * pid,
    cpuTimeMs,
    startedAt: 1000,
    envValue: null,
  };
}

function createSetup(options: { failScan?: boolean } = {}) {
  /** The machine as the next scan sees it. */
  let machine: ProcessSnapshotEntry[] = [proc(10, 2, "/ws/alpha"), proc(11, 10, "/tmp")];
  let failScan = options.failScan ?? false;
  let scans = 0;
  /** Each process's environment, which the scan reads only the asked-for variable of. */
  let environments: Record<number, Record<string, string>> = {};
  const runner = createMockProcessRunner({
    processes: (scanOptions): ProcessSnapshot | null => {
      scans++;
      if (failScan) return null;
      const envVar = scanOptions?.envVar;
      return {
        takenAt: Date.now(),
        processes: machine.map((entry) => ({
          ...entry,
          envValue: envVar === undefined ? null : (environments[entry.pid]?.[envVar] ?? null),
        })),
      };
    },
    listeningPorts: { 11: [5173] },
  });
  const dispatch = vi.fn(async (intent: { type: string }) => {
    expect(intent.type).toBe(INTENT_LIST_PROJECTS);
    return [
      {
        workspaces: [
          { ref: ALPHA, path: "/ws/alpha" },
          { ref: BETA, path: "/ws/beta" },
        ],
      },
    ];
  });
  const monitor = createProcessMonitorModule({
    processRunner: runner,
    dispatcher: { dispatch } as never,
    logger: SILENT_LOGGER,
    appPid: APP_PID,
    timing: { pollIntervalMs: POLL_MS, primeDelayMs: 500 },
  });
  return {
    monitor,
    get scans() {
      return scans;
    },
    setMachine(next: ProcessSnapshotEntry[]) {
      machine = next;
    },
    setEnvironments(next: Record<number, Record<string, string>>) {
      environments = next;
    },
    setFailing(next: boolean) {
      failScan = next;
    },
    start: () =>
      monitor.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} }),
    shutdown: () => monitor.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({} as HookContext),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Await a list() whose scan waits on (fake) timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

describe("process monitor: workspace.processes", () => {
  it("lists a workspace's processes as a tree, with ports, primed for CPU", async () => {
    const setup = createSetup();

    const result = await settle(setup.monitor.list(ALPHA));

    // No baseline yet: a priming scan, then the real one.
    expect(setup.scans).toBe(2);
    expect(result!.total).toMatchObject({ count: 2, rssBytes: 1024 * 21 });
    expect(result!.processes).toHaveLength(1);
    const [shell] = result!.processes;
    expect(shell).toMatchObject({ pid: 10, cpuPercent: 0, subtree: { count: 2 } });
    expect(shell!.children[0]).toMatchObject({ pid: 11, ports: [5173], cwd: "/tmp" });
  });

  it("keeps a terminal that cd'd out of the worktree, by its _CH_WORKSPACE", async () => {
    const setup = createSetup();
    // A shell under the IDE's shared pty host (in no worktree), now in /home.
    setup.setMachine([proc(5, APP_PID, "/opt/ide"), proc(20, 5, "/home")]);
    setup.setEnvironments({ 20: { _CH_WORKSPACE: BETA } });

    const result = await settle(setup.monitor.list(BETA));

    expect(result!.processes.map((process) => process.pid)).toEqual([20]);
  });

  it("answers an empty list for a workspace running nothing", async () => {
    const setup = createSetup();
    const result = await settle(setup.monitor.list(BETA));
    expect(result).toMatchObject({ total: { count: 0 }, processes: [] });
  });

  it("measures CPU against the priming scan", async () => {
    const setup = createSetup();
    setup.setMachine([proc(10, 2, "/ws/alpha")]);
    const pending = setup.monitor.list(ALPHA);
    // The priming scan saw 0 ms; the real one, 500 ms later, sees 250 ms.
    setup.setMachine([proc(10, 2, "/ws/alpha", 250)]);
    const result = await settle(pending);
    expect(result!.processes[0]!.cpuPercent).toBe(50);
  });

  it("reuses a scan from a moment ago and shares one in flight", async () => {
    const setup = createSetup();
    const [first, second] = await settle(
      Promise.all([setup.monitor.list(ALPHA), setup.monitor.list(BETA)])
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(setup.scans).toBe(2);

    await setup.monitor.list(ALPHA);
    expect(setup.scans).toBe(2);
  });

  it("answers null when the scan fails", async () => {
    const setup = createSetup({ failScan: true });
    expect(await settle(setup.monitor.list(ALPHA))).toBeNull();
  });
});

describe("process monitor: sidebar polling", () => {
  it("scans nothing until watched", async () => {
    const setup = createSetup();
    await setup.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(setup.scans).toBe(0);
    expect(setup.monitor.summaries().size).toBe(0);
  });

  it("publishes each workspace's totals every interval while watched", async () => {
    const setup = createSetup();
    const notified = vi.fn();
    setup.monitor.onSummaries(notified);
    await setup.start();

    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.monitor.summaries().get(ALPHA)).toMatchObject({ count: 2 });
    expect(setup.monitor.summaries().has(BETA)).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);

    setup.setMachine([proc(10, 2, "/ws/alpha"), proc(30, 2, "/ws/beta")]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(setup.monitor.summaries().get(ALPHA)).toMatchObject({ count: 1 });
    expect(setup.monitor.summaries().get(BETA)).toMatchObject({ count: 1 });
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("waits for app:started before the first scan", async () => {
    const setup = createSetup();
    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(setup.scans).toBe(0);

    await setup.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.scans).toBeGreaterThan(0);
  });

  it("stops scanning and clears the totals when no longer watched", async () => {
    const setup = createSetup();
    await setup.start();
    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.monitor.summaries().size).toBe(1);

    setup.monitor.setWatching(false);
    const scans = setup.scans;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(setup.scans).toBe(scans);
    expect(setup.monitor.summaries().size).toBe(0);
  });

  it("keeps the last totals through a failed scan", async () => {
    const setup = createSetup();
    await setup.start();
    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(1000);

    setup.setFailing(true);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(setup.monitor.summaries().get(ALPHA)).toMatchObject({ count: 2 });
  });

  it("stops at app shutdown", async () => {
    const setup = createSetup();
    await setup.start();
    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(1000);

    await setup.shutdown();
    const scans = setup.scans;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(setup.scans).toBe(scans);
  });
});

describe("process monitor: CodeHydra's totals", () => {
  it("publishes the app's tree and every workspace's processes while watched, none after", async () => {
    const setup = createSetup();
    // The app (pid 1) with an IDE server (2) and a terminal (3) in alpha, plus
    // an orphan of beta's that left the app's tree.
    setup.setMachine([
      proc(APP_PID, 0, "/"),
      proc(2, APP_PID, "/"),
      proc(3, APP_PID, "/ws/alpha"),
      proc(40, 0, "/ws/beta"),
      proc(50, 0, "/home"),
    ]);
    await setup.start();
    expect(setup.monitor.totals()).toBeNull();

    setup.monitor.setWatching(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.monitor.totals()).toMatchObject({
      all: { count: 4 },
      workspaces: { count: 2, rssBytes: 1024 * (3 + 40) },
      codehydra: { count: 2, rssBytes: 1024 * (APP_PID + 2) },
    });

    setup.monitor.setWatching(false);
    expect(setup.monitor.totals()).toBeNull();
  });
});

describe("process monitor: teardownProcesses", () => {
  const alpha = { ref: ALPHA, path: "/ws/alpha" };

  it("answers from a fresh scan: what the workspace started, wherever it runs", async () => {
    const setup = createSetup();
    setup.setMachine([
      proc(APP_PID, 0, "/"),
      proc(10, APP_PID, "/ws/alpha"),
      proc(20, 0, "/srv"), // a detached dev server
      proc(30, 0, "/ws/alpha/pkg"), // beta's build in alpha's worktree
    ]);
    setup.setEnvironments({ 20: { _CH_WORKSPACE: ALPHA }, 30: { _CH_WORKSPACE: BETA } });

    await expect(setup.monitor.teardownProcesses(alpha, { cwdInside: false })).resolves.toEqual([
      { pid: 10, name: "p10" },
      { pid: 20, name: "p20" },
    ]);
    await expect(setup.monitor.teardownProcesses(alpha, { cwdInside: true })).resolves.toEqual([
      { pid: 10, name: "p10" },
      { pid: 20, name: "p20" },
      { pid: 30, name: "p30" },
    ]);
    // Two calls, two scans: never a cached one.
    expect(setup.scans).toBe(2);
  });

  it("still knows a workspace already gone from the project list", async () => {
    const setup = createSetup();
    setup.setMachine([proc(APP_PID, 0, "/"), proc(10, APP_PID, "/ws/gone")]);
    const gone = { ref: "ch::m::p::gone" as WorkspaceRef, path: "/ws/gone" };

    await expect(setup.monitor.teardownProcesses(gone, { cwdInside: false })).resolves.toEqual([
      { pid: 10, name: "p10" },
    ]);
  });

  it("is null when the scan failed, or saw nothing (not even the app)", async () => {
    const setup = createSetup({ failScan: true });
    await expect(setup.monitor.teardownProcesses(alpha, { cwdInside: true })).resolves.toBeNull();

    setup.setFailing(false);
    setup.setMachine([]);
    await expect(setup.monitor.teardownProcesses(alpha, { cwdInside: true })).resolves.toBeNull();
  });
});
