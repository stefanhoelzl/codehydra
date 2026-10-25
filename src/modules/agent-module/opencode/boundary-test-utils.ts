/**
 * Test utilities for OpenCode boundary tests.
 *
 * Provides helpers for running opencode serve with mock configurations
 * and managing the test environment for boundary testing.
 */

import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { onTestFailed, onTestFinished, vi } from "vitest";
import { createOpencodeClient, type OpencodeClient as SdkClient } from "@opencode-ai/sdk";
import { OpenCode as OpenCodeV2Factory } from "@opencode/client";
import type { SpawnedProcess, ProcessRunner } from "../../../boundaries/platform/process";
import { ExecaProcessRunner } from "../../../boundaries/platform/process";
import { DefaultNetworkLayer } from "../../../boundaries/platform/network";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import { CI_TIMEOUT_MS } from "../../../boundaries/platform/network.test-utils";
import { waitForHealthy } from "../../../utils/health-check";
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
 * One fixed directory per vitest worker slot rather than a fresh one per run:
 * it is equally isolated from the developer, it cannot accumulate (one per
 * slot, forever), and opencode's plugin install is paid once per slot instead
 * of once per run. Per slot, not one for all: the 1.x and 2.x suites run in
 * parallel workers, and two servers on one database fail to start with
 * "database is locked". Within a worker the scenarios run one at a time.
 */
const ISOLATED_HOME = join(
  tmpdir(),
  `codehydra-opencode-boundary-home-${process.env.VITEST_POOL_ID ?? "0"}`
);

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
  /** Which server API the binary speaks (decides CLI flag spellings) */
  readonly major: 1 | 2;
  /** OpenCode configuration, written to the project's opencode.jsonc */
  readonly config: Record<string, unknown>;
  /** The server password, passed as OPENCODE_PASSWORD (2.x only) */
  readonly password?: string;
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
   * Everything the process wrote, for a failure message. Empty while it is
   * still running — SpawnedProcess.wait() hands over output only once the
   * process has exited — so stop() it first.
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
    // A database per major: a 1.x server refuses to open an `opencode.db` that
    // a 2.x server created ("Database is not empty and has no session table"),
    // and one worker slot can run both suites in turn.
    OPENCODE_DB: join(ISOLATED_HOME, `opencode-v${config.major}.db`),
    ...(config.password !== undefined && { OPENCODE_PASSWORD: config.password }),
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
    // opencode logs only to a file unless asked, which leaves output() with
    // nothing to say about a scenario that hangs after startup. (2.x spell the
    // log level lower-case; 1.x accepted DEBUG.)
    [
      "serve",
      "--port",
      String(config.port),
      "--print-logs",
      "--log-level",
      config.major === 2 ? "debug" : "DEBUG",
    ],
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
 * When every step of a scenario must be done, measured from its start. The
 * rest of the budget is for tearing down and reporting, so a step that
 * overruns fails with its own name, the timeline and opencode's log instead of
 * vitest's bare "Test timed out".
 */
const SCENARIO_DEADLINE_MS = Math.round(CI_TIMEOUT_MS * 0.8);

/** How much of opencode's log a failure report carries. */
const REPORT_LOG_LINES = 80;

/** Opens every failure report, so a failure that already carries one is told apart. */
const REPORT_HEADER = "timeline (ms since the scenario started";

/** The password every 2.x-lane server here is given. */
const V2_TEST_PASSWORD = "boundary-test-password";

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
  /** Which server API to exercise: 1.x (default) or 2.x */
  readonly major?: 1 | 2;
  /**
   * The tool the `tool-call` mode asks the model to call — `bash` on 1.x
   * (default), `shell` on 2.x.
   */
  readonly toolCallName?: string;
}

/** The @opencode/client instance a 2.x lane hands to its tests. */
export type OpenCodeV2Client = ReturnType<typeof OpenCodeV2Factory.make>;

/**
 * Context passed to test function in withOpencode.
 */
export interface OpencodeTestContext {
  /** Port opencode is listening on */
  readonly port: number;
  /** 1.x SDK client for sending prompts (the 1.x lane's raw wire) */
  readonly sdk: SdkClient;
  /** @opencode/client for talking to a 2.x server (the 2.x lane's raw wire) */
  readonly v2: OpenCodeV2Client;
  /** OpenCodeClient under test */
  readonly client: OpenCodeClient;
  /** Working directory (git repo) */
  readonly cwd: string;
  /** Mock LLM server (for mode changes mid-test if needed) */
  readonly mockLlm: MockLlmServer;
  /**
   * Await `work` as a named step of the scenario: it is recorded on the
   * timeline a failure prints, and fails by name, with the report, if it is not
   * done by the scenario deadline.
   */
  step<T>(label: string, work: Promise<T>): Promise<T>;
  /** `vi.waitFor` as a named step, bounded by the scenario deadline. */
  waitFor(label: string, assertion: () => void): Promise<void>;
}

/** One entry of a scenario's timeline, in ms since the scenario started. */
interface TimelineEntry {
  readonly label: string;
  readonly start: number;
  end?: number;
}

