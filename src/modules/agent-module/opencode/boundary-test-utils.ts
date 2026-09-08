/**
 * Test utilities for OpenCode boundary tests.
 *
 * Provides helpers for running opencode serve with mock configurations
 * and managing the test environment for boundary testing.
 */

import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { onTestFinished } from "vitest";
import { createOpencodeClient, type OpencodeClient as SdkClient } from "@opencode-ai/sdk";
import type { SpawnedProcess, ProcessRunner } from "../../../boundaries/platform/process";
import { ExecaProcessRunner } from "../../../boundaries/platform/process";
import { DefaultNetworkLayer } from "../../../boundaries/platform/network";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import { waitForPort, CI_TIMEOUT_MS } from "../../../boundaries/platform/network.test-utils";
import { createTestGitRepo } from "../../../utils/testing/test-utils";
import {
  createMockLlmServer,
  type MockLlmServer,
  type MockLlmMode,
} from "../../../test/fixtures/mock-llm-server";
import { OpenCodeClient } from "./client";

/**
 * Creates a default ProcessRunner for boundary tests.
 */
function createDefaultRunner(): ProcessRunner {
  return new ExecaProcessRunner(SILENT_LOGGER);
}

// ============================================================================
// Hermetic opencode home
// ============================================================================

/**
 * A HOME for every opencode this file spawns that is not the developer's.
 *
 * opencode keeps machine-global state: plugins installed with bun under
 * `~/.config/opencode`, and a SQLite database of sessions, auth and history
 * under `~/.local/share/opencode`. Inheriting the real HOME means these tests
 * read and write the same files as every other opencode on the box —
 * including the agent serving the CodeHydra workspace they are being run
 * from. CI never notices, because a fresh runner has neither directory and
 * nothing else running.
 *
 * One fixed directory rather than a fresh one per run: it is equally isolated
 * from the developer, it cannot accumulate (there is exactly one, forever),
 * and opencode's plugin install is paid once per machine instead of once per
 * run. Two suites running at the same time share it, which is what they
 * already did through the real HOME, so nothing is worse than before.
 */
const ISOLATED_HOME = join(tmpdir(), "codehydra-opencode-boundary-home");

function isolatedHomeEnv(): NodeJS.ProcessEnv {
  const xdg = {
    XDG_CONFIG_HOME: join(ISOLATED_HOME, ".config"),
    XDG_DATA_HOME: join(ISOLATED_HOME, ".local", "share"),
    XDG_CACHE_HOME: join(ISOLATED_HOME, ".cache"),
    XDG_STATE_HOME: join(ISOLATED_HOME, ".local", "state"),
  };
  const windows = {
    APPDATA: join(ISOLATED_HOME, "AppData", "Roaming"),
    LOCALAPPDATA: join(ISOLATED_HOME, "AppData", "Local"),
  };
  for (const dir of [...Object.values(xdg), ...Object.values(windows)]) {
    mkdirSync(dir, { recursive: true });
  }
  return { HOME: ISOLATED_HOME, USERPROFILE: ISOLATED_HOME, ...xdg, ...windows };
}

/**
 * Configuration for starting an opencode serve process.
 */
export interface OpencodeTestConfig {
  /** Path to the opencode binary */
  readonly binaryPath: string;
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
  /**
   * Whatever the process has written so far, for a failure message. Reads it
   * without waiting for exit, so it is usable on a server that came up wrong
   * and is still running.
   */
  output(): Promise<string>;
}

/**
 * Start an opencode serve process with the given configuration.
 *
 * Uses OPENCODE_CONFIG_CONTENT environment variable to inject inline configuration.
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
async function startOpencode(
  config: OpencodeTestConfig,
  runner: ProcessRunner = createDefaultRunner()
): Promise<OpencodeProcess> {
  // Write opencode config file to the project directory
  // Opencode reads config from opencode.jsonc in the project root
  const configPath = join(config.cwd, "opencode.jsonc");
  writeFileSync(configPath, JSON.stringify(config.config, null, 2));

  // Build environment with clean settings
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // A throwaway HOME, so this server shares no plugin install and no session
    // database with the machine running the tests. See isolatedHomeEnv().
    ...isolatedHomeEnv(),
    // No file watcher. Nothing here tests one — these are HTTP client tests —
    // and on Linux the watcher takes an inotify instance from a per-user pool
    // of 128 that CodeHydra itself drains: every workspace's IDE server and
    // agent holds some. Past the limit opencode answers its first request and
    // then stops answering at all, so the suite fails with bare vitest
    // timeouts on exactly the machines it is developed on, while a CI runner
    // with nothing else running stays green.
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    // Disable colors/formatting for cleaner output
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  // Start the opencode serve process
  const proc: SpawnedProcess = runner.run(
    config.binaryPath,
    ["serve", "--port", String(config.port)],
    {
      cwd: config.cwd,
      env,
    }
  );

  // Check if process spawned successfully
  if (proc.pid === undefined) {
    const result = await proc.wait(1000);
    throw new Error(`Failed to start opencode: ${result.stderr}`);
  }

  return {
    pid: proc.pid,
    stop: async () => {
      // Use new kill() API: SIGTERM (5s wait) → SIGKILL (1s wait)
      await proc.kill(5000, 1000);
    },
    output: async () => {
      // running=true comes back with whatever was buffered, which is the point.
      const result = await proc.wait(1000);
      return [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
    },
  };
}

// ============================================================================
// Per-Test Isolation Helper
// ============================================================================

/**
 * How long opencode gets to bind its port, as a fraction of the budget the
 * tests give the whole scenario. The remainder is what is left to report a
 * startup failure in terms of opencode rather than of vitest.
 */
