/**
 * `workspace.processes` — the processes running in a workspace (`ch ws
 * processes`, MCP `workspace_list_processes`, the sidekick's Processes view).
 *
 * The scanning and attribution live in the process-monitor module, reached
 * through `deps.processes`; this entry only resolves the target.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps } from "./deps";
import { createTargetResolver, targetFields } from "./target";

export function processEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const targetOf = createTargetResolver(deps.dispatcher);

  const list = defineEntry({
    name: "workspace.processes",
    kind: "command",
    description: "List the processes running in a workspace, with CPU, memory and listening ports.",
    instructions:
      "A process belongs to the workspace when its working directory is inside the worktree, " +
      "or when it was started by one that is, even after it changed directory — so a dev " +
      "server started from a workspace terminal is listed with its whole tree. Includes the " +
      "workspace's agent and terminal shells. processes holds the tree's roots; each has its " +
      "children and subtree totals. cpuPercent is percent of one core over the last few " +
      "seconds (null when it could not be measured); rssBytes is resident memory; ports are " +
      "the TCP ports it listens on. Read-only: nothing here stops a process.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await deps.processes.list(await targetOf(ctx, input));
      if (result === null) {
        throw new ApiError("failed", "Could not list the processes (the process scan failed).");
      }
      return result;
    },
  });

  return [list];
}
