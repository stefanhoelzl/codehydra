// @vitest-environment node
/**
 * Boundary test for the hook registration CodeHydra writes into Claude's
 * settings file.
 *
 * Claude runs a hook with `args` in *exec form*: it spawns `command` directly
 * with that argument vector and no shell. So this spawns it the same way —
 * `shell: false` — rather than through `sh -c` or `cmd /c`, which would test an
 * invocation Claude never performs.
 *
 * What this pins down, and what unit assertions cannot:
 *  - the interpreter we name is actually spawnable
 *  - a handler path containing a space arrives as ONE argument, unquoted
 *  - the hook name arrives as the handler's next argument
 *
 * The shell-form version of this test failed on Windows precisely because a
 * quoted command string cannot be written portably across sh, Git Bash and
 * PowerShell. Exec form is what removes the question.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { buildSettingsFile } from "./server-manager";
import { createTempDir } from "../../../utils/testing/test-utils";

/** Echoes its own argv so the caller can see exactly what it was handed. */
const PROBE_BODY = `process.stdout.write("ARGV:" + process.argv.slice(2).join("|"));`;

let tempCleanup: () => Promise<void>;
/** A handler path with a space in it — the case that broke under a shell. */
let handlerPath: string;

beforeAll(async () => {
  const temp = await createTempDir();
  tempCleanup = temp.cleanup;
  const dir = join(temp.path, "hook handler dir");
  await mkdir(dir, { recursive: true });
  handlerPath = join(dir, "claude code hook handler.cjs");
  await writeFile(handlerPath, PROBE_BODY);
});

afterAll(async () => {
  await tempCleanup();
});

/** Spawn a registration the way Claude does in exec form: no shell. */
function runExecForm(
  command: string,
  args: readonly string[]
): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (status) => resolvePromise({ stdout, status }));
  });
}

/** The registration written for one hook. */
function registrationFor(hookName: string) {
  // process.execPath is this machine's real node — absolute, and on Windows a
  // native path with backslashes, which is the shape production passes.
  const settings = buildSettingsFile(handlerPath, process.execPath);
  return settings.hooks[hookName]![0]!.hooks[0]!;
}

describe("generated hook registration (boundary)", () => {
  it("spawns with a spaced path intact and no shell", async () => {
    const { command, args } = registrationFor("SessionStart");
    const { stdout, status } = await runExecForm(command, args);

    expect(status).toBe(0);
    // One argument, not several: the space never got a chance to split it.
    expect(stdout).toBe("ARGV:SessionStart");
  });

  it("passes each hook name through as the handler's argument", async () => {
    for (const hook of ["PreToolUse", "Stop", "UserPromptSubmit"]) {
      const { command, args } = registrationFor(hook);
      const { stdout } = await runExecForm(command, args);
      expect(stdout).toBe(`ARGV:${hook}`);
    }
  });

  it("keeps the handler path and hook name as separate argv entries", () => {
    const { command, args } = registrationFor("Stop");

    // The shape that makes the above work: nothing is concatenated into a
    // string a shell would have to take apart again.
    expect(command).toBe(process.execPath);
    expect(args).toEqual([handlerPath, "Stop"]);
  });
});
