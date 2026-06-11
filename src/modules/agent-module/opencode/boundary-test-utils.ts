/**
 * Test utilities for OpenCode boundary tests.
 *
 * Provides helpers for running opencode serve with mock configurations
 * and managing the test environment for boundary testing.
 */

import { writeFileSync } from "fs";
import { join } from "path";
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
  };
}

// ============================================================================
// Per-Test Isolation Helper
// ============================================================================

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

  try {
    // Wait for opencode to be ready
    await waitForPort(port, CI_TIMEOUT_MS);

    // Create clients
    const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
    client = new OpenCodeClient(port, SILENT_LOGGER);

    // Run the test
    await fn({ port, sdk, client, cwd: repo.path, mockLlm });
  } finally {
    // Cleanup in reverse order
    if (client) {
      client.dispose();
    }
    await opencodeProcess.stop().catch(() => {});
    await mockLlm.stop().catch(() => {});
    await repo.cleanup().catch(() => {});
  }
}

// Re-export types for convenience
export type { MockLlmMode, MockLlmServer };
