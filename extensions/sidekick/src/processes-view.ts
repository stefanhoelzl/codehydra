/**
 * The Processes view (Explorer → PROCESSES): this workspace's processes as a
 * tree, from `workspace.processes` over the API socket.
 *
 * - Refreshes every REFRESH_MS while the view is visible, and on its refresh
 *   button; hidden, it asks for nothing. CodeHydra shares one scan between
 *   every caller within a moment, so several workspaces' views polling at once
 *   cost about one scan.
 * - A row reads `name  pid · CPU · memory · running time · :ports`; a collapsed
 *   row with children shows its subtree's totals instead of its own, so a
 *   folded `pnpm dev` still says what the whole dev server costs.
 * - The view's description is the workspace's total.
 *
 * Read-only: nothing here stops a process.
 */
import * as vscode from "vscode";
import { emitApiCall, whenReady } from "./connection";

/** Refresh interval while the view is visible. */
export const REFRESH_MS = 3000;

export const PROCESSES_VIEW_ID = "codehydra.processes";
export const REFRESH_COMMAND = "codehydra.processes.refresh";

/** The API channel of `workspace.processes`. */
const PROCESSES_CHANNEL = "api:workspace:processes";

/** CPU, memory and count over a set of processes (`workspace.processes`). */
export interface ProcessTotals {
  readonly cpuPercent: number | null;
  readonly rssBytes: number;
  readonly count: number;
}

/** One process as `workspace.processes` returns it. */
export interface ProcessNode {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly cwd: string | null;
  readonly cpuPercent: number | null;
  readonly rssBytes: number;
  readonly startedAt: string | null;
  readonly ports: readonly number[];
  readonly subtree: ProcessTotals;
  readonly children: readonly ProcessNode[];
}

export interface WorkspaceProcesses {
  readonly scannedAt: string;
  readonly total: ProcessTotals;
  readonly processes: readonly ProcessNode[];
}

/** A tree element: a process, or the one row saying why there are none. */
type Element = ProcessNode | { readonly message: string };

// --- formatting (pure) -----------------------------------------------------

export function formatCpu(cpuPercent: number | null): string {
  return cpuPercent === null ? "–%" : `${Math.round(cpuPercent)}%`;
}

