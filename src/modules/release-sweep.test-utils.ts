/**
 * The process monitor as the release sweep sees it: a fixed answer to
 * `teardownProcesses`, and a record of what it was asked.
 */

import type { WorkspaceRef } from "../intents/contract";
import type { ProcessMonitorModule } from "./process-monitor/process-monitor-module";
import type { TeardownProcess } from "./process-monitor/attribution";

/** One `teardownProcesses` call. */
export interface TeardownCall {
  readonly ref: WorkspaceRef;
  readonly path: string;
  readonly cwdInside: boolean;
}

/**
 * A monitor answering every `teardownProcesses` with `answer`: the processes,
 * null (a failed scan), or an Error to throw.
 */
export function teardownMonitor(
  answer: readonly TeardownProcess[] | null | Error,
  calls: TeardownCall[] = []
): Pick<ProcessMonitorModule, "teardownProcesses"> {
  return {
    async teardownProcesses(workspace, options) {
      calls.push({ ref: workspace.ref, path: workspace.path, cwdInside: options.cwdInside });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
