// @vitest-environment node
/**
 * Focused tests for process attribution: which workspace each process belongs
 * to, CPU from two snapshots, and the per-workspace trees.
 */

import { describe, it, expect } from "vitest";
import type { ProcessSnapshot, ProcessSnapshotEntry } from "../../boundaries/platform/process";
import type { WorkspaceRef } from "../../intents/contract";
import { attributeProcesses, buildWorkspaceProcesses, cpuPercents } from "./attribution";

const APP = 100;
const ALPHA = "ch::m::p::alpha" as WorkspaceRef;
const BETA = "ch::m::p::beta" as WorkspaceRef;
const WORKSPACES = [
  { ref: ALPHA, path: "/ws/alpha" },
  { ref: BETA, path: "/ws/beta" },
];

function proc(
  pid: number,
  ppid: number,
  cwd: string | null,
  extra: Partial<ProcessSnapshotEntry> = {}
): ProcessSnapshotEntry {
  return {
    pid,
    ppid,
    name: `p${pid}`,
    commandLine: `p${pid} --run`,
    cwd,
    rssBytes: 1000,
    cpuTimeMs: 0,
    startedAt: 1_000 + pid,
    envValue: null,
    ...extra,
  };
}

describe("attributeProcesses", () => {
  it("assigns a process by its own working directory, a subdirectory included", () => {
    const owners = attributeProcesses(
      [proc(10, 1, "/ws/alpha"), proc(11, 1, "/ws/beta/src"), proc(12, 1, "/home")],
      WORKSPACES,
      APP
    );
    expect(owners).toEqual(
      new Map([
        [10, ALPHA],
        [11, BETA],
      ])
    );
  });

  it("does not take a sibling directory that merely shares the prefix", () => {
    expect(attributeProcesses([proc(10, 1, "/ws/alpha-two")], WORKSPACES, APP).size).toBe(0);
  });

  it("gives a child that changed directory to its parent's workspace", () => {
    // `pnpm dev` in the workspace starts a server that cds into /tmp.
    const owners = attributeProcesses(
      [proc(10, 1, "/ws/alpha"), proc(11, 10, "/tmp"), proc(12, 11, null)],
      WORKSPACES,
      APP
    );
    expect(owners.get(11)).toBe(ALPHA);
    expect(owners.get(12)).toBe(ALPHA);
  });

  it("lets a process's own directory win over its parent's", () => {
    const owners = attributeProcesses(
      [proc(10, 1, "/ws/alpha"), proc(11, 10, "/ws/beta")],
      WORKSPACES,
      APP
    );
    expect(owners.get(11)).toBe(BETA);
  });

  it("keeps a workspace terminal after it cds out, by its _CH_WORKSPACE", () => {
    // The terminal's parent is the IDE's shared pty host, which is in no worktree.
    const owners = attributeProcesses(
      [
        proc(5, 1, "/opt/ide"),
        proc(10, 5, "/ws", { envValue: ALPHA }),
        proc(11, 10, "/tmp", { envValue: null }),
      ],
      WORKSPACES,
      APP
    );
    expect(owners).toEqual(
      new Map([
        [10, ALPHA],
        [11, ALPHA],
      ])
    );
  });

  it("lets _CH_WORKSPACE win over the working directory", () => {
    // Alpha's agent runs `cd ../beta && npm test`: it is alpha's work.
    const owners = attributeProcesses(
      [proc(10, 1, "/ws/beta", { envValue: ALPHA })],
      WORKSPACES,
      APP
    );
    expect(owners.get(10)).toBe(ALPHA);
  });

  it("ignores a _CH_WORKSPACE naming no monitored workspace", () => {
    // Another CodeHydra instance's ref, or a removed workspace's.
    const owners = attributeProcesses(
      [
        proc(10, 1, "/ws/beta", { envValue: "ch::other::p::x" }),
        proc(11, 1, "/home", { envValue: "ch::other::p::x" }),
      ],
      WORKSPACES,
      APP
    );
    expect(owners).toEqual(new Map([[10, BETA]]));
  });

  it("prefers the deepest worktree when one is inside another", () => {
    const nested = [
      ...WORKSPACES,
      { ref: "ch::m::p::inner" as WorkspaceRef, path: "/ws/alpha/inner" },
    ];
    expect(attributeProcesses([proc(10, 1, "/ws/alpha/inner/x")], nested, APP).get(10)).toBe(
      "ch::m::p::inner"
    );
  });

  it("never inherits through CodeHydra itself, nor counts it", () => {
    // In development the app runs inside a worktree: its IDE server and helpers
    // must not all land in that workspace, and the app is not a workspace process.
    const owners = attributeProcesses(
      [
        proc(APP, 1, "/ws/alpha"),
        proc(20, APP, "/opt/ide"),
        proc(21, 20, null),
        proc(22, 20, "/ws/beta"),
      ],
      WORKSPACES,
      APP
    );
    expect(owners).toEqual(new Map([[22, BETA]]));
  });

  it("does not inherit from a pid reused by a process started after the child", () => {
    // Windows never clears a dead parent's pid: a later process holding it is not the parent.
    const owners = attributeProcesses(
      [proc(10, 1, "/ws/alpha", { startedAt: 9_000 }), proc(11, 10, "/tmp", { startedAt: 5_000 })],
      WORKSPACES,
      APP
    );
    expect(owners.has(11)).toBe(false);
  });

  it("survives a parent-pid loop", () => {
    const owners = attributeProcesses(
      [proc(10, 11, "/tmp", { startedAt: null }), proc(11, 10, "/tmp", { startedAt: null })],
      WORKSPACES,
      APP
    );
    expect(owners.size).toBe(0);
  });
});

