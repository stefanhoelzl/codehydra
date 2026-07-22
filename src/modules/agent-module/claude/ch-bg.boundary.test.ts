// @vitest-environment node
/**
 * Boundary tests for the shipped `ch-bg` background wrapper
 * (resources/bin/ch-bg + ch-bg.cmd).
 *
 * `ch-bg` is a transparent passthrough: its only job is to run the given command
 * unchanged while placing the "ch-bg" marker into the command string CodeHydra
 * sees. These tests verify the real script forwards arguments, stdout, and the
 * exit code across platforms.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createTempDir } from "../../../utils/testing/test-utils";

const isWindows = process.platform === "win32";
const RESOURCES_BIN = resolve(__dirname, "../../../../resources/bin");
const CH_BG = join(RESOURCES_BIN, isWindows ? "ch-bg.cmd" : "ch-bg");

/**
 * A probe the wrapper runs. Echoes its args, then exits with the code given as
 * the first arg — proving argument passthrough, stdout passthrough, and exit
 * code forwarding in one shot. Kept in a file (no inline `-e`) to dodge
 * cross-platform shell quoting.
 */
const PROBE_BODY = `process.stdout.write("ARGV:" + process.argv.slice(2).join(","));
process.exit(Number(process.argv[2] ?? 0));`;

/** Run `ch-bg node <probe> <args...>` and capture stdout + exit status. */
function runChBg(
  probePath: string,
  args: string[]
): Promise<{ stdout: string; status: number | null }> {
  const chBgArgs = ["node", probePath, ...args];
  const [command, spawnArgs] = isWindows
    ? (["cmd", ["/c", CH_BG, ...chBgArgs]] as const)
    : (["sh", [CH_BG, ...chBgArgs]] as const);

  return new Promise((resolvePromise) => {
    const child = spawn(command, [...spawnArgs], { cwd: RESOURCES_BIN });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolvePromise({ stdout, status: code }));
  });
}

describe("ch-bg wrapper script", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await expect(access(CH_BG, constants.R_OK)).resolves.toBeUndefined();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  async function writeProbe(): Promise<string> {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const probePath = join(dir.path, "probe.cjs");
    await writeFile(probePath, PROBE_BODY);
    return probePath;
  }

  it("passes arguments and stdout through and forwards a zero exit code", async () => {
    const probePath = await writeProbe();

    const { stdout, status } = await runChBg(probePath, ["0", "hello", "world"]);

    expect(stdout).toContain("ARGV:0,hello,world");
    expect(status).toBe(0);
  });

  it("forwards a non-zero exit code", async () => {
    const probePath = await writeProbe();

    const { status } = await runChBg(probePath, ["7"]);

    expect(status).toBe(7);
  });
});
