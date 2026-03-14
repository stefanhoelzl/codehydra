/**
 * WindowsFileLockModule — Handles Windows file lock detection/removal during workspace deletion.
 *
 * Hooks:
 * - delete-workspace → release: CWD-only scan + kill blocking processes (best-effort)
 * - delete-workspace → detect: full handle detection
 * - delete-workspace → flush: kill PIDs collected by detect
 *
 * Detection uses blocking-processes.ps1 with Restart Manager API, NtQuerySystemInformation,
 * and taskkill for process termination.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { ProcessRunner } from "../../services/platform/process";
import type { BlockingProcess } from "../../shared/api/types";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type DeletePipelineHookInput,
  type ReleaseHookResult,
  type DetectHookResult,
  type FlushHookResult,
  type FlushHookInput,
} from "../operations/delete-workspace";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../shared/error-utils";

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
// JSON Output Types
// =============================================================================

/** JSON output from the unified PowerShell script for -Action Detect mode. */
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

/** JSON output from the unified PowerShell script for -Action CloseHandles mode. */
interface CloseHandlesOutput extends DetectOutput {
  closed: string[];
}

// =============================================================================
// Constants
// =============================================================================

/** Max files per process in detect output */
const MAX_FILES_PER_PROCESS = 20;

/** Timeout for detect operations */
const DETECT_TIMEOUT_MS = 30_000;

/** Timeout for closeHandles operation */
const CLOSE_HANDLES_TIMEOUT_MS = 60_000;

/** Timeout for taskkill */
const KILL_TIMEOUT_MS = 5_000;

// =============================================================================
// Exported Functions (for testing and boundary tests)
// =============================================================================

/**
 * Parse PowerShell JSON output into BlockingProcess array.
 * Exported for testing.
 */
export function parseDetectOutput(stdout: string, logger: Logger): BlockingProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as DetectOutput | { error: string };

    // Check for error response
    if ("error" in parsed && typeof parsed.error === "string") {
      logger.warn("Blocking process detection returned error", { error: parsed.error });
      return [];
    }

    const detectOutput = parsed as DetectOutput;
    if (!detectOutput.blocking || !Array.isArray(detectOutput.blocking)) {
      return [];
    }

    const result: BlockingProcess[] = [];
    for (const item of detectOutput.blocking) {
      if (isValidBlockingProcess(item)) {
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
    logger.warn("Failed to parse blocking process output", {
      stdout,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Type guard for validating parsed JSON structure. */
function isValidBlockingProcess(
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

/**
 * Run a detect action using the blocking-processes.ps1 script.
 * Exported for boundary tests.
 */
export async function runDetectAction(
  processRunner: ProcessRunner,
  scriptPath: string,
  path: Path,
  action: "Detect" | "DetectCwd",
  logger: Logger
): Promise<BlockingProcess[]> {
  const proc = processRunner.run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-BasePath",
    path.toNative(),
    "-Action",
    action,
  ]);

  const result = await proc.wait(DETECT_TIMEOUT_MS);

  if (result.running) {
    logger.warn("Blocking process detection timed out", {
      path: path.toString(),
      action,
    });
    await proc.kill(1000, 1000);
    return [];
  }

  if (result.exitCode !== 0) {
    logger.warn("Blocking process detection failed", {
      path: path.toString(),
      action,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return [];
  }

  return parseDetectOutput(result.stdout, logger);
}

/**
 * Kill processes by their PIDs using taskkill.
 * Exported for boundary tests.
 */
export async function killBlockingProcesses(
  processRunner: ProcessRunner,
  pids: number[],
  logger: Logger
): Promise<void> {
  if (pids.length === 0) {
    return;
  }

  // Build taskkill arguments: /pid X /pid Y /t /f
  const args: string[] = [];
  for (const pid of pids) {
    args.push("/pid", String(pid));
  }
  args.push("/t", "/f");

  logger.info("Killing blocking processes", {
    pids: pids.join(","),
  });

  const killProc = processRunner.run("taskkill", args);
  const result = await killProc.wait(KILL_TIMEOUT_MS);

  if (result.exitCode !== 0) {
    const failedPids = pids.join(", ");
    throw new Error(`Failed to kill processes (PIDs: ${failedPids}): ${result.stderr}`);
  }
}

/**
 * Close file handles in the given path using elevated PowerShell.
 * Self-elevates via UAC prompt.
 * Exported for boundary tests.
 */
export async function closeFileHandles(
  processRunner: ProcessRunner,
  scriptPath: string,
  path: Path,
  logger: Logger
): Promise<void> {
  const proc = processRunner.run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-BasePath",
    path.toNative(),
    "-Action",
    "CloseHandles",
  ]);

  const result = await proc.wait(CLOSE_HANDLES_TIMEOUT_MS);

  if (result.running) {
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
      logger.info("Closed file handles", {
        path: path.toString(),
        closedCount: closeHandlesOutput.closed.length,
      });
    } else {
      logger.info("No file handles to close", { path: path.toString() });
    }
  } catch (error) {
    if (error instanceof UACCancelledError) {
      throw error;
    }
    if (error instanceof Error && error.message !== "Unexpected end of JSON input") {
      throw error;
    }
    // JSON parse error with non-JSON output
    logger.warn("Failed to parse closeHandles output", {
      stdout: output,
      error: error instanceof Error ? error.message : String(error),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to close handles: exit code ${result.exitCode}`, { cause: error });
    }
  }
}

// =============================================================================
// Module Factory
// =============================================================================

interface WindowsFileLockModuleDeps {
  readonly processRunner: ProcessRunner;
  readonly scriptPath: string;
  readonly logger: Logger;
}

export function createWindowsFileLockModule(deps: WindowsFileLockModuleDeps): IntentModule {
  return {
    name: "windows-file-lock",
    requires: { platform: "win32" },
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force) {
              return {};
            }

            // CWD-only scan: find and kill processes whose CWD is under workspace
            try {
              const cwdProcesses = await runDetectAction(
                deps.processRunner,
                deps.scriptPath,
                new Path(workspacePath),
                "DetectCwd",
                deps.logger
              );
              if (cwdProcesses.length > 0) {
                deps.logger.info("Killing CWD-blocking processes before deletion", {
                  workspacePath,
                  pids: cwdProcesses.map((p) => p.pid).join(","),
                });
                await killBlockingProcesses(
                  deps.processRunner,
                  cwdProcesses.map((p) => p.pid),
                  deps.logger
                );
              }
            } catch {
              // Non-fatal: CWD detection/kill failure shouldn't block deletion
            }
            return {};
          },
        },
        detect: {
          handler: async (ctx: HookContext): Promise<DetectHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;

            try {
              const detected = await runDetectAction(
                deps.processRunner,
                deps.scriptPath,
                new Path(workspacePath),
                "Detect",
                deps.logger
              );
              return { blockingProcesses: detected };
            } catch (error) {
              deps.logger.warn("Detection failed", {
                workspacePath,
                error: getErrorMessage(error),
              });
              return { blockingProcesses: [] };
            }
          },
        },
        flush: {
          handler: async (ctx: HookContext): Promise<FlushHookResult> => {
            const { blockingPids } = ctx as FlushHookInput;
            if (blockingPids.length > 0) {
              try {
                await killBlockingProcesses(deps.processRunner, [...blockingPids], deps.logger);
              } catch (error) {
                return { error: getErrorMessage(error) };
              }
            }
            return {};
          },
        },
      },
    },
  };
}
