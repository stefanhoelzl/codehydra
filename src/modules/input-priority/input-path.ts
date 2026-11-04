/**
 * Which processes a keystroke in a workspace terminal passes through — the
 * pure half of the input priority module (input-priority-module.ts raises them).
 *
 * A key typed into a terminal travels UI renderer → IDE server → ptyHost →
 * ConPTY (`OpenConsole`, one per terminal) → the program reading it (the
 * terminal's shell, or the agent TUI in the agent terminal), and its echo
 * comes back the same way. Under heavy load each of these waits behind
 * everything else at normal priority, and the waits add up to seconds; every
 * one must be raised, so this finds them all — and nothing else: the
 * extension hosts, file watchers and whatever a shell or agent starts (builds,
 * dev servers) stay out.
 *
 * Only processes descending from CodeHydra itself are considered, so another
 * VS Code on the machine, with its own ptyHost, is left alone.
 */

import type { ProcessSnapshotEntry } from "../../boundaries/platform/process";
import { isPlausibleParent } from "../process-monitor/attribution";

/** VS Code starts its pty host with this argument. */
const PTY_HOST_ARG = /--type=ptyHost(?:\s|"|$)/;
/** Chromium renderer processes carry this argument. */
const RENDERER_ARG = /--type=renderer(?:\s|"|$)/;
/** The agent launchers: `<node> <bin>/ch.cjs claude|opencode …` (`ch.cmd`, `ch`). */
const AGENT_LAUNCHER = /ch\.cjs"?\s+(?:claude|opencode)(?:\s|$)/;

/** A process name without its `.exe`, lowercased: what the OS reports varies. */
function baseName(entry: ProcessSnapshotEntry): string {
  return entry.name.toLowerCase().replace(/\.exe$/, "");
}

/** The pids of every process on a keystroke's path, in no particular order. */
export function inputPathPids(
  processes: readonly ProcessSnapshotEntry[],
  appPid: number
): number[] {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessSnapshotEntry[]>();
  for (const entry of processes) {
    const parent = byPid.get(entry.ppid);
    if (parent === undefined || !isPlausibleParent(entry, parent)) continue;
    const siblings = children.get(parent.pid) ?? [];
    siblings.push(entry);
    children.set(parent.pid, siblings);
  }
  const childrenOf = (pid: number): readonly ProcessSnapshotEntry[] => children.get(pid) ?? [];

  const descendants: ProcessSnapshotEntry[] = [];
  const queue = [...childrenOf(appPid)];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    descendants.push(entry);
    queue.push(...childrenOf(entry.pid));
  }

  const path = new Set<number>();
  for (const entry of childrenOf(appPid)) {
    if (RENDERER_ARG.test(entry.commandLine)) path.add(entry.pid);
  }

  for (const ptyHost of descendants.filter((entry) => PTY_HOST_ARG.test(entry.commandLine))) {
    path.add(ptyHost.pid);
    // The IDE server forks the pty host.
    if (ptyHost.ppid !== appPid) path.add(ptyHost.ppid);
    // OpenConsole and the terminals' shells; a shell started under its
    // OpenConsole rather than beside it is one level further down.
    for (const child of childrenOf(ptyHost.pid)) {
      path.add(child.pid);
      if (baseName(child) === "openconsole") {
        for (const grandchild of childrenOf(child.pid)) path.add(grandchild.pid);
      }
    }
  }

  // The agent TUI: the launcher's child — past the `cmd.exe` that runs a
  // `.cmd` install (npm's claude), down to the program itself.
  for (const launcher of descendants.filter((entry) => AGENT_LAUNCHER.test(entry.commandLine))) {
    let frontier = childrenOf(launcher.pid);
    while (frontier.length > 0) {
      const next: ProcessSnapshotEntry[] = [];
      for (const entry of frontier) {
        if (baseName(entry) === "cmd") next.push(...childrenOf(entry.pid));
        else path.add(entry.pid);
      }
      frontier = next;
    }
  }

  return [...path];
}
