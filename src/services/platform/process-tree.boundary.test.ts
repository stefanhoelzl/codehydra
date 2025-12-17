// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { PidtreeProvider } from "./process-tree";
import { ExecaProcessRunner } from "./process";
import { createSilentLogger } from "../logging";
import {
  spawnWithChildren,
  spawnLongRunning,
  isWindows,
  type ProcessWithChildren,
} from "./process.boundary-test-utils";

// Default timeout for boundary tests
const TEST_TIMEOUT = 5000;

describe("PidtreeProvider", () => {
  const logger = createSilentLogger();
  const provider = new PidtreeProvider(logger);
  const processTree = new PidtreeProvider(logger);
  const runner = new ExecaProcessRunner(processTree, logger);

  // Track spawned processes for cleanup
  let spawnedWithChildren: ProcessWithChildren | null = null;
  let spawnedProcess: ReturnType<typeof spawnLongRunning> | null = null;

  afterEach(async () => {
    // Clean up processes spawned with children
    if (spawnedWithChildren !== null) {
      await spawnedWithChildren.cleanup();
      spawnedWithChildren = null;
    }

    // Clean up simple spawned processes
    if (spawnedProcess !== null) {
      await spawnedProcess.kill(0, 100);
      spawnedProcess = null;
    }
  });

  it(
    "pidtree library works on current platform (smoke test)",
    async () => {
      // Get descendants of current process - should work without error
      const descendants = await provider.getDescendantPids(process.pid);

      // Current test process may have child processes (vitest workers, etc.)
      // Just verify we get a Set back without error
      expect(descendants).toBeInstanceOf(Set);
    },
    TEST_TIMEOUT
  );

  it(
    "returns descendant PIDs for process with children",
    async () => {
      // Spawn a process that creates 2 child processes
      spawnedWithChildren = spawnWithChildren(runner, 2);
      const childPids = await spawnedWithChildren.waitForChildPids();

      // Get descendants of the parent process
      const parentPid = spawnedWithChildren.process.pid;
      expect(parentPid).toBeDefined();

      const descendants = await provider.getDescendantPids(parentPid!);

      // Should contain both child PIDs
      expect(descendants.size).toBeGreaterThanOrEqual(2);
      for (const childPid of childPids) {
        expect(descendants.has(childPid)).toBe(true);
      }
    },
    TEST_TIMEOUT
  );

  // Skip on Windows: Node.js processes may have OS-level children (e.g., conhost.exe)
  // that aren't spawned by our code, causing pidtree to return non-empty results
  it.skipIf(isWindows)(
    "returns empty Set for process without children",
    async () => {
      // Spawn a simple long-running process with no children
      spawnedProcess = spawnLongRunning(runner, 30_000);
      const pid = spawnedProcess.pid;
      expect(pid).toBeDefined();

      const descendants = await provider.getDescendantPids(pid!);

      // Should be empty - no children
      expect(descendants.size).toBe(0);
    },
    TEST_TIMEOUT
  );

  it(
    "returns empty Set for non-existent PID",
    async () => {
      // Use a PID that's very unlikely to exist
      const nonExistentPid = 999999999;

      const descendants = await provider.getDescendantPids(nonExistentPid);

      // Should return empty Set, not throw
      expect(descendants).toBeInstanceOf(Set);
      expect(descendants.size).toBe(0);
    },
    TEST_TIMEOUT
  );

  it(
    "returns empty Set after process exits",
    async () => {
      // Spawn a simple process that exits immediately
      const proc = runner.run(process.execPath, ["-e", "process.exit(0)"]);
      await proc.wait();

      // Process has exited, try to get its descendants
      const descendants = await provider.getDescendantPids(proc.pid ?? 999999999);

      // Should return empty Set, not throw
      expect(descendants).toBeInstanceOf(Set);
      expect(descendants.size).toBe(0);
    },
    TEST_TIMEOUT
  );
});
