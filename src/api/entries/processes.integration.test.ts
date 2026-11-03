// @vitest-environment node
/**
 * Integration tests for the workspace.processes entry: it asks the monitor
 * about the caller's workspace, and reports a failed scan as a failure rather
 * than as a workspace running nothing.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { ApiError } from "../errors";
import type { WorkspaceRef } from "../../intents/contract";
import { createRegistry } from "./index";
import { createLockModule } from "../../modules/lock-module";
import type { WorkspaceProcesses } from "./deps";

const CALLER = "ch::m::p::alpha" as WorkspaceRef;

const PROCESSES: WorkspaceProcesses = {
  scannedAt: "2026-11-01T00:00:00.000Z",
  total: { cpuPercent: 3, rssBytes: 2048, count: 1 },
  processes: [],
};

function call(list: (workspace: WorkspaceRef) => Promise<WorkspaceProcesses | null>) {
  const asked: WorkspaceRef[] = [];
  const registry = createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      processes: {
        list: (workspace) => {
          asked.push(workspace);
          return list(workspace);
        },
      },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );
  const result = registry.invoke(
    registry.get("workspace.processes"),
    { workspaceRef: CALLER, cwd: null, signal: new AbortController().signal },
    {}
  );
  return { result, asked };
}

describe("workspace.processes entry", () => {
  it("lists the caller's workspace", async () => {
    const { result, asked } = call(async () => PROCESSES);
    expect(await result).toEqual(PROCESSES);
    expect(asked).toEqual([CALLER]);
  });

  it("fails when the scan failed", async () => {
    const { result } = call(async () => null);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ category: "failed" });
  });
});
