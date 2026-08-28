/**
 * Running the `ch` CLI from a spec.
 *
 * Deliberately invoked the way a user or a script would — by absolute path, with
 * none of CodeHydra's environment — because that is the case with no other
 * coverage. Inside a workspace terminal `ch` inherits `_CH_IDE_NODE` and its
 * cwd; here it must resolve both on its own.
 */
import { expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { DATA_ROOT } from "./env.ts";

const isWindows = process.platform === "win32";

export const BIN_DIR = join(DATA_ROOT, "bin");
export const CH = join(BIN_DIR, isWindows ? "ch.cmd" : "ch");

export interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
  /** Set when the process could not be spawned at all, e.g. a missing cwd. */
  readonly error?: string;
}

/** Run `ch` with a deliberately bare environment. */
export function ch(args: readonly string[], cwd: string = DATA_ROOT): Run {
  // PATH is kept because the shell needs one; every `_CH_*` variable is dropped
  // so the CLI has to find its instance and its interpreter the way it would
  // from a terminal CodeHydra never touched.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("_CH_")) env[key] = value;
  }

  const result = isWindows
    ? spawnSync("cmd", ["/c", CH, ...args], { cwd, env, encoding: "utf-8" })
    : spawnSync(CH, [...args], { cwd, env, encoding: "utf-8" });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
    ...(result.error && { error: result.error.message }),
  };
}

/**
 * Run `ch` WITHOUT blocking this process's event loop.
 *
 * `ch()` is synchronous, which is fine for a spec that only talks to the app.
 * It is not fine for one that also *serves* the agent: a mock LLM running in
 * this process cannot answer a request while `spawnSync` holds the loop, so the
 * agent hangs on a socket nobody is reading until the CLI's own timeout fires.
 * Any spec with an in-process server the agent depends on must use this.
 */
export async function chAsync(args: readonly string[], cwd: string = DATA_ROOT): Promise<Run> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("_CH_")) env[key] = value;
  }

  const child = isWindows
    ? spawn("cmd", ["/c", CH, ...args], { cwd, env })
    : spawn(CH, [...args], { cwd, env });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  return new Promise<Run>((resolve) => {
    child.on("error", (error) => resolve({ stdout, stderr, status: -1, error: error.message }));
    child.on("close", (code) => resolve({ stdout, stderr, status: code ?? -1 }));
  });
}

/** Parse a JSON result. stdout is JSON because spawnSync gives no TTY. */
export function json(run: Run): unknown {
  expect(
    run.status,
    `expected success.\n  spawn error: ${run.error ?? "none"}\n  stderr: ${run.stderr}\n  stdout: ${run.stdout}`
  ).toBe(0);
  return JSON.parse(run.stdout) as unknown;
}
