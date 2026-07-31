/**
 * Run a source's `cmd` and parse its stdout as a JSON array of domain objects.
 *
 * The cmd is a shell command line (pipes, quoting, env-var expansion), so it is
 * handed to the ProcessRunner with `shell: true` — Node builds the platform
 * invocation (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` with verbatim arguments
 * on Windows). Note that the shell *syntax* is still the platform's own: the
 * POSIX quoting in the settings help examples does not carry to cmd.exe.
 *
 * The process inherits the app's ambient environment (no `env` is passed, so
 * PersistedStore's replace-env behavior does not apply).
 */

import type { ProcessRunner } from "../../boundaries/platform/process";

export const CMD_TIMEOUT_MS = 30_000;

export interface RunCmdDeps {
  readonly processRunner: ProcessRunner;
}

/**
 * Execute `cmd` and return the parsed top-level JSON array. Throws on non-zero
 * exit, timeout, non-JSON output, or output that is not an array — the caller
 * logs and skips the tick.
 *
 * `sourceName` is only used as the command's logged identity: the cmd is
 * user-authored and routinely inlines an API token, so `redactBy` keeps the
 * line itself out of the log entirely (see ProcessOptions.redactBy).
 */
export async function runCmd(
  deps: RunCmdDeps,
  sourceName: string,
  cmd: string
): Promise<unknown[]> {
  const proc = deps.processRunner.run(cmd, [], {
    shell: true,
    redactBy: `${sourceName} cmd`,
  });
  const result = await proc.wait(CMD_TIMEOUT_MS);

  if (result.running) {
    await proc.kill(0, 2000);
    throw new Error(`cmd timed out after ${CMD_TIMEOUT_MS}ms`);
  }
  if (result.exitCode !== 0) {
    // Deliberately no stderr text: this message reaches the caller's `warn`
    // line, which is emitted at the DEFAULT log level, and a failing cmd can
    // echo its own credentials (a 401 body, a usage line quoting argv). The
    // byte count says whether the cmd said anything at all; the text itself is
    // recoverable at `silly` from the stderr line ProcessRunner logs.
    const stderrBytes = Buffer.byteLength(result.stderr);
    throw new Error(
      `cmd exited with ${result.exitCode ?? "signal"} (${stderrBytes} bytes of stderr)`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("cmd output is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("cmd output is not a JSON array");
  }
  return parsed;
}
