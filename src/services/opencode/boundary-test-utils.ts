/**
 * Test utilities for OpenCode boundary tests.
 *
 * Provides helpers for running opencode serve with mock configurations
 * and managing the test environment for boundary testing.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { ExecaProcessRunner, type SpawnedProcess, type ProcessRunner } from "../platform/process";

/**
 * Result of checking for the opencode binary.
 */
export interface BinaryCheckResult {
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}

/**
 * Check if the opencode binary is available and return version info.
 *
 * Uses the injected ProcessRunner for testability.
 *
 * @param runner - Process runner to use (defaults to ExecaProcessRunner)
 * @returns Result indicating if binary is available
 *
 * @example
 * ```ts
 * const result = await checkOpencodeAvailable();
 * if (!result.available) {
 *   console.log('Skipping boundary tests:', result.error);
 * }
 * ```
 */
export async function checkOpencodeAvailable(
  runner: ProcessRunner = new ExecaProcessRunner()
): Promise<BinaryCheckResult> {
  const proc = runner.run("opencode", ["--version"], {});

  const result = await proc.wait(5000);

  // If still running after timeout, kill it
  if (result.running) {
    proc.kill("SIGKILL");
    return {
      available: false,
      error: "opencode --version timed out",
    };
  }

  // Check for spawn errors (ENOENT)
  if (result.exitCode === null && result.stderr.includes("ENOENT")) {
    return {
      available: false,
      error: "opencode binary not found in PATH",
    };
  }

  // Check exit code
  if (result.exitCode !== 0) {
    return {
      available: false,
      error: `opencode --version failed with exit code ${result.exitCode}: ${result.stderr}`,
    };
  }

  // Parse version from output
  const versionMatch = result.stdout.match(/v?(\d+\.\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : result.stdout.trim();

  // Only include version if we found one
  if (version) {
    return {
      available: true,
      version,
    };
  }

  return {
    available: true,
  };
}

/**
 * Configuration for starting an opencode serve process.
 */
export interface OpencodeTestConfig {
  /** Port to listen on */
  readonly port: number;
  /** Working directory (must be a git repo) */
  readonly cwd: string;
  /** OpenCode configuration */
  readonly config: {
    readonly provider: Record<string, unknown>;
    readonly model: string;
    readonly permission: OpencodePermissionConfig;
  };
}

/**
 * Permission configuration for OpenCode.
 */
export interface OpencodePermissionConfig {
  readonly bash: "ask" | "allow" | "deny";
  readonly edit: "ask" | "allow" | "deny";
  readonly webfetch: "ask" | "allow" | "deny";
}

/**
 * Handle for a running opencode process.
 */
export interface OpencodeProcess {
  /** Process ID */
  readonly pid: number;
  /** Stop the process gracefully */
  stop(): Promise<void>;
}

/**
 * Start an opencode serve process with the given configuration.
 *
 * Uses OPENCODE_CONFIG environment variable to inject configuration.
 * The process is started in the background and monitored.
 *
 * @param config - Test configuration
 * @param runner - Process runner to use (defaults to ExecaProcessRunner)
 * @returns Handle to control the process
 *
 * @example
 * ```ts
 * const proc = await startOpencode({
 *   port: 14096,
 *   cwd: tempDir,
 *   config: {
 *     provider: { mock: { ... } },
 *     model: 'mock/test',
 *     permission: { bash: 'ask', edit: 'allow', webfetch: 'allow' }
 *   }
 * });
 *
 * // Use opencode...
 *
 * await proc.stop();
 * ```
 */
export async function startOpencode(
  config: OpencodeTestConfig,
  runner: ProcessRunner = new ExecaProcessRunner()
): Promise<OpencodeProcess> {
  // Write opencode config file to the project directory
  // Opencode reads config from opencode.jsonc in the project root
  const configPath = join(config.cwd, "opencode.jsonc");
  writeFileSync(configPath, JSON.stringify(config.config, null, 2));

  // Build environment with clean settings
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Disable colors/formatting for cleaner output
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  // Start the opencode serve process
  const proc: SpawnedProcess = runner.run("opencode", ["serve", "--port", String(config.port)], {
    cwd: config.cwd,
    env,
  });

  // Check if process spawned successfully
  if (proc.pid === undefined) {
    const result = await proc.wait(1000);
    throw new Error(`Failed to start opencode: ${result.stderr}`);
  }

  return {
    pid: proc.pid,
    stop: async () => {
      // Try graceful shutdown first
      proc.kill("SIGTERM");
      const result = await proc.wait(5000);

      // If still running, force kill
      if (result.running) {
        proc.kill("SIGKILL");
        await proc.wait(1000);
      }
    },
  };
}