/**
 * Run a test with an isolated opencode environment.
 *
 * Creates a fresh mock LLM server, temp git repo, and opencode process
 * for each test. All resources are cleaned up after the test completes.
 *
 * Await the scenario's work through `step` and `waitFor`: they bound it by the
 * scenario deadline and record it on the timeline. A failure of any kind —
 * a step overrunning, an assertion, or vitest's own timeout on something not
 * wrapped in a step — then reports the timeline, the requests the mock LLM
 * served and the tail of opencode's log.
 *
 * @param options - Configuration for the test environment
 * @param fn - Test function receiving the context
 *
 * @example
 * ```ts
 * it("fetches sessions", async () => {
 *   await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk, step }) => {
 *     await step("create session", sdk.session.create({ body: {} }));
 *     const result = await step("list sessions", client.listSessions());
 *     expect(result.ok).toBe(true);
 *   });
 * }, CI_TIMEOUT_MS);
 * ```
 */
export async function withOpencode(
  options: WithOpencodeOptions,
  fn: (ctx: OpencodeTestContext) => Promise<void>
): Promise<void> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const timeline: TimelineEntry[] = [];
  const begin = (label: string): TimelineEntry => {
    const entry: TimelineEntry = { label, start: elapsed() };
    timeline.push(entry);
    return entry;
  };

  // Each is set once the scenario gets that far; cleanup and the report handle
  // whatever exists.
  let repo: Awaited<ReturnType<typeof createTestGitRepo>> | null = null;
  let mockLlm: MockLlmServer | null = null;
  let opencodeProcess: OpencodeProcess | null = null;
  let client: OpenCodeClient | null = null;

  const report = async (): Promise<string> => {
    const ms = (value: number): string => String(value).padStart(6);
    const lines = [`${REPORT_HEADER}; now ${elapsed()}):`];
    for (const entry of timeline) {
      const took = entry.end === undefined ? "unfinished" : `took ${entry.end - entry.start}`;
      lines.push(`  ${ms(entry.start)}  ${entry.label} (${took})`);
    }
    const requests = mockLlm?.requests() ?? [];
    lines.push(`mock LLM requests (${requests.length}):`);
    for (const request of requests) {
      lines.push(
        `  ${ms(request.timestamp - startedAt)}  ${request.method} ${request.path} -> ${request.response.status}`
      );
    }
    // Its output is only readable once it has exited, and the scenario is
    // failing anyway; cleanup's own stop() then finds it gone.
    await opencodeProcess?.stop().catch(() => {});
    const output = (await opencodeProcess?.output().catch(() => "")) ?? "";
    const tail = output.split(/\r?\n/).slice(-REPORT_LOG_LINES);
    lines.push(`opencode output (last ${tail.length} lines):`, ...tail.map((line) => `  ${line}`));
    return lines.join("\n");
  };

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    const entry = begin("teardown");
    // Reverse order of creation.
    client?.dispose();
    await opencodeProcess?.stop().catch(() => {});
    await mockLlm?.stop().catch(() => {});
    await repo?.cleanup().catch(() => {});
    entry.end = elapsed();
  };

  // `finally` alone loses the race with a timeout: vitest abandons the pending
  // promise, so nothing below it runs and the repo, the server and the mock all
  // outlive the test — which is how a machine collects dozens of stale
  // `codehydra-test-*` directories and a drift of orphaned opencode processes.
  // onTestFinished runs whatever the outcome, and the guard above makes the
  // second call a no-op.
  onTestFinished(cleanup);

  // The same race is why the report hangs off onTestFailed too: a timeout from
  // vitest names no step, and can also overtake a step's own report while that
  // is still being written. It runs after onTestFinished, so opencode has
  // exited and its output is complete.
  onTestFailed(async ({ task }) => {
    if (task.result?.errors?.some((error) => error.message.includes(REPORT_HEADER))) return;
    console.error(`opencode scenario "${task.name}" failed.\n${await report()}`);
  });

  const step = async <T>(label: string, work: Promise<T>): Promise<T> => {
    const entry = begin(label);
    let timer: NodeJS.Timeout | undefined;
    const overrun = new Promise<"overrun">((resolve) => {
      timer = setTimeout(() => resolve("overrun"), Math.max(SCENARIO_DEADLINE_MS - entry.start, 0));
    });
    try {
      const outcome = await Promise.race([work.then((value) => ({ value })), overrun]);
      if (outcome === "overrun") {
        throw new Error(
          `step "${label}" was not done ${SCENARIO_DEADLINE_MS}ms into the scenario.\n${await report()}`
        );
      }
      entry.end = elapsed();
      return outcome.value;
    } finally {
      clearTimeout(timer);
    }
  };

  const waitFor = async (label: string, assertion: () => void): Promise<void> => {
    const entry = begin(label);
    try {
      await vi.waitFor(assertion, { timeout: Math.max(SCENARIO_DEADLINE_MS - entry.start, 0) });
    } catch (error) {
      throw new Error(
        `"${label}" still did not hold ${SCENARIO_DEADLINE_MS}ms into the scenario: ` +
          `${error instanceof Error ? error.message : String(error)}\n${await report()}`,
        { cause: error }
      );
    }
    entry.end = elapsed();
  };

  try {
    const repoEntry = begin("create temp git repo");
    repo = await createTestGitRepo();
    repoEntry.end = elapsed();

    const mockEntry = begin("start mock LLM");
    const llm = createMockLlmServer();
    mockLlm = llm;
    await llm.start();
    // 1.x calls its shell tool `bash`; 2.x calls it `shell`.
    llm.setMode(options.mockLlmMode, options.major === 2 ? "shell" : "bash");
    mockEntry.end = elapsed();

    // Find free port for opencode
    const networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    const port = await networkLayer.findFreePort();

    const major = options.major ?? 1;
    const permission = options.permission ?? { bash: "allow", edit: "allow", webfetch: "allow" };
    // The two servers' config shapes: 1.x names the provider map `provider`
    // and permissions per tool; 2.x has `providers`, an ordered `permissions`
    // array and renamed tools (`bash` → `shell`).
    const config: Record<string, unknown> =
      major === 2
        ? {
            providers: {
              mock: {
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { baseURL: `http://127.0.0.1:${llm.port}/v1` },
                models: { test: { name: "Test Model" } },
              },
            },
            model: "mock/test",
            permissions: [
              { action: "shell", resource: "*", effect: permission.bash },
              { action: "edit", resource: "*", effect: permission.edit },
              { action: "webfetch", resource: "*", effect: permission.webfetch },
            ],
            // Off: nothing here tests snapshots, and copying the worktree
            // before every step dominates the prompt-to-model latency.
            snapshots: false,
          }
        : {
            provider: {
              mock: {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: `http://127.0.0.1:${llm.port}/v1` },
                models: { test: { name: "Test Model" } },
              },
            },
            model: "mock/test",
            permission,
            // Off. Before every step of a prompt opencode copies the worktree into a
            // hidden git repo, spawning git to do it, and on a loaded Windows runner
            // that was most of the ~6.5s between a prompt and the model's request —
            // which a test that prompts twice pays twice, up to 20s of a 30s budget.
            // Nothing here tests diffs or revert, and CodeHydra uses neither.
            snapshot: false,
          };

    const startEntry = begin(`start opencode on port ${port}`);
    opencodeProcess = await startOpencode({
      binaryPath: options.binaryPath,
      port,
      cwd: repo.path,
      major,
      config,
      ...(major === 2 && { password: V2_TEST_PASSWORD }),
    });

    // Wait for opencode to be ready.
    //
    // A slice of the budget, not all of it: callers give `it` CI_TIMEOUT_MS, so
    // spending the whole thing here means a server that never binds surfaces as
    // vitest's bare "Test timed out" with nothing about opencode in it. Failing
    // first leaves room to say what actually happened, and to say it with the
    // process's own output.
    //
    // Over HTTP, the way OpenCodeServerManager checks health, and not with a
    // bare TCP connect: opencode (seen on 1.18) binds its port before it can
    // serve, and a connection opened and dropped in that window leaves the
    // next request hanging until it times out — while a request that simply
    // retries on refusal is answered as soon as the server is up.
    //
    // 2.x has no `/path` (its web-UI catch-all answers 200 for anything);
    // its readiness endpoint is `GET /api/info`, authenticated — a healthy
    // check also proves the password works.
    const healthUrl =
      major === 2 ? `http://127.0.0.1:${port}/api/info` : `http://127.0.0.1:${port}/path`;
    const healthHeaders =
      major === 2
        ? {
            Authorization: `Basic ${Buffer.from(`opencode:${V2_TEST_PASSWORD}`).toString("base64")}`,
          }
        : undefined;
    try {
      await waitForHealthy({
        checkFn: async () =>
          (
            await networkLayer.fetch(healthUrl, {
              timeout: 2000,
              ...(healthHeaders !== undefined && { headers: healthHeaders }),
            })
          ).ok,
        timeoutMs: STARTUP_TIMEOUT_MS,
        intervalMs: 100,
      });
    } catch (error) {
      throw new Error(
        `opencode did not answer on port ${port} within ${STARTUP_TIMEOUT_MS}ms.\n${await report()}`,
        { cause: error }
      );
    }
    startEntry.end = elapsed();

    // Create clients
    const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
    const v2 = OpenCodeV2Factory.make({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${V2_TEST_PASSWORD}`).toString("base64")}`,
      },
    });
    client = new OpenCodeClient(port, SILENT_LOGGER, {
      major,
      ...(major === 2 && { password: V2_TEST_PASSWORD }),
      directory: repo.path,
    });

    // Run the test
    await fn({ port, sdk, v2, client, cwd: repo.path, mockLlm: llm, step, waitFor });
  } finally {
    // The normal path: free the port and the temp repo now rather than at the
    // end of the test, so the next scenario starts from a quiet machine.
    await cleanup();
  }
}

// Re-export types for convenience
export type { MockLlmMode, MockLlmServer };