export function formatMemory(bytes: number): string {
  const mib = 1024 * 1024;
  const gib = 1024 * mib;
  if (bytes < mib) return `${Math.round(bytes / 1024)}K`;
  if (bytes < gib) return `${Math.round(bytes / mib)}M`;
  const value = bytes / gib;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}G`;
}

/** How long it has run, in one floored unit: `<1m`, `5m`, `3h`, `2d`. */
export function formatRunningTime(startedAt: string | null, now: number): string | null {
  if (startedAt === null) return null;
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  if (Number.isNaN(elapsed)) return null;
  const minute = 60_000;
  if (elapsed < minute) return "<1m";
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < 24 * 60 * minute) return `${Math.floor(elapsed / (60 * minute))}h`;
  return `${Math.floor(elapsed / (24 * 60 * minute))}d`;
}

/** The view's description: the workspace's total. */
export function describeTotal(total: ProcessTotals): string {
  return `${formatCpu(total.cpuPercent)} · ${formatMemory(total.rssBytes)}`;
}

/**
 * A row's description. Collapsed with children: the subtree's CPU and memory
 * and how many processes it holds; otherwise the process's own.
 */
export function describeProcess(node: ProcessNode, collapsed: boolean, now: number): string {
  const folded = collapsed && node.children.length > 0;
  const cpu = folded ? node.subtree.cpuPercent : node.cpuPercent;
  const memory = folded ? node.subtree.rssBytes : node.rssBytes;
  const parts = [String(node.pid), formatCpu(cpu), formatMemory(memory)];
  const age = formatRunningTime(node.startedAt, now);
  if (age !== null) parts.push(age);
  if (node.ports.length > 0) parts.push(node.ports.map((port) => `:${port}`).join(" "));
  if (folded) parts.push(`${node.subtree.count} processes`);
  return parts.join(" · ");
}

/** Stable across refreshes, so VS Code keeps each row's expansion. */
function nodeId(node: ProcessNode): string {
  return `${node.pid}:${node.startedAt ?? ""}`;
}

function isProcess(element: Element): element is ProcessNode {
  return "pid" in element;
}

// --- the view ----------------------------------------------------------------

export interface ProcessesViewOptions {
  /** Where the processes come from; the API socket by default. */
  readonly fetch?: () => Promise<WorkspaceProcesses>;
  readonly refreshMs?: number;
  readonly now?: () => number;
}

export class ProcessesView implements vscode.TreeDataProvider<Element>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Element | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly view: vscode.TreeView<Element>;
  private readonly fetch: () => Promise<WorkspaceProcesses>;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly collapsed = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private data: WorkspaceProcesses | null = null;
  private error: string | null = null;

  constructor(options: ProcessesViewOptions = {}) {
    this.fetch =
      options.fetch ??
      (async () => {
        // Before the socket connects there is nothing to ask; wait rather than
        // flash a "not connected" error on the first refresh.
        await whenReady();
        return emitApiCall<WorkspaceProcesses>(PROCESSES_CHANNEL, {});
      });
    this.refreshMs = options.refreshMs ?? REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.view = vscode.window.createTreeView(PROCESSES_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.view,
      this.view.onDidChangeVisibility(({ visible }) => this.setPolling(visible)),
      // A folded row shows its subtree's totals: redraw it when it folds or unfolds.
      this.view.onDidCollapseElement(({ element }) => this.setCollapsed(element, true)),
      this.view.onDidExpandElement(({ element }) => this.setCollapsed(element, false))
    );
    this.setPolling(this.view.visible);
  }

  /** Fetch now; a refresh already running makes this one a no-op. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.data = await this.fetch();
      this.error = null;
      this.view.description = describeTotal(this.data.total);
    } catch (error) {
      this.data = null;
      this.error = error instanceof Error ? error.message : String(error);
      this.view.description = undefined;
    } finally {
      this.refreshing = false;
    }
    this.changed.fire(undefined);
  }

  getChildren(element?: Element): Element[] {
    if (element !== undefined) return isProcess(element) ? [...element.children] : [];
    if (this.error !== null) return [{ message: `Could not list processes: ${this.error}` }];
    if (this.data === null) return [];
    if (this.data.processes.length === 0) return [{ message: "No processes" }];
    return [...this.data.processes];
  }

  getTreeItem(element: Element): vscode.TreeItem {
    if (!isProcess(element)) {
      return new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
    }
    const id = nodeId(element);
    const collapsed = this.collapsed.has(id);
    const hasChildren = element.children.length > 0;
    const item = new vscode.TreeItem(
      element.name,
      !hasChildren
        ? vscode.TreeItemCollapsibleState.None
        : collapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
    );
    // VS Code keeps a row's expansion by id and ignores the state asked for
    // once it knows the row: a shell first listed with no children would show
    // collapsed when it starts one. A row that gains children is a new id, so
    // it opens expanded; one the user folded stays folded (`collapsed`).
    item.id = hasChildren ? id : `${id}:leaf`;
    item.description = describeProcess(element, collapsed, this.now());
    item.tooltip = this.tooltip(element);
    item.contextValue = "process";
    return item;
  }

  dispose(): void {
    this.setPolling(false);
    for (const disposable of this.disposables) disposable.dispose();
    this.changed.dispose();
  }

  private tooltip(node: ProcessNode): vscode.MarkdownString {
    const lines = [
      `**${node.name}** (pid ${node.pid})`,
      "",
      `CPU ${formatCpu(node.cpuPercent)} · memory ${formatMemory(node.rssBytes)}`,
    ];
    if (node.children.length > 0) {
      lines.push(
        `With its ${node.subtree.count - 1} descendants: CPU ${formatCpu(node.subtree.cpuPercent)}` +
          ` · memory ${formatMemory(node.subtree.rssBytes)}`
      );
    }
    if (node.ports.length > 0) lines.push(`Listening on ${node.ports.join(", ")}`);
    if (node.startedAt !== null) lines.push(`Started ${new Date(node.startedAt).toLocaleString()}`);
    if (node.cwd !== null) lines.push(`In ${node.cwd}`);
    const tooltip = new vscode.MarkdownString(lines.join("  \n"));
    tooltip.appendCodeblock(node.commandLine, "sh");
    return tooltip;
  }

  private setCollapsed(element: Element, collapsed: boolean): void {
    if (!isProcess(element)) return;
    if (collapsed) this.collapsed.add(nodeId(element));
    else this.collapsed.delete(nodeId(element));
    this.changed.fire(element);
  }

  private setPolling(visible: boolean): void {
    if (!visible) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
  }
}

/** Create the view and its refresh command. */
export function registerProcessesView(context: vscode.ExtensionContext): ProcessesView {
  const view = new ProcessesView();
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand(REFRESH_COMMAND, () => view.refresh())
  );
  return view;
}
