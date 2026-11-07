/**
 * Which workspace each process belongs to, and the per-workspace trees — the
 * pure half of the process monitor (process-monitor-module.ts runs the scans).
 *
 * A process names its own workspace in one of two ways, in this order:
 * 1. `_CH_WORKSPACE` in its environment (WORKSPACE_ENV_VAR) is a monitored
 *    workspace's ref. CodeHydra sets it in every terminal of a workspace and
 *    for its agent, and every child inherits it — so a shell that `cd`s out of
 *    the worktree, or a build an agent starts in /tmp, stays with the workspace
 *    that started it, even when that is inside another worktree.
 * 2. Its working directory is inside a worktree (the deepest one wins).
 * A pinned process (a workspace's extension host, which names its pid when its
 * sidekick connects: it has neither) belongs to the workspace it is pinned to,
 * before either rule.
 * Otherwise it inherits its parent's workspace: `pnpm dev` in a workspace
 * terminal owns the `vite` it starts, even after `vite` `cd`s out; a language
 * server inherits its extension host's.
 *
 * Inheritance stops at CodeHydra itself. The app is the ancestor of every
 * workspace's IDE server, terminals and agents, so a process that only reaches
 * a workspace through the app — the IDE server, its helpers — belongs to none.
 * Those count only in CodeHydra's own totals (codeHydraTotals: the app's
 * process tree and every workspace's processes, the sidebar's process bar),
 * split into the code server (the IDE server's tree) and the rest
 * (codeHydraGroups).
 *
 * The same attribution decides what hibernating or deleting a workspace stops
 * (teardownProcesses).
 */

import type { ProcessSnapshot, ProcessSnapshotEntry } from "../../boundaries/platform/process";
import type { ProcessTotals, WorkspaceProcess, WorkspaceProcesses } from "../../api/entries/deps";
import type { WorkspaceRef } from "../../intents/contract";
import { Path } from "../../utils/path/path";
import { WORKSPACE_REF_ENV_VAR } from "../../intents/open-workspace";

/** The environment variable naming a process's workspace (set in every workspace terminal and agent). */
export const WORKSPACE_ENV_VAR = WORKSPACE_REF_ENV_VAR;

/** A workspace the monitor attributes processes to. */
export interface MonitoredWorkspace {
  readonly ref: WorkspaceRef;
  /** The worktree. */
  readonly path: string;
}

/**
 * Slack when comparing a parent's start with its child's: macOS reports start
 * times in whole seconds, so a child started in the same second can read as
 * up to a second "before" its parent.
 */
const START_TOLERANCE_MS = 1000;

/** A pid and its start time: what tells a process apart from a later one reusing its pid. */
function identity(entry: ProcessSnapshotEntry): string {
  return `${entry.pid}:${entry.startedAt ?? "?"}`;
}

/**
 * Whether `parent` can really be `child`'s parent. A parent pid is only a
 * number: on Windows it is never cleared when the parent exits, so a newer
 * process that got the same pid would otherwise adopt the orphan.
 */
export function isPlausibleParent(
  child: ProcessSnapshotEntry,
  parent: ProcessSnapshotEntry
): boolean {
  if (parent.pid === child.pid) return false;
  if (child.startedAt === null || parent.startedAt === null) return true;
  return parent.startedAt <= child.startedAt + START_TOLERANCE_MS;
}

/** pid → the workspace it belongs to. Processes belonging to none are absent. */
export function attributeProcesses(
  processes: readonly ProcessSnapshotEntry[],
  workspaces: readonly MonitoredWorkspace[],
  appPid: number,
  pinned: ReadonlyMap<number, WorkspaceRef> = new Map()
): Map<number, WorkspaceRef> {
  // Deepest first, so a worktree nested in another wins for its own tree.
  const roots = workspaces
    .map((workspace) => ({ ref: workspace.ref, path: new Path(workspace.path) }))
    .sort((a, b) => b.path.toString().length - a.path.toString().length);
  const byRef = new Map(workspaces.map((workspace) => [String(workspace.ref), workspace.ref]));
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));

  const ownWorkspace = (entry: ProcessSnapshotEntry): WorkspaceRef | null => {
    const pin = pinned.get(entry.pid);
    if (pin !== undefined && byRef.has(String(pin))) return pin;
    // A ref this app does not monitor (another CodeHydra instance's, a removed
    // workspace's) says nothing; the working directory decides.
    const named = entry.envValue === null ? undefined : byRef.get(entry.envValue);
    if (named !== undefined) return named;
    if (entry.cwd === null) return null;
    let cwd: Path;
    try {
      cwd = new Path(entry.cwd);
    } catch {
      return null; // not an absolute path
    }
    return roots.find((root) => cwd.startsWith(root.path))?.ref ?? null;
  };

  const owners = new Map<number, WorkspaceRef | null>();
  const resolve = (start: ProcessSnapshotEntry): WorkspaceRef | null => {
    // Walk up until an answer is known, then write it back down the chain.
    const chain: ProcessSnapshotEntry[] = [];
    const seen = new Set<number>();
    let entry: ProcessSnapshotEntry | undefined = start;
    let owner: WorkspaceRef | null = null;
    while (entry !== undefined) {
      const known = owners.get(entry.pid);
      if (known !== undefined) {
        owner = known;
        break;
      }
      if (entry.pid === appPid || seen.has(entry.pid)) break;
      seen.add(entry.pid);
      chain.push(entry);
      const own = ownWorkspace(entry);
      if (own !== null) {
        owner = own;
        break;
      }
      const parent = byPid.get(entry.ppid);
      entry = parent !== undefined && isPlausibleParent(entry, parent) ? parent : undefined;
    }
    for (const link of chain) owners.set(link.pid, owner);
    return owner;
  };

  const result = new Map<number, WorkspaceRef>();
  for (const entry of processes) {
    if (entry.pid === appPid) continue;
    const owner = resolve(entry);
    if (owner !== null) result.set(entry.pid, owner);
  }
  return result;
}

