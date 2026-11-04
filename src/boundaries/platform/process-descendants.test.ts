// @vitest-environment node
/**
 * Focused tests for `descendantsIn`: the process tree a tree kill signals,
 * read from a process snapshot.
 */

import { describe, it, expect } from "vitest";
import { descendantsIn, type ProcessSnapshotEntry } from "./process";

function entry(pid: number, ppid: number, startedAt: number | null = 1000): ProcessSnapshotEntry {
  return {
    pid,
    ppid,
    name: `p${pid}`,
    commandLine: `p${pid}`,
    cwd: null,
    rssBytes: 0,
    cpuTimeMs: null,
    startedAt,
    envValue: null,
  };
}

describe("descendantsIn", () => {
  it("finds children, grandchildren and further down, not siblings or the parent", () => {
    const processes = [
      entry(1, 0),
      entry(10, 1), // the root of the kill
      entry(11, 10),
      entry(12, 10),
      entry(13, 11),
      entry(20, 1), // a sibling of the root
    ];
    expect(descendantsIn(processes, 10).sort((a, b) => a - b)).toEqual([11, 12, 13]);
  });

  it("finds nothing below a leaf, or for a pid not in the snapshot", () => {
    expect(descendantsIn([entry(1, 0), entry(10, 1)], 10)).toEqual([]);
    expect(descendantsIn([entry(1, 0)], 99)).toEqual([]);
  });

  it("skips a 'child' that started before its parent: a reused parent pid", () => {
    // pid 10 is a new process; 11 was the child of the old pid 10, which exited.
    const processes = [entry(10, 1, 5000), entry(11, 10, 1000), entry(12, 10, 6000)];
    expect(descendantsIn(processes, 10)).toEqual([12]);
  });

  it("keeps a child whose start time, or its parent's, is unknown", () => {
    expect(descendantsIn([entry(10, 1, null), entry(11, 10, 1000)], 10)).toEqual([11]);
    expect(descendantsIn([entry(10, 1, 5000), entry(11, 10, null)], 10)).toEqual([11]);
  });

  it("terminates on a cycle in the parent links", () => {
    // Not possible in a consistent snapshot, but pid reuse between reads can
    // produce one; the walk must still end.
    expect(descendantsIn([entry(10, 11), entry(11, 10)], 10)).toEqual([11]);
  });
});
