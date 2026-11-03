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
 * Otherwise it inherits its parent's workspace: `pnpm dev` in a workspace
 * terminal owns the `vite` it starts, even after `vite` `cd`s out.
 *
 * Inheritance stops at CodeHydra itself. The app is the ancestor of every
 * workspace's IDE server, terminals and agents, so a process that only reaches
 * a workspace through the app — the IDE server, its helpers — belongs to none.
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
function isPlausibleParent(child: ProcessSnapshotEntry, parent: ProcessSnapshotEntry): boolean {
  if (parent.pid === child.pid) return false;
  if (child.startedAt === null || parent.startedAt === null) return true;
  return parent.startedAt <= child.startedAt + START_TOLERANCE_MS;
}

/** pid → the workspace it belongs to. Processes belonging to none are absent. */
export function attributeProcesses(
  processes: readonly ProcessSnapshotEntry[],
  workspaces: readonly MonitoredWorkspace[],
  appPid: number
): Map<number, WorkspaceRef> {
  // Deepest first, so a worktree nested in another wins for its own tree.
  const roots = workspaces
    .map((workspace) => ({ ref: workspace.ref, path: new Path(workspace.path) }))
    .sort((a, b) => b.path.toString().length - a.path.toString().length);
  const byRef = new Map(workspaces.map((workspace) => [String(workspace.ref), workspace.ref]));
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));

  const ownWorkspace = (entry: ProcessSnapshotEntry): WorkspaceRef | null => {
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

/**
 * pid → percent of one core used since `previous` was taken. Null when there
 * is no previous scan to compare with; a process absent from it counts from 0,
 * which slightly understates one that started mid-interval.
 */
export function cpuPercents(
  current: ProcessSnapshot,
  previous: ProcessSnapshot | null
): Map<number, number> | null {
  if (previous === null) return null;
  const interval = current.takenAt - previous.takenAt;
  if (interval <= 0) return null;
  const before = new Map<string, number>();
  for (const entry of previous.processes) {
    if (entry.cpuTimeMs !== null) before.set(identity(entry), entry.cpuTimeMs);
  }
  const result = new Map<number, number>();
  for (const entry of current.processes) {
    if (entry.cpuTimeMs === null) continue;
    const used = entry.cpuTimeMs - (before.get(identity(entry)) ?? 0);
    result.set(entry.pid, Math.max(0, (used / interval) * 100));
  }
  return result;
}

/** Sum totals; CPU stays null only when none of them has a reading. */
function addTotals(a: ProcessTotals, b: ProcessTotals): ProcessTotals {
  return {
    cpuPercent:
      a.cpuPercent === null && b.cpuPercent === null
        ? null
        : (a.cpuPercent ?? 0) + (b.cpuPercent ?? 0),
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

/** Each workspace's process tree, from one scan. Workspaces with no process are absent. */
export function buildWorkspaceProcesses(
  snapshot: ProcessSnapshot,
  owners: ReadonlyMap<number, WorkspaceRef>,
  cpu: ReadonlyMap<number, number> | null,
  ports: ReadonlyMap<number, readonly number[]>
): Map<WorkspaceRef, WorkspaceProcesses> {
  const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
  const childrenOf = new Map<number, ProcessSnapshotEntry[]>();
  const rootsOf = new Map<WorkspaceRef, ProcessSnapshotEntry[]>();

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

  const result = new Map<WorkspaceRef, WorkspaceProcesses>();
  const owned = new Map<WorkspaceRef, ProcessSnapshotEntry[]>();
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
