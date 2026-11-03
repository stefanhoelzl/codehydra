/**
 * Integration tests for the Processes view: what it shows from
 * `workspace.processes`, and that it asks only while visible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { createdTreeViews, resetVscodeFake, type FakeTreeView } from "../../../__mocks__/vscode";

vi.mock("vscode");

import {
  ProcessesView,
  describeProcess,
  formatMemory,
  formatRunningTime,
  type ProcessNode,
  type WorkspaceProcesses,
} from "./processes-view";

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const MIB = 1024 * 1024;

function node(pid: number, extra: Partial<ProcessNode> = {}): ProcessNode {
  return {
    pid,
    name: `p${pid}`,
    commandLine: `p${pid} --flag`,
    cwd: "/ws/alpha",
    cpuPercent: 2,
    rssBytes: 10 * MIB,
    startedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    ports: [],
    subtree: { cpuPercent: 2, rssBytes: 10 * MIB, count: 1 },
    children: [],
    ...extra,
  };
}

const SERVER = node(12, { name: "vite", cpuPercent: 12, rssBytes: 310 * MIB, ports: [5173] });
const DEV = node(11, {
  name: "pnpm",
  cpuPercent: 1,
  rssBytes: 80 * MIB,
  subtree: { cpuPercent: 13, rssBytes: 390 * MIB, count: 2 },
  children: [SERVER],
});
const PROCESSES: WorkspaceProcesses = {
  scannedAt: new Date(NOW).toISOString(),
  total: { cpuPercent: 13, rssBytes: 390 * MIB, count: 2 },
  processes: [DEV],
};

function setup(fetch: () => Promise<WorkspaceProcesses> = async () => PROCESSES) {
  const calls = vi.fn(fetch);
  const view = new ProcessesView({ fetch: calls, refreshMs: 3000, now: () => NOW });
  const tree = createdTreeViews.at(-1) as FakeTreeView;
  return { view, tree, calls };
}

beforeEach(() => {
  resetVscodeFake();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Processes view", () => {
  it("asks for nothing while hidden, and every interval once visible", async () => {
    const { tree, calls } = setup();
    expect(tree.id).toBe("codehydra.processes");
    expect(calls).not.toHaveBeenCalled();

    tree.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveBeenCalledTimes(2);

    tree.setVisible(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("shows the tree, with the workspace total as the view's description", async () => {
    const { view, tree } = setup();
    await view.refresh();

    expect(tree.description).toBe("13% · 390M");
    const [root] = view.getChildren();
    expect(view.getChildren(root)).toEqual([SERVER]);

    const item = view.getTreeItem(root!);
    expect(item.label).toBe("pnpm");
    expect(item.id).toBe(`11:${DEV.startedAt}`);
    expect(item.description).toBe("11 · 1% · 80M · 2h");
    expect(view.getTreeItem(SERVER).description).toBe("12 · 12% · 310M · 2h · :5173");
  });

  it("opens a row expanded when it gains children, under a new id", async () => {
    let processes = [node(11, { name: "bash" })];
    const { view } = setup(async () => ({ ...PROCESSES, processes }));
    await view.refresh();
    const leaf = view.getTreeItem(processes[0]!);
    expect(leaf.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);

    // The shell starts a server. VS Code would keep the cached state of the
    // old id (collapsed); a new id opens expanded.
    processes = [node(11, { name: "bash", children: [SERVER] })];
    await view.refresh();
    const parent = view.getTreeItem(processes[0]!);
    expect(parent.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(parent.id).not.toBe(leaf.id);
  });

  it("shows a folded row's subtree totals", async () => {
    const { view, tree } = setup();
    await view.refresh();

    for (const handler of tree.collapseHandlers) handler({ element: DEV });
    expect(view.getTreeItem(DEV).description).toBe("11 · 13% · 390M · 2h · 2 processes");

    for (const handler of tree.expandHandlers) handler({ element: DEV });
    expect(view.getTreeItem(DEV).description).toBe("11 · 1% · 80M · 2h");
  });

  it("says so when there are no processes, or the call failed", async () => {
    const empty = setup(async () => ({ ...PROCESSES, processes: [] }));
    await empty.view.refresh();
    expect(empty.view.getChildren()).toEqual([{ message: "No processes" }]);

    const failing = setup(async () => {
      throw new Error("scan failed");
    });
    await failing.view.refresh();
    expect(failing.view.getChildren()).toEqual([
      { message: "Could not list processes: scan failed" },
    ]);
    expect(failing.tree.description).toBeUndefined();
  });

  it("stops polling when disposed", async () => {
    const { view, tree, calls } = setup();
    tree.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    view.dispose();
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("formatting", () => {
  it("formats memory and running time compactly", () => {
    expect(formatMemory(512 * 1024)).toBe("512K");
    expect(formatMemory(1.5 * 1024 * MIB)).toBe("1.5G");
    expect(formatRunningTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("<1m");
    expect(formatRunningTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe("3d");
    expect(formatRunningTime(null, NOW)).toBeNull();
  });

  it("leaves out what is unknown", () => {
    expect(describeProcess(node(5, { startedAt: null, cpuPercent: null }), false, NOW)).toBe(
      "5 · –% · 10M"
    );
  });
});
