/**
 * Manual test script for blocking process detection and handle closing.
 *
 * This script:
 * 1. Creates a temp directory with a locked file
 * 2. Spawns a process holding the file lock
 * 3. Calls detect() to show blocking processes with CWD detection
 * 4. Calls closeHandles() which triggers UAC
 * 5. Shows the JSON output from both operations
 *
 * Run with: npx tsx scripts/test-blocking-processes.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WindowsBlockingProcessService } from "../src/services/platform/blocking-process";
import { ExecaProcessRunner } from "../src/services/platform/process";
import type { Logger } from "../src/services/logging";
import { Path } from "../src/services/platform/path";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.error("This script only works on Windows");
    process.exit(1);
  }

  // Create temp directory
  const tempBase = await fs.realpath(os.tmpdir());
  const tempDir = await fs.mkdtemp(path.join(tempBase, "blocking-test-"));
  const subDir = path.join(tempDir, "subdir");
  await fs.mkdir(subDir);
  const lockedFile = path.join(subDir, "locked-file.txt");

  // Get the path to the unified script
  const scriptPath = path.join(process.cwd(), "resources", "scripts", "blocking-processes.ps1");

  console.log("=".repeat(60));
  console.log("Blocking Process Detection & Handle Closing Test");
  console.log("=".repeat(60));
  console.log(`Temp directory: ${tempDir}`);
  console.log(`Locked file: ${lockedFile}`);
  console.log(`Script path: ${scriptPath}`);
  console.log();

  // Verify the script exists
  try {
    await fs.access(scriptPath);
  } catch {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Create file to lock
  await fs.writeFile(lockedFile, "test content for handle closing");

  // Create simple logger that prints to console
  const logger: Logger = {
    silly: (msg, ctx) => console.log(`[APP LOG] [silly] ${msg}`, ctx ?? ""),
    debug: (msg, ctx) => console.log(`[APP LOG] [debug] ${msg}`, ctx ?? ""),
    info: (msg, ctx) => console.log(`[APP LOG] [info] ${msg}`, ctx ?? ""),
    warn: (msg, ctx) => console.log(`[APP LOG] [warn] ${msg}`, ctx ?? ""),
    error: (msg, ctx) => console.log(`[APP LOG] [error] ${msg}`, ctx ?? ""),
  };

  const processRunner = new ExecaProcessRunner(logger);
  const service = new WindowsBlockingProcessService(processRunner, logger, scriptPath);

  // Spawn a process that locks the file WITH CWD inside the temp directory
  console.log("Spawning process to lock the file (with CWD inside workspace)...");
  const escapedPath = lockedFile.replace(/'/g, "''");
  const escapedCwd = subDir.replace(/'/g, "''");
  const script = `
    [System.IO.Directory]::SetCurrentDirectory('${escapedCwd}')
    $file = [System.IO.File]::Open('${escapedPath}', 'Open', 'ReadWrite', 'None')
    Write-Host 'LOCKED'
    while ($true) { Start-Sleep -Seconds 1 }
  `;

  const lockingProcess = processRunner.run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);

  // Wait for lock to be acquired
  const startTime = Date.now();
  while (Date.now() - startTime < 5000) {
    const result = await lockingProcess.wait(100);
    if (result.stdout.includes("LOCKED")) {
      break;
    }
  }
  await delay(500);

  console.log(`Locking process PID: ${lockingProcess.pid}`);
  console.log();

  // Detect blocking processes
  console.log("=".repeat(60));
  console.log("Calling detect() - detecting blocking processes...");
  console.log("=".repeat(60));
  const detected = await service.detect(new Path(tempDir));
  console.log();
  console.log(`Detected ${detected.length} blocking process(es):`);
  for (const proc of detected) {
    console.log(`  - ${proc.name} (PID ${proc.pid})`);
    console.log(`    Command: ${proc.commandLine.slice(0, 80)}...`);
    console.log(`    CWD: ${proc.cwd ?? "(outside workspace)"}`);
    console.log(`    Files: ${proc.files.join(", ") || "(none detected)"}`);
  }
  console.log();

  // Ask user if they want to proceed with closeHandles
  console.log("=".repeat(60));
  console.log("Next step: closeHandles() - will trigger UAC prompt!");
  console.log("The script will self-elevate and close the file handles.");
  console.log("=".repeat(60));
  console.log();

  try {
    await service.closeHandles(new Path(tempDir));
    console.log();
    console.log("closeHandles() completed successfully!");
  } catch (error) {
    console.log();
    console.error("closeHandles() failed:", error);
  }

  // Clean up
  console.log();
  console.log("Cleaning up...");
  try {
    await lockingProcess.kill(500, 500);
  } catch {
    // May already be dead if handles were closed
  }

  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log("Temp directory removed successfully");
  } catch (e) {
    console.log("Could not remove temp directory (may still be locked):", e);
  }

  console.log();
  console.log("Test complete!");
}

main().catch(console.error);
