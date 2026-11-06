/**
 * The sidebar's process summary, the presenter's part of it: the
 * `sidebar.process-summary` config key (off, or the process bar's level), the
 * level the pulse button turns it back on at (`sidebar.process-level`) and the
 * process tree's height (`sidebar.process-tree-height`), both in state.json;
 * the snapshot fields built from the process monitor's last scan; and the
 * process tree's kill button.
 *
 * The monitor polls only while the summary is on: every snapshot build sets
 * its watching to match (`sidebarFields`), so a change of the key from
 * anywhere — settings dialog, `ch config` — applies with the next push.
 */

import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import { storeEnum, storeNumber } from "../../boundaries/platform/store-definition";
import type { WorkspaceRef } from "../../intents/contract";
import { getErrorMessage } from "../../shared/error-utils";
import {
  PROCESS_BAR_LEVELS,
  PROCESS_SUMMARY_MODES,
  PROCESS_TREE_DEFAULT_HEIGHT,
  PROCESS_TREE_MAX_HEIGHT,
  PROCESS_TREE_MIN_HEIGHT,
  type ProcessBarLevel,
  type ProcessSummaryMode,
  type UiProcessSummary,
  type UiProcessTree,
  type UiProcessTreeProject,
  type UiState,
} from "../../shared/ui-state";
import type { ProcessMonitorModule } from "../process-monitor/process-monitor-module";

/** A project as the tree lists it: its workspaces in sidebar order. */
export interface ProcessBarProject {
  readonly id: string;
  readonly name: string;
  readonly workspaces: readonly {
    readonly ref: WorkspaceRef;
    readonly name: string;
    readonly hibernated: boolean;
  }[];
}

export interface ProcessBarDeps {
  readonly configService: Pick<Config, "register">;
  readonly stateService: Pick<StateService, "register">;
  readonly processMonitor: Pick<
    ProcessMonitorModule,
    "summaries" | "totals" | "trees" | "setWatching" | "killProcess"
  >;
  readonly logger: Logger;
  /** Re-push the snapshot. */
  readonly scheduleUpdate: () => void;
}

export interface ProcessBar {
  /** Whether the summary is on (rows show their numbers). */
  isOn(): boolean;
  /** A workspace's totals for its row, while the summary is on. */
  rowSummary(workspaceRef: WorkspaceRef): UiProcessSummary | undefined;
  /** The sidebar's process fields; also starts or stops the monitor's polling to match. */
  sidebarFields(
    projects: readonly ProcessBarProject[]
  ): Pick<
    UiState["sidebar"],
    "processSummary" | "processLevel" | "processTreeHeight" | "processTotals" | "processTree"
  >;
  /** Set the mode (the pulse button, the level buttons). */
  setMode(mode: ProcessSummaryMode): void;
  /** Off, or back on at the last level (Alt+X, P). */
  toggle(): void;
  /** Persist the tree's height after a drag. */
  resizeTree(fraction: number): void;
  /** Kill a workspace's process (the tree's kill button). */
  kill(pid: number, startedAt: string | null): void;
}

const MODE_BY_BOOLEAN: Readonly<Record<string, ProcessSummaryMode>> = {
  true: "total",
  false: "off",
};

