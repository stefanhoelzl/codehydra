import { spawn } from "node:child_process";

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
