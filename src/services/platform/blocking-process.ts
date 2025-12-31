/**
 * Blocking process detection and termination.
 * Used on Windows to identify and kill processes holding file handles.
 */

import type { Path } from "./path";
import type { ProcessRunner } from "./process";
import type { PlatformInfo } from "./platform-info";
import type { Logger } from "../logging";
import type { BlockingProcess } from "../../shared/api/types";

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when user cancels UAC elevation prompt.
 */
export class UACCancelledError extends Error {
  constructor() {
    super("UAC elevation was cancelled by the user");
    this.name = "UACCancelledError";
  }
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Service for detecting and killing processes that block file deletion.
 * Used during workspace deletion when files are locked by other processes.
 */
export interface BlockingProcessService {
  /**
   * Detect processes blocking access to files in the given path.
   * Returns empty array if no blocking processes found or on non-Windows platforms.
   *
   * @param path - Directory path to check for blocking processes
   * @returns Array of blocking process information with locked files and CWD
   */
  detect(path: Path): Promise<BlockingProcess[]>;

  /**
   * Kill processes by their PIDs using taskkill.
   * Throws error if taskkill exits non-zero.
   *
   * @param pids - Array of process IDs to kill
   */
  killProcesses(pids: number[]): Promise<void>;

  /**
   * Close file handles in the given path using elevated PowerShell.
   * Self-elevates via UAC prompt. Returns closed file paths.
   *
   * @param path - Directory path whose handles should be closed
   * @throws UACCancelledError if user cancels UAC prompt
   * @throws Error on other failures
   */
  closeHandles(path: Path): Promise<void>;
}

// =============================================================================
// JSON Output Types
// =============================================================================

/**
 * JSON output from the unified PowerShell script for -Action Detect mode.
 */
interface DetectOutput {
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files: string[];
    cwd: string | null;
  }>;
  error?: string;
}

/**
 * JSON output from the unified PowerShell script for -Action CloseHandles mode.
 */
interface CloseHandlesOutput extends DetectOutput {
  closed: string[];
}

// =============================================================================
// Windows Implementation
// =============================================================================

/** Max files per process in detect() output */
const MAX_FILES_PER_PROCESS = 20;

/** Timeout for detect() operation */
const DETECT_TIMEOUT_MS = 30_000;

/** Timeout for closeHandles() operation */
const CLOSE_HANDLES_TIMEOUT_MS = 60_000;

/**
 * Windows implementation using unified blocking-processes.ps1 script.
 * Uses Restart Manager API, NtQuerySystemInformation, and taskkill.
 */
