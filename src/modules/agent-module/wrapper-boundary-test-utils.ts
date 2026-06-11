import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFile, mkdir, chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { exec as pkgExec } from "@yao-pkg/pkg";

/**
 * Assert that a compiled wrapper exists (throws with a build hint otherwise).
 * Call from beforeAll.
 */
export async function assertCompiledScript(compiledScriptPath: string): Promise<void> {
  try {
    await access(compiledScriptPath, constants.R_OK);
  } catch {
    throw new Error(
      `Compiled script not found at ${compiledScriptPath}. Run 'pnpm build:wrappers' first.`
    );
  }
}

export interface FakeAgentBinaryOptions {
  /** Directory to create the fake binary in (created recursively). */
  readonly dir: string;
  /** Binary name the wrapper discovers on PATH (e.g. "claude", "opencode"). */
  readonly binaryName: string;
  /** Node source of the fake binary (a JSON-echo script in practice). */
  readonly scriptBody: string;
  /**
   * Platform wrapper used on Windows:
   * - "exe": compile to a real .exe via pkg (works with shell:false spawns)
   * - "batch": .cmd forwarding to node via %~dp0
   * - "cmd-shim": .cmd embedding the absolute script path (mimics npm shims,
   *   where %~dp0 can resolve to the caller's CWD)
   * On Unix, all modes produce a sh shebang wrapper (chmod 755).
   */
  readonly windowsMode: "exe" | "batch" | "cmd-shim";
}

/**
 * Create a fake agent binary: a Node script plus a platform wrapper that the
 * compiled CodeHydra wrapper can discover and spawn.
 *
 * @returns The directory containing the fake binary (for PATH construction)
 */
export async function createFakeAgentBinary(options: FakeAgentBinaryOptions): Promise<string> {
  const { dir, binaryName, scriptBody, windowsMode } = options;
  await mkdir(dir, { recursive: true });

  const fakeScriptPath = join(dir, `fake-${binaryName}.cjs`);
  await writeFile(fakeScriptPath, scriptBody);

  if (process.platform === "win32") {
    if (windowsMode === "exe") {
      await pkgExec([fakeScriptPath, "--target", "host", "--output", join(dir, binaryName)]);
    } else if (windowsMode === "batch") {
      const batchContent = `@echo off\n"${process.execPath}" "%~dp0fake-${binaryName}.cjs" %*\nexit /b %ERRORLEVEL%\n`;
      await writeFile(join(dir, `${binaryName}.cmd`), batchContent);
    } else {
      const cmdContent = `@echo off\r\nnode "${fakeScriptPath}" %*\r\n`;
      await writeFile(join(dir, `${binaryName}.cmd`), cmdContent);
    }
  } else {
    const shellContent = `#!/bin/sh\nexec node "${fakeScriptPath}" "$@"\n`;
    await writeFile(join(dir, binaryName), shellContent);
    await chmod(join(dir, binaryName), 0o755);
  }

  return dir;
}

/**
 * Execute a compiled wrapper script and capture output.
 * Strips CodeHydra and test framework env vars, then merges provided vars.
 */
export async function executeScript(
  compiledScriptPath: string,
  env: Record<string, string | undefined>,
  cwd: string
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const baseEnv: Record<string, string> = {};
  const excludedPrefixes = ["CH_", "_CH_", "VITEST", "TEST"];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !excludedPrefixes.some((prefix) => key.startsWith(prefix))) {
      baseEnv[key] = value;
    }
  }

  const finalEnv: Record<string, string> = { ...baseEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      finalEnv[key] = value;
    }
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [compiledScriptPath], {
      env: finalEnv,
      cwd,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, status: code });
    });
  });
}