const STARTUP_TIMEOUT_MS = Math.round(CI_TIMEOUT_MS * 0.6);

/**
 * Options for withOpencode helper.
 */
export interface WithOpencodeOptions {
  /** Path to the opencode binary */
  readonly binaryPath: string;
  /** Permission configuration (defaults to all "allow") */
  readonly permission?: OpencodePermissionConfig;
  /** Mock LLM response mode */
  readonly mockLlmMode: MockLlmMode;
}

/**
 * Context passed to test function in withOpencode.
 */
export interface OpencodeTestContext {
  /** Port opencode is listening on */
  readonly port: number;
  /** OpenCode SDK client for sending prompts */
  readonly sdk: SdkClient;
  /** OpenCodeClient under test */
  readonly client: OpenCodeClient;
  /** Working directory (git repo) */
  readonly cwd: string;
  /** Mock LLM server (for mode changes mid-test if needed) */
  readonly mockLlm: MockLlmServer;
}

/**
 * Run a test with an isolated opencode environment.
 *
 * Creates a fresh mock LLM server, temp git repo, and opencode process
 * for each test. All resources are cleaned up after the test completes.
 *
 * @param options - Configuration for the test environment
 * @param fn - Test function receiving the context
 *
 * @example
 * ```ts
 * it("fetches sessions", async () => {
 *   await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
 *     await sdk.session.create({ body: {} });
 *     const result = await client.fetchRootSessions();
 *     expect(result.ok).toBe(true);
 *   });
 * }, CI_TIMEOUT_MS);
 * ```
 */
export async function withOpencode(
  options: WithOpencodeOptions,
  fn: (ctx: OpencodeTestContext) => Promise<void>
): Promise<void> {
  // Create temp git repo
  const repo = await createTestGitRepo();

  // Start mock LLM server
  const mockLlm = createMockLlmServer();
  await mockLlm.start();
  mockLlm.setMode(options.mockLlmMode);

  // Find free port for opencode
  const networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
  const port = await networkLayer.findFreePort();

  // Start opencode process
  const opencodeProcess = await startOpencode({
    binaryPath: options.binaryPath,
    port,
    cwd: repo.path,
    config: {
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${mockLlm.port}/v1` },
          models: { test: { name: "Test Model" } },
        },
      },
      model: "mock/test",
      permission: options.permission ?? { bash: "allow", edit: "allow", webfetch: "allow" },
    },
  });

  let client: OpenCodeClient | null = null;

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Reverse order of creation.
    client?.dispose();
    await opencodeProcess.stop().catch(() => {});
    await mockLlm.stop().catch(() => {});
    await repo.cleanup().catch(() => {});
  };

  // `finally` alone loses the race with a timeout: vitest abandons the pending
  // promise, so nothing below it runs and the repo, the server and the mock all
  // outlive the test — which is how a machine collects dozens of stale
  // `codehydra-test-*` directories and a drift of orphaned opencode processes.
  // onTestFinished runs whatever the outcome, and the guard above makes the
  // second call a no-op.
  onTestFinished(cleanup);

  try {
    // Wait for opencode to be ready.
    //
    // A slice of the budget, not all of it: callers give `it` CI_TIMEOUT_MS, so
    // spending the whole thing here means a server that never binds surfaces as
    // vitest's bare "Test timed out" with nothing about opencode in it. Failing
    // first leaves room to say what actually happened, and to say it with the
    // process's own output.
    try {
      await waitForPort(port, STARTUP_TIMEOUT_MS);
    } catch (error) {
      const output = await opencodeProcess.output().catch(() => "");
      throw new Error(
        `opencode did not start listening on port ${port} within ${STARTUP_TIMEOUT_MS}ms` +
          (output ? `. Process output:\n${output}` : " (no process output)."),
        { cause: error }
      );
    }

    // Create clients
    const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
    client = new OpenCodeClient(port, SILENT_LOGGER);

    // Run the test
    await fn({ port, sdk, client, cwd: repo.path, mockLlm });
  } finally {
    // The normal path: free the port and the temp repo now rather than at the
    // end of the test, so the next scenario starts from a quiet machine.
    await cleanup();
  }
}

// Re-export types for convenience
export type { MockLlmMode, MockLlmServer };
