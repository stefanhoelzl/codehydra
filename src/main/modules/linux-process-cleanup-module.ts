/**
 * LinuxProcessCleanupModule — Kills processes whose CWD is under the workspace path during deletion.
 *
 * Hooks:
 * - delete-workspace → release: Scan /proc for CWD matches, kill with SIGTERM (best-effort)
 *
 * Detection uses a shell script that reads /proc/[pid]/cwd symlinks.
 * Workspace path is passed via TARGET_PATH env var to avoid shell injection.
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

/** Detected process info from /proc scan. */
export interface DetectedProcess {
  readonly pid: number;
  readonly name: string;
  readonly cwd: string;
  readonly cmdline: string;
}

const DETECT_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Shell script that scans /proc for processes whose CWD starts with TARGET_PATH.
 * Output: tab-separated lines: PID\tNAME\tCWD\tCMDLINE
 */
const DETECT_SCRIPT = `
for pid_dir in /proc/[0-9]*/; do
  pid=$(basename "$pid_dir")
  cwd=$(readlink "$pid_dir/cwd" 2>/dev/null) || continue
  case "$cwd" in "$TARGET_PATH"|"$TARGET_PATH/"*)
    name=$(cat "$pid_dir/comm" 2>/dev/null || echo "unknown")
    cmdline=$(tr '\\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || echo "")
    printf '%s\\t%s\\t%s\\t%s\\n' "$pid" "$name" "$cwd" "$cmdline"
  ;; esac
done
`;

/**
 * Parse tab-separated /proc scan output into DetectedProcess array.
 * Filters out the current process PID.
 */
function parseProcOutput(stdout: string): DetectedProcess[] {
  const ownPid = process.pid;
  const results: DetectedProcess[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const pid = Number(parts[0]);
    if (Number.isNaN(pid) || pid === ownPid) continue;

    results.push({
      pid,
      name: parts[1] ?? "unknown",
      cwd: parts[2] ?? "",
      cmdline: parts[3] ?? "",
    });
  }

  return results;
}

/**
 * Detect processes whose CWD is under the given workspace path using /proc.
 * Exported for testing.
 */
export async function detectLinuxCwdProcesses(
  processRunner: ProcessRunner,
  workspacePath: string,
  logger: Logger
): Promise<DetectedProcess[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, TARGET_PATH: workspacePath };
  const proc = processRunner.run("bash", ["-c", DETECT_SCRIPT], { env });
  const result: ProcessResult = await proc.wait(DETECT_TIMEOUT_MS);

  if (result.running) {
    logger.warn("Process detection timed out", { workspacePath });
    await proc.kill(1000, 1000);
    return [];
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    logger.warn("Process detection failed", {
      workspacePath,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return [];
  }

  return parseProcOutput(result.stdout);
}

/**
 * Kill a list of PIDs with SIGTERM via `kill`.
 * Exported for testing.
 */
export async function killUnixProcesses(
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

interface LinuxProcessCleanupModuleDeps {
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
}

export function createLinuxProcessCleanupModule(deps: LinuxProcessCleanupModuleDeps): IntentModule {
  return {
    name: "linux-process-cleanup",
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
              const detected = await detectLinuxCwdProcesses(
                deps.processRunner,
                workspacePath,
                deps.logger
              );

              if (detected.length > 0) {
                deps.logger.info("Killing CWD-blocking processes before deletion", {
                  workspacePath,
                  pids: detected.map((p) => p.pid).join(","),
                });
                await killUnixProcesses(
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