export function createProcessBar(deps: ProcessBarDeps): ProcessBar {
  const { logger } = deps;
  const modeType = storeEnum(PROCESS_SUMMARY_MODES);

  // Was a boolean: `true` and `false` still read (as `total` and `off`), from
  // config.json, the env and the command line, until the next write replaces them.
  const modeConfig = deps.configService.register<ProcessSummaryMode>("sidebar.process-summary", {
    default: "off",
    description:
      "Sidebar process summary: off | total (rows and one total row) | breakdown (workspaces, code server, CodeHydra) | tree (every process)",
    applies: "live",
    ...modeType,
    parse: (raw) => MODE_BY_BOOLEAN[raw.trim().toLowerCase()] ?? modeType.parse(raw),
    validate: (value) =>
      typeof value === "boolean" ? (value ? "total" : "off") : modeType.validate(value),
  });

  const levelState = deps.stateService.register<ProcessBarLevel>("sidebar.process-level", {
    default: "total",
    description: "The process bar's last level: where the pulse button turns it back on",
    ...storeEnum(PROCESS_BAR_LEVELS),
  });

  const heightState = deps.stateService.register("sidebar.process-tree-height", {
    default: PROCESS_TREE_DEFAULT_HEIGHT,
    description: "The process tree's height, a fraction of the sidebar's",
    ...storeNumber({
      min: PROCESS_TREE_MIN_HEIGHT,
      max: PROCESS_TREE_MAX_HEIGHT,
      integer: false,
    }),
  });

  const isOn = (): boolean => modeConfig.get() !== "off";

  function persist(what: string, write: Promise<void>): void {
    void write.catch((error: unknown) => {
      logger.warn(`Failed to persist ${what}`, { error: getErrorMessage(error) });
    });
  }

  function setMode(mode: ProcessSummaryMode): void {
    // The next snapshot carries the new value even if persisting it fails.
    persist("process summary mode", modeConfig.set(mode));
    if (mode !== "off" && levelState.get() !== mode) {
      persist("process bar level", levelState.set(mode));
    }
    deps.scheduleUpdate();
  }

  function buildTree(projects: readonly ProcessBarProject[]): UiProcessTree | undefined {
    const trees = deps.processMonitor.trees();
    if (trees === null) return undefined;
    const treeProjects: UiProcessTreeProject[] = [];
    for (const project of projects) {
      const workspaces = project.workspaces.flatMap((workspace) => {
        const processes = workspace.hibernated ? undefined : trees.workspaces.get(workspace.ref);
        return processes === undefined || processes.processes.length === 0
          ? []
          : [
              {
                key: workspace.ref,
                name: workspace.name,
                total: processes.total,
                processes: processes.processes,
              },
            ];
      });
      if (workspaces.length === 0) continue;
      treeProjects.push({
        id: project.id,
        name: project.name,
        total: workspaces.map((workspace) => workspace.total).reduce(addSummaries),
        workspaces,
      });
    }
    return {
      projects: treeProjects,
      codeServer: trees.groups.get("codeServer")?.processes ?? [],
      codehydra: trees.groups.get("codehydra")?.processes ?? [],
    };
  }

  return {
    isOn,

    rowSummary: (workspaceRef) =>
      isOn() ? deps.processMonitor.summaries().get(workspaceRef) : undefined,

    sidebarFields(projects) {
      const mode = modeConfig.get();
      deps.processMonitor.setWatching(mode !== "off");
      const totals = mode === "off" ? null : deps.processMonitor.totals();
      const tree = mode === "tree" ? buildTree(projects) : undefined;
      return {
        processSummary: mode,
        processLevel: mode === "off" ? levelState.get() : mode,
        processTreeHeight: heightState.get(),
        ...(totals !== null && { processTotals: totals }),
        ...(tree !== undefined && { processTree: tree }),
      };
    },

    setMode,

    toggle: () => setMode(isOn() ? "off" : levelState.get()),

    resizeTree(fraction) {
      const clamped = Math.min(
        PROCESS_TREE_MAX_HEIGHT,
        Math.max(
          PROCESS_TREE_MIN_HEIGHT,
          Number.isFinite(fraction) ? fraction : PROCESS_TREE_DEFAULT_HEIGHT
        )
      );
      persist("process tree height", heightState.set(clamped));
      deps.scheduleUpdate();
    },

    kill(pid, startedAt) {
      void deps.processMonitor.killProcess(pid, startedAt).then(() => deps.scheduleUpdate());
    },
  };
}

/** Sum two totals; CPU stays null only when neither has a reading. */
function addSummaries(a: UiProcessSummary, b: UiProcessSummary): UiProcessSummary {
  return {
    cpuPercent:
      a.cpuPercent === null && b.cpuPercent === null
        ? null
        : (a.cpuPercent ?? 0) + (b.cpuPercent ?? 0),
    rssBytes: a.rssBytes + b.rssBytes,
    count: a.count + b.count,
  };
}