export class WindowsBlockingProcessService implements BlockingProcessService {
  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly logger: Logger,
    private readonly scriptPath?: string
  ) {}

  async detect(path: Path): Promise<BlockingProcess[]> {
    if (!this.scriptPath) {
      throw new Error("script path not configured");
    }

    const proc = this.processRunner.run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-BasePath",
      path.toNative(),
      "-Action",
      "Detect",
    ]);

    const result = await proc.wait(DETECT_TIMEOUT_MS);

    if (result.running) {
      this.logger.warn("Blocking process detection timed out", { path: path.toString() });
      await proc.kill(1000, 1000);
      return [];
    }

    if (result.exitCode !== 0) {
      this.logger.warn("Blocking process detection failed", {
        path: path.toString(),
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      return [];
    }

    return this.parseDetectOutput(result.stdout);
  }

  async killProcesses(pids: number[]): Promise<void> {
    if (pids.length === 0) {
      return;
    }

    // Build taskkill arguments: /pid X /pid Y /t /f
    const args: string[] = [];
    for (const pid of pids) {
      args.push("/pid", String(pid));
    }
    args.push("/t", "/f");

    this.logger.info("Killing blocking processes", {
      pids: pids.join(","),
    });

    const killProc = this.processRunner.run("taskkill", args);
    const result = await killProc.wait(5000);

    if (result.exitCode !== 0) {
      const failedPids = pids.join(", ");
      this.logger.warn("Some blocking processes could not be killed", {
        pids: failedPids,
        stderr: result.stderr,
      });
      throw new Error(`Failed to kill processes (PIDs: ${failedPids}): ${result.stderr}`);
    }
  }

  async closeHandles(path: Path): Promise<void> {
    if (!this.scriptPath) {
      throw new Error("script path not configured");
    }

    // Run the script with -Action CloseHandles
    // The script will self-elevate via UAC if needed
    const proc = this.processRunner.run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-BasePath",
      path.toNative(),
      "-Action",
      "CloseHandles",
    ]);

    const result = await proc.wait(CLOSE_HANDLES_TIMEOUT_MS);

    if (result.running) {
      this.logger.warn("Close handles operation timed out", {
        path: path.toString(),
      });
      await proc.kill(1000, 1000);
      throw new Error("Close handles operation timed out");
    }

    // Parse JSON output
    const output = result.stdout.trim();
    if (!output) {
      if (result.exitCode !== 0) {
        throw new Error(`Failed to close handles: exit code ${result.exitCode}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(output) as CloseHandlesOutput | { error: string };

      // Check for error response
      if ("error" in parsed && typeof parsed.error === "string") {
        if (parsed.error.includes("UAC cancelled")) {
          throw new UACCancelledError();
        }
        throw new Error(parsed.error);
      }

      // Log closed files
      const closeHandlesOutput = parsed as CloseHandlesOutput;
      if (closeHandlesOutput.closed && closeHandlesOutput.closed.length > 0) {
        this.logger.info("Closed file handles", {
          path: path.toString(),
          closedCount: closeHandlesOutput.closed.length,
        });
      } else {
        this.logger.info("No file handles to close", { path: path.toString() });
      }
    } catch (error) {
      if (error instanceof UACCancelledError) {
        throw error;
      }
      if (error instanceof Error && error.message !== "Unexpected end of JSON input") {
        throw error;
      }
      // JSON parse error with non-JSON output
      this.logger.warn("Failed to parse closeHandles output", {
        stdout: output,
        error: error instanceof Error ? error.message : String(error),
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to close handles: exit code ${result.exitCode}`);
      }
    }
  }

  /**
   * Parse PowerShell JSON output into BlockingProcess array.
   */
  private parseDetectOutput(stdout: string): BlockingProcess[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as DetectOutput | { error: string };

      // Check for error response
      if ("error" in parsed && typeof parsed.error === "string") {
        this.logger.warn("Blocking process detection returned error", { error: parsed.error });
        return [];
      }

      const detectOutput = parsed as DetectOutput;
      if (!detectOutput.blocking || !Array.isArray(detectOutput.blocking)) {
        return [];
      }

      const result: BlockingProcess[] = [];
      for (const item of detectOutput.blocking) {
        if (this.isValidBlockingProcess(item)) {
          const files = Array.isArray(item.files)
            ? item.files
                .filter((f): f is string => typeof f === "string")
                .slice(0, MAX_FILES_PER_PROCESS)
            : [];

          result.push({
            pid: item.pid,
            name: String(item.name),
            commandLine: String(item.commandLine),
            files,
            cwd: typeof item.cwd === "string" ? item.cwd : null,
          });
        }
      }

      return result;
    } catch (error) {
      this.logger.warn("Failed to parse blocking process output", {
        stdout,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Type guard for validating parsed JSON structure.
   */
  private isValidBlockingProcess(
    item: unknown
  ): item is { pid: number; name: unknown; commandLine: unknown; files: unknown; cwd: unknown } {
    return (
      typeof item === "object" &&
      item !== null &&
      "pid" in item &&
      typeof (item as { pid: unknown }).pid === "number" &&
      "name" in item &&
      "commandLine" in item
    );
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create appropriate BlockingProcessService based on platform.
 *
 * @param processRunner - Process runner for spawning PowerShell/taskkill
 * @param platformInfo - Platform information to determine implementation
 * @param logger - Logger for diagnostics
 * @param scriptPath - Path to blocking-processes.ps1 script (required on Windows)
 * @returns BlockingProcessService implementation on Windows, undefined on other platforms
 */
export function createBlockingProcessService(
  processRunner: ProcessRunner,
  platformInfo: PlatformInfo,
  logger: Logger,
  scriptPath?: string
): BlockingProcessService | undefined {
  if (platformInfo.platform === "win32") {
    return new WindowsBlockingProcessService(processRunner, logger, scriptPath);
  }
  return undefined;
}
