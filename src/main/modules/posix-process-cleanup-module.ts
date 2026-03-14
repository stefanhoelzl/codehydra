/**
 * PosixProcessCleanupModule — Kills processes whose CWD is under the workspace path during deletion.
 *
 * Hooks:
 * - delete-workspace → release: Use lsof to find CWD matches, kill with SIGTERM (best-effort)
 *
 * Detection uses `lsof -d cwd +c 0 -Fpnc` for machine-parseable output.
 * lsof exit code 1 means "no files found" and is not treated as an error.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { ProcessRunner, ProcessResult } from "../../services/platform/process";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type DeletePipelineHookInput,
  type ReleaseHookResult,
} from "../operations/delete-workspace";

/** Detected process info from lsof. */
export interface DetectedProcess {
  readonly pid: number;
  readonly name: string;
  readonly cwd: string;
}

const DETECT_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Parse lsof -Fpnc output into DetectedProcess array.
 * Format: lines starting with p=PID, c=command, n=path.
 * Each process entry starts with a 'p' line.
 * Filters by workspace path prefix and excludes current process PID.
 */
function parseLsofOutput(stdout: string, workspacePath: string): DetectedProcess[] {
  const ownPid = process.pid;
  const results: DetectedProcess[] = [];
  let currentPid: number | undefined;
  let currentName = "unknown";

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;

    const prefix = line[0];
    const value = line.slice(1);

    switch (prefix) {
      case "p":
        currentPid = Number(value);
        currentName = "unknown";
        break;
      case "c":
        currentName = value;
        break;
      case "n":
        if (
          currentPid !== undefined &&
          !Number.isNaN(currentPid) &&
          currentPid !== ownPid &&
          (value === workspacePath || value.startsWith(workspacePath + "/"))
        ) {
          results.push({ pid: currentPid, name: currentName, cwd: value });
        }
        break;
    }
  }

  return results;
}

/**
 * Detect processes whose CWD is under the given workspace path using lsof.
 * Exported for testing.
 */
export async function detectCwdProcesses(
  processRunner: ProcessRunner,
  workspacePath: string,
  logger: Logger
): Promise<DetectedProcess[]> {
  const proc = processRunner.run("lsof", ["-d", "cwd", "+c", "0", "-Fpnc"]);
  const result: ProcessResult = await proc.wait(DETECT_TIMEOUT_MS);

  if (result.running) {
    logger.warn("Process detection timed out", { workspacePath });
    await proc.kill(1000, 1000);
    return [];
  }

  // lsof exit code 1 = "no files found" (not an error)
  if (result.exitCode !== null && result.exitCode !== 0 && result.exitCode !== 1) {
    logger.warn("Process detection failed", {
      workspacePath,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return [];
  }

  return parseLsofOutput(result.stdout, workspacePath);
}

/**
 * Kill a list of PIDs with SIGTERM via `kill`.
 * Exported for testing.
 */
export async function killPosixProcesses(
  processRunner: ProcessRunner,
  pids: readonly number[]
): Promise<void> {
  if (pids.length === 0) return;

  const args = ["-TERM", ...pids.map(String)];
  const proc = processRunner.run("kill", args);
  const result = await proc.wait(KILL_TIMEOUT_MS);

  if (result.exitCode !== 0 && result.exitCode !== null) {
    const stderrLines = result.stderr.split("\n").filter((l) => l.trim() !== "");
    const allNoSuchProcess =
      stderrLines.length > 0 && stderrLines.every((l) => l.includes("No such process"));

    if (allNoSuchProcess) {
      return;
    }

    throw new Error(`kill -TERM failed: exit ${result.exitCode} — ${result.stderr}`);
  }
}

interface PosixProcessCleanupModuleDeps {
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
}

export function createPosixProcessCleanupModule(deps: PosixProcessCleanupModuleDeps): IntentModule {
  return {
    name: "posix-process-cleanup",
    requires: { posix: true },
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force) {
              return {};
            }

            try {
              const detected = await detectCwdProcesses(
                deps.processRunner,
                workspacePath,
                deps.logger
              );

              if (detected.length > 0) {
                deps.logger.info("Killing CWD-blocking processes before deletion", {
                  workspacePath,
                  pids: detected.map((p) => p.pid).join(","),
                });
                await killPosixProcesses(
                  deps.processRunner,
                  detected.map((p) => p.pid)
                );
              }
            } catch {
              // Non-fatal: detection/kill failure shouldn't block deletion
            }
            return {};
          },
        },
      },
    },
  };
}