/** The children of each pid, through plausible parents only. */
function childrenByPid(processes: readonly ProcessSnapshotEntry[]): Map<number, number[]> {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    const parent = byPid.get(entry.ppid);
    if (parent === undefined || !isPlausibleParent(entry, parent)) continue;
    const siblings = children.get(parent.pid) ?? [];
    siblings.push(entry.pid);
    children.set(parent.pid, siblings);
  }
  return children;
}

/**
 * CodeHydra's own process tree: the app and every process descending from it
 * (its Electron helpers, the IDE server, the terminals and agents). Empty when
 * the app is not in the snapshot.
 */
export function appTreePids(
  processes: readonly ProcessSnapshotEntry[],
  appPid: number
): Set<number> {
  return subtreePids(processes, appPid, childrenByPid(processes));
}

/** `rootPid` and every process descending from it; empty when it is not in the snapshot. */
function subtreePids(
  processes: readonly ProcessSnapshotEntry[],
  rootPid: number,
  children: ReadonlyMap<number, readonly number[]>
): Set<number> {
  const tree = new Set<number>();
  if (!processes.some((entry) => entry.pid === rootPid)) return tree;
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (tree.has(pid)) continue;
    tree.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/**
 * The app and its ancestors: what teardown must never kill. A CodeHydra
 * started from a terminal (`pnpm dev` in another CodeHydra's workspace) has
 * ancestors whose working directory can be inside a worktree it monitors.
 */
function appAndAncestors(processes: readonly ProcessSnapshotEntry[], appPid: number): Set<number> {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const result = new Set<number>([appPid]);
  let entry = byPid.get(appPid);
  while (entry !== undefined) {
    const parent = byPid.get(entry.ppid);
    if (parent === undefined || result.has(parent.pid) || !isPlausibleParent(entry, parent)) break;
    result.add(parent.pid);
    entry = parent;
  }
  return result;
}

/** Whether `entry`'s working directory is `root` or inside it. */
function cwdInside(entry: ProcessSnapshotEntry, root: Path): boolean {
  if (entry.cwd === null) return false;
  try {
    return new Path(entry.cwd).startsWith(root);
  } catch {
    return false; // not an absolute path
  }
}

/** A process teardown stops. */
export interface TeardownProcess {
  readonly pid: number;
  readonly name: string;
}

/**
 * The processes to stop when `workspace` is torn down: every process attributed
 * to it and, with `cwdInside`, every process whose working directory is in its
 * worktree whoever it belongs to (a deletion: the directory is going away). The
 * app and its ancestors are never in it.
 */
export function teardownProcesses(
  processes: readonly ProcessSnapshotEntry[],
  owners: ReadonlyMap<number, WorkspaceRef>,
  workspace: MonitoredWorkspace,
  appPid: number,
  options: { readonly cwdInside: boolean }
): TeardownProcess[] {
  const spared = appAndAncestors(processes, appPid);
  const root = new Path(workspace.path);
  return processes
    .filter(
      (entry) =>
        !spared.has(entry.pid) &&
        (owners.get(entry.pid) === workspace.ref || (options.cwdInside && cwdInside(entry, root)))
    )
    .map((entry) => ({ pid: entry.pid, name: entry.name }));
}

/** The two parts of CodeHydra's own processes, those that belong to no workspace. */
export type CodeHydraGroup = "codeServer" | "codehydra";

/**
 * pid → its part of CodeHydra, for every process in the app's tree that
 * belongs to no workspace: `codeServer` for the IDE server and what descends
 * from it, `codehydra` for the rest (the app, its Electron helpers).
 */
export function codeHydraGroups(
  processes: readonly ProcessSnapshotEntry[],
  owners: ReadonlyMap<number, WorkspaceRef>,
  appPid: number,
  ideServerPid: number | null
): Map<number, CodeHydraGroup> {
  const children = childrenByPid(processes);
  const app = subtreePids(processes, appPid, children);
  const ide =
    ideServerPid === null ? new Set<number>() : subtreePids(processes, ideServerPid, children);
  const groups = new Map<number, CodeHydraGroup>();
  for (const pid of app) {
    if (!owners.has(pid)) groups.set(pid, ide.has(pid) ? "codeServer" : "codehydra");
  }
  return groups;
}

/** Every process CodeHydra accounts for, totalled (the sidebar's process bar). */
export interface CodeHydraTotals {
  /** `workspaces`, `codeServer` and `codehydra` together. */
  readonly all: ProcessTotals;
  /** Every process attributed to a workspace, wherever it runs. */
  readonly workspaces: ProcessTotals;
  /** The IDE server and what descends from it, less what belongs to a workspace. */
  readonly codeServer: ProcessTotals;
  /** The rest of the app's process tree: the app and its helpers. */
  readonly codehydra: ProcessTotals;
}

/**
 * The process bar's totals from one scan: the app's process tree and every
 * process attributed to a workspace, each counted once.
 */
export function codeHydraTotals(
  processes: readonly ProcessSnapshotEntry[],
  owners: ReadonlyMap<number, WorkspaceRef>,
  groups: ReadonlyMap<number, CodeHydraGroup>,
  cpu: ReadonlyMap<number, number> | null
): CodeHydraTotals {
  let workspaces = EMPTY_TOTALS;
  let codeServer = EMPTY_TOTALS;
  let codehydra = EMPTY_TOTALS;
  for (const entry of processes) {
    const inWorkspace = owners.has(entry.pid);
    const group = groups.get(entry.pid);
    if (!inWorkspace && group === undefined) continue;
    const own: ProcessTotals = {
      cpuPercent: cpu === null ? null : (cpu.get(entry.pid) ?? null),
      rssBytes: entry.rssBytes,
      count: 1,
    };
    if (inWorkspace) workspaces = addTotals(workspaces, own);
    else if (group === "codeServer") codeServer = addTotals(codeServer, own);
    else codehydra = addTotals(codehydra, own);
  }
  return {
    all: addTotals(addTotals(workspaces, codeServer), codehydra),
    workspaces,
    codeServer,
    codehydra,
  };
}

/**
 * The processes to stop when one process is killed from the sidebar: `pid`,
 * started at `startedAt` (ISO), and every process below it that belongs to the
 * same workspace. Empty when the pid is gone, was reused by another process,
 * belongs to no workspace, or is the app or one of its ancestors.
 */
export function killTargets(
  processes: readonly ProcessSnapshotEntry[],
  owners: ReadonlyMap<number, WorkspaceRef>,
  pid: number,
  startedAt: string | null,
  appPid: number
): TeardownProcess[] {
  const entry = processes.find((candidate) => candidate.pid === pid);
  if (entry === undefined) return [];
  const started = entry.startedAt === null ? null : new Date(entry.startedAt).toISOString();
  if (started !== startedAt) return [];
  const owner = owners.get(pid);
  if (owner === undefined) return [];
  const spared = appAndAncestors(processes, appPid);
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  return [...subtreePids(processes, pid, childrenByPid(processes))]
    .filter((member) => owners.get(member) === owner && !spared.has(member))
    .map((member) => ({ pid: member, name: byPid.get(member)?.name ?? "" }));
}

/**
 * pid → percent of the whole machine (`cpuCount` logical CPUs, 100 = all of
 * them busy) used since `previous` was taken, capped at 100 against sampling
 * jitter. Null when there is no previous scan to compare with; a process
 * absent from it counts from 0, which slightly understates one that started
 * mid-interval.
 */
export function cpuPercents(
  current: ProcessSnapshot,
  previous: ProcessSnapshot | null,
  cpuCount: number
): Map<number, number> | null {
  if (previous === null) return null;
  const interval = current.takenAt - previous.takenAt;
  if (interval <= 0) return null;
  const before = new Map<string, number>();
  for (const entry of previous.processes) {
    if (entry.cpuTimeMs !== null) before.set(identity(entry), entry.cpuTimeMs);
  }
  const capacity = interval * Math.max(1, cpuCount);
  const result = new Map<number, number>();
  for (const entry of current.processes) {
    if (entry.cpuTimeMs === null) continue;
    const used = entry.cpuTimeMs - (before.get(identity(entry)) ?? 0);
    result.set(entry.pid, Math.min(100, Math.max(0, (used / capacity) * 100)));
  }
  return result;
}

/** Sum totals, CPU capped at 100; it stays null only when none of them has a reading. */
function addTotals(a: ProcessTotals, b: ProcessTotals): ProcessTotals {
  return {
    cpuPercent:
      a.cpuPercent === null && b.cpuPercent === null
        ? null
        : Math.min(100, (a.cpuPercent ?? 0) + (b.cpuPercent ?? 0)),
    rssBytes: a.rssBytes + b.rssBytes,
    count: a.count + b.count,
  };
}

const EMPTY_TOTALS: ProcessTotals = { cpuPercent: null, rssBytes: 0, count: 0 };

/** Oldest first; a process with no known start time sorts by pid after them. */
function byStart(a: ProcessSnapshotEntry, b: ProcessSnapshotEntry): number {
  if (a.startedAt !== null && b.startedAt !== null && a.startedAt !== b.startedAt) {
    return a.startedAt - b.startedAt;
  }
  if (a.startedAt === null && b.startedAt !== null) return 1;
  if (a.startedAt !== null && b.startedAt === null) return -1;
  return a.pid - b.pid;
}

/**
 * Each owner's process tree, from one scan: a workspace's (owners by ref), or
 * a part of CodeHydra's (owners by CodeHydraGroup). Owners with no process are
 * absent.
 */
export function buildWorkspaceProcesses<Owner>(
  snapshot: ProcessSnapshot,
  owners: ReadonlyMap<number, Owner>,
  cpu: ReadonlyMap<number, number> | null,
  ports: ReadonlyMap<number, readonly number[]>
): Map<Owner, WorkspaceProcesses> {
  const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
  const childrenOf = new Map<number, ProcessSnapshotEntry[]>();
  const rootsOf = new Map<Owner, ProcessSnapshotEntry[]>();

  for (const entry of snapshot.processes) {
    const owner = owners.get(entry.pid);
    if (owner === undefined) continue;
    const parent = byPid.get(entry.ppid);
    const nested =
      parent !== undefined && owners.get(parent.pid) === owner && isPlausibleParent(entry, parent);
    if (nested) {
      const siblings = childrenOf.get(parent.pid) ?? [];
      siblings.push(entry);
      childrenOf.set(parent.pid, siblings);
    } else {
      const roots = rootsOf.get(owner) ?? [];
      roots.push(entry);
      rootsOf.set(owner, roots);
    }
  }

  const scannedAt = new Date(snapshot.takenAt).toISOString();
  const toNode = (entry: ProcessSnapshotEntry, seen: Set<number>): WorkspaceProcess => {
    seen.add(entry.pid);
    const children = (childrenOf.get(entry.pid) ?? [])
      .filter((child) => !seen.has(child.pid))
      .sort(byStart)
      .map((child) => toNode(child, seen));
    const cpuPercent = cpu === null ? null : (cpu.get(entry.pid) ?? null);
    const own: ProcessTotals = { cpuPercent, rssBytes: entry.rssBytes, count: 1 };
    return {
      pid: entry.pid,
      ppid: entry.ppid,
      name: entry.name,
      commandLine: entry.commandLine,
      cwd: entry.cwd,
      cpuPercent,
      rssBytes: entry.rssBytes,
      startedAt: entry.startedAt === null ? null : new Date(entry.startedAt).toISOString(),
      ports: [...(ports.get(entry.pid) ?? [])].sort((a, b) => a - b),
      subtree: children.reduce((sum, child) => addTotals(sum, child.subtree), own),
      children,
    };
  };

  const result = new Map<Owner, WorkspaceProcesses>();
  const owned = new Map<Owner, ProcessSnapshotEntry[]>();
  for (const entry of snapshot.processes) {
    const owner = owners.get(entry.pid);
    if (owner === undefined) continue;
    const members = owned.get(owner) ?? [];
    members.push(entry);
    owned.set(owner, members);
  }
  for (const [owner, members] of owned) {
    const seen = new Set<number>();
    const processes = (rootsOf.get(owner) ?? []).sort(byStart).map((root) => toNode(root, seen));
    // A parent-pid loop (pids reused with unknown start times) has no root;
    // its members are listed as roots rather than lost.
    for (const entry of members.sort(byStart)) {
      if (!seen.has(entry.pid)) processes.push(toNode(entry, seen));
    }
    result.set(owner, {
      scannedAt,
      total: processes.reduce((sum, node) => addTotals(sum, node.subtree), EMPTY_TOTALS),
      processes,
    });
  }
  return result;
}
