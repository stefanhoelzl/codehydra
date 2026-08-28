// @vitest-environment node
/**
 * Boundary test for the hook command CodeHydra writes into Claude's settings.
 *
 * `hooks[].hooks[].command` is a *shell string*: Claude hands it to the platform
 * shell, not to spawn(). So the only place the quoting question is genuinely
 * answered is a real shell, on a real path, on each platform CI runs.
 *
 * What this pins down, and what unit assertions cannot:
 *  - a handler path containing a space stays one argument
 *  - a native Windows path's backslashes survive (they are safe *because* the
 *    path is quoted; unquoted, `cmd` would still split on the space)
 *  - the hook name arrives as the handler's first argument
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { buildSettingsFile } from "./server-manager";
import { createTempDir } from "../../../utils/testing/test-utils";

const isWindows = process.platform === "win32";

/** Echoes its own argv so the caller can see how the shell split the command. */
const PROBE_BODY = `process.stdout.write("ARGV:" + process.argv.slice(2).join("|"));`;

let tempCleanup: () => Promise<void>;
/** A handler path with a space in it — the case that breaks without quoting. */
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

/** Run a generated command string the way Claude does: through the shell. */
function runInShell(command: string): Promise<{ stdout: string; status: number | null }> {
  const [shell, args] = isWindows
    ? (["cmd", ["/c", command]] as const)
    : (["sh", ["-c", command]] as const);
  return new Promise((resolvePromise) => {
    const child = spawn(shell, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (status) => resolvePromise({ stdout, status }));
  });
}

/** The command the settings file registers for one hook. */
function commandFor(hookName: string): string {
  const settings = buildSettingsFile(handlerPath);
  return settings.hooks[hookName]![0]!.hooks[0]!.command;
}

describe("generated hook command (boundary)", () => {
  it("survives a spaced path when run through the platform shell", async () => {
    const { stdout, status } = await runInShell(commandFor("SessionStart"));

    expect(status).toBe(0);
    // One argument, not four: the handler saw only the hook name.
    expect(stdout).toBe("ARGV:SessionStart");
  });

  it("passes each hook name through as the single argument", async () => {
    for (const hook of ["PreToolUse", "Stop", "UserPromptSubmit"]) {
      const { stdout } = await runInShell(commandFor(hook));
      expect(stdout).toBe(`ARGV:${hook}`);
    }
  });

  it("would break unquoted — the reason the quotes are there", async () => {
    // The shape this test exists to prevent regressing to.
    const unquoted = `node ${handlerPath} SessionStart`;
    const { stdout, status } = await runInShell(unquoted);

    expect({ stdout, status }).not.toEqual({ stdout: "ARGV:SessionStart", status: 0 });
  });
});