describe("cpuPercents", () => {
  const snapshot = (takenAt: number, processes: ProcessSnapshotEntry[]): ProcessSnapshot => ({
    takenAt,
    processes,
  });

  it("is percent of one core between two snapshots", () => {
    const before = snapshot(0, [proc(10, 1, null, { cpuTimeMs: 1000 })]);
    const after = snapshot(2000, [proc(10, 1, null, { cpuTimeMs: 1500 })]);
    expect(cpuPercents(after, before)?.get(10)).toBe(25);
  });

  it("is null with nothing to compare against", () => {
    expect(cpuPercents(snapshot(0, [proc(10, 1, null)]), null)).toBeNull();
  });

  it("counts a new process (or a reused pid) from zero", () => {
    const before = snapshot(0, [proc(10, 1, null, { cpuTimeMs: 5000, startedAt: 1 })]);
    const after = snapshot(1000, [proc(10, 1, null, { cpuTimeMs: 300, startedAt: 500 })]);
    expect(cpuPercents(after, before)?.get(10)).toBe(30);
  });

  it("leaves out a process whose CPU time is unreadable", () => {
    const before = snapshot(0, [proc(10, 1, null)]);
    const after = snapshot(1000, [proc(10, 1, null, { cpuTimeMs: null })]);
    expect(cpuPercents(after, before)?.has(10)).toBe(false);
  });
});

describe("buildWorkspaceProcesses", () => {
  it("nests each process under its parent and totals every subtree", () => {
    const snapshot: ProcessSnapshot = {
      takenAt: Date.UTC(2026, 10, 1),
      processes: [
        proc(10, 1, "/ws/alpha", { rssBytes: 100 }),
        proc(11, 10, "/tmp", { rssBytes: 200 }),
        proc(12, 11, "/tmp", { rssBytes: 300 }),
        proc(20, 1, "/ws/alpha", { rssBytes: 50 }),
      ],
    };
    const owners = attributeProcesses(snapshot.processes, WORKSPACES, APP);
    const cpu = new Map([
      [10, 1],
      [11, 2],
      [12, 3],
      [20, 4],
    ]);
    const result = buildWorkspaceProcesses(snapshot, owners, cpu, new Map([[12, [5173, 24678]]]));

    const alpha = result.get(ALPHA)!;
    expect(alpha.scannedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(alpha.total).toEqual({ cpuPercent: 10, rssBytes: 650, count: 4 });
    expect(alpha.processes.map((root) => root.pid)).toEqual([10, 20]);
    const [shell] = alpha.processes;
    expect(shell!.subtree).toEqual({ cpuPercent: 6, rssBytes: 600, count: 3 });
    expect(shell!.children[0]!.pid).toBe(11);
    const server = shell!.children[0]!.children[0]!;
    expect(server).toMatchObject({ pid: 12, cpuPercent: 3, ports: [5173, 24678], children: [] });
    expect(result.has(BETA)).toBe(false);
  });

  it("roots a process whose parent belongs to another workspace", () => {
    const snapshot: ProcessSnapshot = {
      takenAt: 0,
      processes: [proc(10, 1, "/ws/alpha"), proc(11, 10, "/ws/beta")],
    };
    const result = buildWorkspaceProcesses(
      snapshot,
      attributeProcesses(snapshot.processes, WORKSPACES, APP),
      null,
      new Map()
    );
    expect(result.get(BETA)!.processes.map((root) => root.pid)).toEqual([11]);
    expect(result.get(ALPHA)!.processes[0]!.children).toEqual([]);
  });

  it("leaves CPU null before a second scan", () => {
    const snapshot: ProcessSnapshot = { takenAt: 0, processes: [proc(10, 1, "/ws/alpha")] };
    const result = buildWorkspaceProcesses(
      snapshot,
      attributeProcesses(snapshot.processes, WORKSPACES, APP),
      null,
      new Map()
    );
    expect(result.get(ALPHA)!.total.cpuPercent).toBeNull();
    expect(result.get(ALPHA)!.processes[0]!.cpuPercent).toBeNull();
  });

  it("lists every member of a parent-pid loop instead of losing it", () => {
    const owners = new Map([
      [10, ALPHA],
      [11, ALPHA],
    ]);
    const snapshot: ProcessSnapshot = {
      takenAt: 0,
      processes: [
        proc(10, 11, "/ws/alpha", { startedAt: null }),
        proc(11, 10, "/ws/alpha", { startedAt: null }),
      ],
    };
    expect(buildWorkspaceProcesses(snapshot, owners, null, new Map()).get(ALPHA)!.total.count).toBe(
      2
    );
  });
});
