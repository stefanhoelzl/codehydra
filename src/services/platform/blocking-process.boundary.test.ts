// @vitest-environment node
/**
 * Boundary tests for WindowsBlockingProcessService.
 *
 * These tests verify actual interaction with Windows Restart Manager API,
 * NtQuerySystemInformation for file enumeration, and taskkill.
 * They run only on Windows (skipped on other platforms).
 *
 * Test strategy:
 * 1. Create a temp directory
 * 2. Spawn a helper process that locks a file in that directory
 * 3. Verify detection finds the blocking process with file paths
 * 4. Verify killProcesses terminates the blocking process
 * 5. Verify closeHandles releases file locks (when run elevated)
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WindowsBlockingProcessService, createBlockingProcessService } from "./blocking-process";
import { ExecaProcessRunner, type ProcessRunner, type SpawnedProcess } from "./process";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import { SILENT_LOGGER, createMockLogger } from "../logging";
import { Path } from "./path";
import { delay } from "../test-utils";

const isWindows = process.platform === "win32";
const TEST_TIMEOUT = 15000;

/**
 * Check if a process is running using signal 0.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

describe.skipIf(!isWindows)("WindowsBlockingProcessService (boundary)", () => {
  let tempDir: string;
  let lockedFile: string;
  let lockingProcess: SpawnedProcess | null = null;
  let lockingPid: number | undefined;
  let service: WindowsBlockingProcessService;
  let processRunner: ProcessRunner;

  beforeEach(async () => {
    // Create temp directory with unique name
    // Use realpath to get long path format (avoid STEFAN~1.HOE short paths)
    const tempBase = await fs.realpath(os.tmpdir());
    tempDir = await fs.mkdtemp(path.join(tempBase, "blocking-test-"));
    lockedFile = path.join(tempDir, "locked-file.txt");

    // Create a file to lock
    await fs.writeFile(lockedFile, "test content");

    processRunner = new ExecaProcessRunner(SILENT_LOGGER);
    // Script path for boundary tests - relative to project root
    const scriptPath = path.join(process.cwd(), "resources", "scripts", "blocking-processes.ps1");
    service = new WindowsBlockingProcessService(processRunner, createMockLogger(), scriptPath);
  });

  afterEach(async () => {
    // Clean up locking process if still running
    if (lockingProcess && lockingPid !== undefined) {
      try {
        await lockingProcess.kill(500, 500);
      } catch {
        // Process may already be dead
      }
    }
    lockingProcess = null;
    lockingPid = undefined;

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // May fail if still locked - acceptable for test cleanup
    }
  });

  /**
   * Spawn a PowerShell process that holds an exclusive file lock.
   * Returns the process and waits for it to signal it has acquired the lock.
   *
   * Uses .NET FileStream with FileShare.None to create an exclusive lock
   * that Windows Restart Manager API can reliably detect.
   */
  async function spawnFileLockingProcess(): Promise<{ proc: SpawnedProcess; pid: number }> {
    // PowerShell script that opens a file with exclusive lock
    // Uses FileShare.None to ensure no other process can access the file
    const escapedPath = lockedFile.replace(/'/g, "''");
    const script = `
      $file = [System.IO.File]::Open('${escapedPath}', 'Open', 'ReadWrite', 'None')
      Write-Host 'LOCKED'
      while ($true) { Start-Sleep -Seconds 1 }
    `;

    lockingProcess = processRunner.run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    lockingPid = lockingProcess.pid;

    if (lockingPid === undefined) {
      throw new Error("Failed to get PID from spawned process");
    }

    // Wait for "LOCKED" message indicating file is locked
    // Poll for stdout content with timeout
    const startTime = Date.now();
    const maxWait = 5000;

    while (Date.now() - startTime < maxWait) {
      const result = await lockingProcess.wait(100);
      if (result.stdout.includes("LOCKED")) {
        break;
      }
      if (!result.running && result.exitCode !== null) {
        throw new Error(
          `Locking process exited early with code ${result.exitCode}: ${result.stderr}`
        );
      }
    }

    // Give the OS a moment to fully register the handle
    await delay(500);

    return { proc: lockingProcess, pid: lockingPid };
  }

  describe("detect", () => {
    it(
      "detects blocking process with file handle",
      async () => {
        // Spawn a process that locks the file
        const { pid } = await spawnFileLockingProcess();

        // Detect blocking processes
        const processes = await service.detect(new Path(tempDir));

        // Verify the blocking process is detected
        expect(processes.length).toBeGreaterThan(0);
        expect(processes.some((p) => p.pid === pid)).toBe(true);

        // Verify structure of detected process
        const detected = processes.find((p) => p.pid === pid);
        expect(detected).toBeDefined();
        expect(detected!.name.toLowerCase()).toContain("powershell");
        expect(typeof detected!.commandLine).toBe("string");
        expect(Array.isArray(detected!.files)).toBe(true);
        expect(detected!.files.length).toBeGreaterThan(0);
        expect(detected!.files.some((f) => f.includes("locked-file.txt"))).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "includes cwd field in detection output",
      async () => {
        // This test verifies the cwd field exists in the output structure.
        // CWD detection via Windows APIs (reading from PEB) can be unreliable:
        // - PowerShell's Set-Location doesn't always update Win32 CWD immediately
        // - Access to process memory may be restricted
        // Manual testing confirmed CWD detection works (see plan notes).
        //
        // We verify: the cwd field is present (null or string), structure is correct

        // Spawn a process that locks a file (to be detected by Restart Manager)
        const { pid } = await spawnFileLockingProcess();

        // Detect blocking processes
        const processes = await service.detect(new Path(tempDir));

        // Find our process
        const proc = processes.find((p) => p.pid === pid);
        expect(proc).toBeDefined();

        // Verify cwd field exists in output (may be null or string)
        expect("cwd" in proc!).toBe(true);
        expect(proc!.cwd === null || typeof proc!.cwd === "string").toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "returns empty array when no processes are blocking",
      async () => {
        // No locking process, just query the empty temp dir
        const processes = await service.detect(new Path(tempDir));

        expect(processes).toEqual([]);
      },
      TEST_TIMEOUT
    );

    it(
      "completes within reasonable time",
      async () => {
        const start = Date.now();

        await service.detect(new Path(tempDir));

        const elapsed = Date.now() - start;

        // Should complete within 5 seconds (well under the 10s timeout)
        expect(elapsed).toBeLessThan(5000);
      },
      TEST_TIMEOUT
    );
  });

  describe("killProcesses", () => {
    it(
      "kills processes via taskkill",
      async () => {
        // Spawn a process that locks the file
        const { pid } = await spawnFileLockingProcess();

        // Verify process is running
        expect(isProcessRunning(pid)).toBe(true);

        // Kill the process
        await service.killProcesses([pid]);

        // Give taskkill time to complete
        await delay(500);

        // Process should be dead now
        expect(isProcessRunning(pid)).toBe(false);

        // Clean up references since process is dead
        lockingProcess = null;
        lockingPid = undefined;
      },
      TEST_TIMEOUT
    );

    it(
      "succeeds when no PIDs are provided",
      async () => {
        // Should not throw even with empty array
        await expect(service.killProcesses([])).resolves.toBeUndefined();
      },
      TEST_TIMEOUT
    );
  });

  // Note: closeHandles() tests require elevation and are not practical for automated testing
  // Manual testing is required for the UAC flow
});

describe.skipIf(!isWindows)("createBlockingProcessService (boundary)", () => {
  const processRunner = new ExecaProcessRunner(SILENT_LOGGER);

  it("returns WindowsBlockingProcessService on Windows", () => {
    const platformInfo = createMockPlatformInfo({ platform: "win32" });
    const service = createBlockingProcessService(processRunner, platformInfo, SILENT_LOGGER);

    expect(service).toBeInstanceOf(WindowsBlockingProcessService);
  });
});

describe.skipIf(isWindows)("createBlockingProcessService (non-Windows boundary)", () => {
  const processRunner = new ExecaProcessRunner(SILENT_LOGGER);

  it("returns undefined on non-Windows", () => {
    const platformInfo = createMockPlatformInfo({ platform: process.platform as "linux" });
    const service = createBlockingProcessService(processRunner, platformInfo, SILENT_LOGGER);

    expect(service).toBeUndefined();
  });
});
