/**
 * A workspace's process summary as the sidebar shows it: a compact badge on
 * the row (`12% · 874M · 7`) and a spelled-out tooltip. Pure.
 */

import type { UiProcessNode, UiProcessSummary, UiProcessTotals } from "@shared/ui-state";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** CPU as a whole percent of one core; `–` before it could be measured. */
export function formatCpu(cpuPercent: number | null): string {
  return cpuPercent === null ? "–%" : `${Math.round(cpuPercent)}%`;
}

/** Memory in the largest unit under 1024: `512K`, `874M`, `1.2G` (one decimal below 10). */
export function formatMemory(bytes: number): string {
  if (bytes < MIB) return `${Math.round(bytes / KIB)}K`;
  if (bytes < GIB) return `${Math.round(bytes / MIB)}M`;
  const gib = bytes / GIB;
  return `${gib < 10 ? gib.toFixed(1) : Math.round(gib)}G`;
}

/** The badge's three numbers, each on its own; dashes before the first scan. */
export interface ProcessBadgeParts {
  cpu: string;
  memory: string;
  count: string;
}

export function processBadgeParts(summary: UiProcessSummary | undefined): ProcessBadgeParts {
  if (summary === undefined) return { cpu: "–%", memory: "–", count: "–" };
  return {
    cpu: formatCpu(summary.cpuPercent),
    memory: formatMemory(summary.rssBytes),
    count: String(summary.count),
  };
}

/** The badge: `12% · 874M · 7` (CPU, memory, process count). */
export function formatProcessBadge(summary: UiProcessSummary): string {
  const { cpu, memory, count } = processBadgeParts(summary);
  return `${cpu} · ${memory} · ${count}`;
}

/** The badge's tooltip: `12% CPU · 874M memory · 7 processes`. */
export function describeProcessSummary(summary: UiProcessSummary): string {
  const cpu =
    summary.cpuPercent === null ? "CPU not measured yet" : `${formatCpu(summary.cpuPercent)} CPU`;
  const count = `${summary.count} ${summary.count === 1 ? "process" : "processes"}`;
  return `${cpu} · ${formatMemory(summary.rssBytes)} memory · ${count}`;
}

/** The process bar's tooltip before the first scan. */
export const PROCESS_TOTALS_PENDING = "All of CodeHydra: not measured yet";

/**
 * The process bar's tooltip: CodeHydra's whole footprint, then its split into
 * the workspaces' processes, the code server's and the rest of CodeHydra's.
 */
export function describeProcessTotals(totals: UiProcessTotals): string {
  return [
    `All of CodeHydra: ${describeProcessSummary(totals.all)}`,
    `Workspaces: ${describeProcessSummary(totals.workspaces)}`,
    `Code server: ${describeProcessSummary(totals.codeServer)}`,
    `CodeHydra itself: ${describeProcessSummary(totals.codehydra)}`,
  ].join("\n");
}

/** A process row's tooltip in the tree: its command line, pid, directory and ports. */
export function describeProcessNode(node: UiProcessNode): string {
  return [
    node.commandLine ?? node.name,
    `pid ${node.pid}`,
    ...(node.cwd === null ? [] : [node.cwd]),
    ...(node.ports.length === 0 ? [] : [`ports ${node.ports.join(", ")}`]),
    describeProcessSummary(node.subtree),
  ].join("\n");
}

/**
 * The summaries added up: a collapsed project's. Null when none of them has one (the summary is off, or every row
 * is hibernated). CPU stays null only when none has a reading yet.
 */
export function sumProcessSummaries(
  summaries: readonly (UiProcessSummary | undefined)[]
): UiProcessSummary | null {
  const present = summaries.filter((summary): summary is UiProcessSummary => summary !== undefined);
  if (present.length === 0) return null;
  const cpus = present.flatMap((summary) =>
    summary.cpuPercent === null ? [] : [summary.cpuPercent]
  );
  return {
    cpuPercent: cpus.length === 0 ? null : cpus.reduce((a, b) => a + b, 0),
    rssBytes: present.reduce((total, summary) => total + summary.rssBytes, 0),
    count: present.reduce((total, summary) => total + summary.count, 0),
  };
}
