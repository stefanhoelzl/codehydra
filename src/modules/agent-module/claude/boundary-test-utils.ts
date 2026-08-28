/**
 * Harness for the Claude hook-contract boundary tests.
 *
 * Runs a REAL `claude` against a mock LLM and drives the whole shipped chain:
 *
 *     claude -p (a stream-json session on stdin)
 *       -> the settings file `buildSettingsFile()` really writes
 *         -> dist/bin/claude-code-hook-handler.cjs (the shipped handler)
 *           -> a recording tap
 *             -> a real ClaudeCodeServerManager bridge
 *               -> AgentStatus
 *
 * Only the model is fake. Everything the hooks travel through is the code that
 * ships, so a Claude release that changes what it emits shows up here as a
 * wrong `AgentStatus` rather than as a silent regression in production.
 *
 * `claude` runs headless rather than in the interactive TUI CodeHydra actually
 * launches. The hook payloads are built by the same code either way, and a
 * headless scenario costs under a second against a TUI that would have to be
 * driven through a PTY. What headless cannot reach stays covered by the
 * synthetic tests in `server-manager.integration.test.ts`: `PermissionRequest`
 * never fires, `AskUserQuestion` is refused outright ("disabled for this
 * session, in subagents as well as here"), there is no idle prompt for
 * `idle_prompt` to follow, and `!cmd` is a TUI input mode with no headless
 * equivalent.
 *
 * It is a **stream-json session on stdin**, not a one-shot `-p "prompt"`. See
 * {@link sendPrompt}: an open stdin keeps Claude alive past the end of a turn,
 * and without that its hooks lose a race against its own teardown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { DefaultFileSystemBoundary } from "../../../boundaries/platform/filesystem";
import { DefaultNetworkLayer } from "../../../boundaries/platform/network";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import { DefaultPathProvider } from "../../../boundaries/platform/path-provider";
import { NodePlatformInfo } from "../../../boundaries/platform/node-platform-info";
import { createMockBuildInfo } from "../../../boundaries/platform/build-info.test-utils";
import { createTempDir, createTestGitRepo } from "../../../utils/testing/test-utils";
import { ClaudeCodeServerManager } from "./server-manager";
import { isValidHookName, type ClaudeCodeHookName } from "./types";
import type { AgentStatus } from "../types";

/** The shipped hook handler. Built by `pnpm build:wrappers`. */
const HOOK_HANDLER_PATH = resolve(__dirname, "../../../../dist/bin/claude-code-hook-handler.cjs");

/** Ships `ch-bg`, which a background shell uses to opt out of keeping the workspace busy. */
const RESOURCES_BIN = resolve(__dirname, "../../../../resources/bin");

/** One hook, and what it did to the workspace's status. */
export interface HookRecord {
  readonly hook: ClaudeCodeHookName;
  /** Status immediately before the bridge handled this hook. */
  readonly before: AgentStatus;
  /** Status immediately after — the bridge handles a hook before it responds. */
  readonly after: AgentStatus;
}

/** The recording one `claude` run produced. */
export interface ScenarioRun {
  /** Every hook the bridge handled, in arrival order. */
  readonly records: readonly HookRecord[];
  /** Status after the `index`-th (default: first) occurrence of `hook`. */
  statusAfter(hook: ClaudeCodeHookName, index?: number): AgentStatus;
  /** Status either side of the `index`-th (default: first) occurrence of `hook`. */
  statusAcross(
    hook: ClaudeCodeHookName,
    index?: number
  ): { before: AgentStatus; after: AgentStatus };
  /** How many times `hook` arrived. */
  count(hook: ClaudeCodeHookName): number;
  /** Status after the last hook of the run. */
  readonly finalStatus: AgentStatus;
}

/** What a scenario waits for before it kills `claude`. */
export interface ScenarioOptions {
  /**
   * Stop as soon as the recording satisfies this.
   *
   * The tests only care about hooks, never about a clean exit, so a scenario
   * whose point is a still-running background shell need not wait out Claude's
   * ~5s grace period before it gives up on one.
   */
  readonly until: (records: readonly HookRecord[]) => boolean;
  /** Extra PATH entries for the spawned agent (the `ch-bg` scenario needs one). */
  readonly pathPrefix?: readonly string[];
  /**
   * After `until` is met, close stdin and wait for the session to end.
   *
   * The only way to observe `SessionEnd`: while stdin is open Claude stays
   * available for another turn, so the session never ends on its own.
   */
  readonly thenEndSession?: boolean;
}

/** Every scenario the boundary tests drive, and the fixtures that produce it. */
export type ScenarioName = "plain" | "tool" | "bgcomplete" | "chbg" | "subagent" | "maxtokens";

/** The prompt every scenario sends. Content is irrelevant — fixtures match on the system prompt. */
const PROMPT = "do the thing";

/**
 * Feed the prompt as a stream-json message and leave stdin OPEN.
 *
 * That open stdin is the whole point. With the prompt on argv, Claude treats the
 * turn as the entire session and tears the process down the moment it ends — and
 * a hook is a separate process it does not wait for. `StopFailure` loses that
 * race every time: the handler is spawned, is handed its payload, and is killed
 * partway through the POST. (A handler that only wrote a local file would win
 * it, which is exactly how this went unnoticed while probing.)
 *
 * Reading stdin, Claude stays alive after the turn, so every hook completes.
 * The scenario ends when the recording says so and we kill the agent ourselves.
 */
function sendPrompt(child: ChildProcess): void {
  child.stdin?.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: PROMPT },
      parent_tool_use_id: null,
      session_id: "codehydra-boundary-test",
    }) + "\n"
  );
}

/**
 * Claude names the session before it does anything else, in a separate call
 * carrying its own system prompt. `DISABLE_NON_ESSENTIAL_MODEL_CALLS` does not
 * suppress it (checked on 2.1.250), and strict mode would 503 it and kill the
 * run, so it gets a fixture of its own — gated on the titling agent's own
 * system prompt so it cannot absorb the turn under test.
 */
const NAMING_FIXTURE = {
  match: { systemMessage: "You are naming a coding session" },
  response: { content: "Boundary probe" },
} as const;

/**
 * A `Bash` tool call.
 *
 * `arguments` is a JSON **string**: aimock's `ToolCall` type says so, and an
 * object is not rejected — it arrives at Claude with no parameters at all and
 * comes back as `InputValidationError: The required parameter 'command' is
 * missing`, which reads like Claude misbehaving rather than a fixture bug.
 *
 * `reasoning` is required on every tool-call fixture: Claude Code runs with
 * extended thinking on, and Anthropic rejects a tool-loop continuation whose
 * assistant turn does not open with a thinking block. aimock replays
 * `reasoning` as exactly that block.
 */
function bashCall(command: string, description: string, background: boolean) {
  return {
    reasoning: `Running ${description}.`,
    toolCalls: [
      {
        id: "call_bash",
        name: "Bash",
        arguments: JSON.stringify({
          command,
          description,
          ...(background && { run_in_background: true }),
        }),
      },
    ],
  };
}

/**
 * Install the fixtures for one scenario. First match wins, so order is meaning.
 *
 * Every scenario answers a follow-up turn with plain text. A fixture that
 * answers with another tool call instead loops forever: when a background task
 * finishes, Claude re-invokes the agent with a fresh `UserPromptSubmit`, and a
 * fixture that starts another background task never lets the run end.
 */
function installFixtures(mock: LLMock, scenario: ScenarioName): void {
  mock.addFixture(NAMING_FIXTURE);

  if (scenario === "maxtokens") {
    // The only headless route to StopFailure. HTTP errors are NOT one: 429, 401,
    // 500 and 529 are all retried, silently, well past any sane test timeout.
    mock.addFixture({
      match: {},
      response: { content: "truncated reply", finishReason: "max_tokens" },
    });
    return;
  }

  if (scenario === "subagent") {
    // The sub-agent talks to the same mock, under its own system prompt.
    mock.addFixture({
      match: { systemMessage: "You are an agent" },
      response: { content: "Sub-agent done." },
    });
  }

  // The follow-up turn, and (for `subagent`) the parent's turn after the Agent
  // tool returns. Matched first so it beats the tool-call fixture below.
  mock.addFixture({ match: { hasToolResult: true }, response: { content: "Done." } });

  switch (scenario) {
    case "plain":
      mock.addFixture({ match: {}, response: { content: "Nothing to do." } });
      break;
    case "tool":
      mock.addFixture({ match: {}, response: bashCall("echo probe", "echo", false) });
      break;
    case "bgcomplete": {
      // Short enough to finish inside the run, so one scenario covers
      // busyForBackgroundTasks being set AND cleared.
      //
      // One-shot, and that is load-bearing: when the shell exits Claude
      // re-invokes the agent, and the re-invoked turn carries no tool result,
      // so a plain `match: {}` would serve it another background shell and the
      // run would never end. Only the first turn gets one.
      let served = 0;
      mock.addFixture({
        match: { predicate: () => served++ === 0 },
        response: bashCall("sleep 2", "short sleep", true),
      });
      mock.addFixture({ match: {}, response: { content: "The shell has finished." } });
      break;
    }
    case "chbg":
      // Long enough to still be running at Stop, so `taskKeepsBusy` really sees
      // a running shell and opts it out on the marker rather than on an empty
      // background_tasks — which would pass for the wrong reason.
      mock.addFixture({ match: {}, response: bashCall("ch-bg sleep 30", "opted-out sleep", true) });
      break;
    case "subagent":
      mock.addFixture({
        match: {},
        response: {
          reasoning: "Delegating to a sub-agent.",
          toolCalls: [
            {
              id: "call_agent",
              name: "Task",
              arguments: JSON.stringify({
                subagent_type: "general-purpose",
                description: "probe",
                prompt: "say hello and stop",
              }),
            },
          ],
        },
      });
      break;
  }
}

/** Refuse to run, loudly, rather than skip and lose the coverage silently. */
function requirePrerequisites(): void {
  if (!existsSync(HOOK_HANDLER_PATH)) {
    throw new Error(
      `The shipped hook handler is missing: ${HOOK_HANDLER_PATH}\n` +
        `Run \`pnpm build:wrappers\` before \`pnpm test\`.`
    );
  }
}

/** Everything one scenario allocated, torn down in reverse. */
interface Disposables {
  readonly cleanups: (() => Promise<void> | void)[];
}

async function disposeAll(disposables: Disposables): Promise<void> {
  for (const cleanup of disposables.cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best effort: a leftover temp dir must not fail a run that passed.
    }
  }
}

/**
 * Run one scenario end to end and return what the bridge saw.
 *
 * @throws if `claude` is not on PATH, or the shipped hook handler is missing.
 */
export async function runScenario(
  scenario: ScenarioName,
  options: ScenarioOptions
): Promise<ScenarioRun> {
  requirePrerequisites();

  const disposables: Disposables = { cleanups: [] };
  try {
    return await runScenarioInner(scenario, options, disposables);
  } finally {
    await disposeAll(disposables);
  }
}

async function runScenarioInner(
  scenario: ScenarioName,
  options: ScenarioOptions,
  disposables: Disposables
): Promise<ScenarioRun> {
  // Claude refuses to work outside a directory it trusts, and print mode keys
  // that off the cwd — so the workspace has to be a real repo of its own.
  const repo = await createTestGitRepo();
  disposables.cleanups.push(repo.cleanup);

  const agentConfig = await createTempDir();
  disposables.cleanups.push(agentConfig.cleanup);

  const dataRoot = await createTempDir();
  disposables.cleanups.push(dataRoot.cleanup);

  // The mock the agent talks to instead of Anthropic.
  const mock = new LLMock({ port: 0, strict: true });
  installFixtures(mock, scenario);
  const mockUrl = await mock.start();
  disposables.cleanups.push(() => mock.stop());

  // The real bridge, with real boundaries. `_CH_ROOT_DIR` relocates the data
  // root so the generated config files land in this run's temp dir rather than
  // in the developer's ./app-data next to a running dev instance.
  const previousRoot = process.env._CH_ROOT_DIR;
  process.env._CH_ROOT_DIR = dataRoot.path;
  const pathProvider = new DefaultPathProvider(
    createMockBuildInfo({ isDevelopment: true, appPath: process.cwd() }),
    new NodePlatformInfo()
  );
  if (previousRoot === undefined) {
    delete process.env._CH_ROOT_DIR;
  } else {
    process.env._CH_ROOT_DIR = previousRoot;
  }

  const manager = new ClaudeCodeServerManager({
    portManager: new DefaultNetworkLayer(SILENT_LOGGER),
    pathProvider,
    fileSystem: new DefaultFileSystemBoundary(SILENT_LOGGER),
    logger: SILENT_LOGGER,
    config: { hookHandlerPath: HOOK_HANDLER_PATH },
  });
  disposables.cleanups.push(() => manager.dispose());

  // Registers the workspace AND writes the real settings file Claude is given.
  const bridgePort = await manager.startServer(repo.path);
  const settingsPath = manager.getHooksConfigPath(repo.path).toNative();

  // Track the status the bridge reports, so the tap can sample it either side
  // of each hook.
  let status: AgentStatus = "none";
  manager.onStatusChange(repo.path, (next) => {
    status = next;
  });

  const records: HookRecord[] = [];
  const tap = await startRecordingTap(bridgePort, records, () => status);
  disposables.cleanups.push(() => tap.close());

  writeAgentConfig(agentConfig.path);

  const child = spawnAgent({
    cwd: repo.path,
    settingsPath,
    bridgePort: tap.port,
    mockUrl,
    configDir: agentConfig.path,
    pathPrefix: options.pathPrefix ?? [],
  });
  disposables.cleanups.push(() => killAgent(child));
  sendPrompt(child);

  await waitForRecording(records, options.until, child);

  if (options.thenEndSession === true) {
    child.stdin?.end();
    await waitForRecording(records, (entries) => seen(entries, "SessionEnd"), child);
  }

  return buildRun(records);
}

/**
 * A recording proxy in front of the bridge.
 *
 * The bridge exposes status only through `onStatusChange`, so correlating a
 * status with the hook that caused it needs the hook name — which only the URL
 * carries. Sampling either side of the forwarded request is exact because the
 * bridge handles a hook synchronously, before it responds.
 */
async function startRecordingTap(
  bridgePort: number,
  records: HookRecord[],
  readStatus: () => AgentStatus
): Promise<{ readonly port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const hook = /^\/hook\/([^/]+)$/.exec(req.url ?? "")?.[1];
        const before = readStatus();
        let upstream: Response | undefined;
        try {
          upstream = await fetch(`http://127.0.0.1:${bridgePort}${req.url ?? "/"}`, {
            method: req.method ?? "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
        } catch {
          // The bridge is already down (teardown raced a trailing hook).
        }
        if (hook !== undefined && isValidHookName(hook)) {
          records.push({ hook, before, after: readStatus() });
        }
        res.writeHead(upstream?.status ?? 502, { "Content-Type": "application/json" });
        res.end(upstream === undefined ? "{}" : await upstream.text());
      })();
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Recording tap did not bind a TCP port");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * Claude's own config for this run: past onboarding, past the
 * bypass-permissions warning, and isolated from the developer's ~/.claude.
 */
function writeAgentConfig(configDir: string): void {
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      // `--permission-mode bypassPermissions` otherwise stops on a one-time
      // warning screen, which in print mode means it stops for good.
      bypassPermissionsModeAccepted: true,
    })
  );
}

interface SpawnAgentOptions {
  readonly cwd: string;
  readonly settingsPath: string;
  readonly bridgePort: number;
  readonly mockUrl: string;
  readonly configDir: string;
  readonly pathPrefix: readonly string[];
}

/** Spawn the real `claude`, pointed at the mock and at the recording tap. */
function spawnAgent(options: SpawnAgentOptions): ChildProcess {
  const path = [...options.pathPrefix, process.env.PATH ?? ""].join(delimiter);
  return spawn(
    "claude",
    [
      "-p",
      // The prompt arrives on stdin, not argv — see `--input-format` below.
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      options.settingsPath,
      // Without this Claude parks on a permission prompt that print mode gives
      // nobody a way to answer.
      "--permission-mode",
      "bypassPermissions",
    ],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: path,
        // Read by the shipped hook handler; the two together are what make it
        // POST anything at all.
        _CH_BRIDGE_PORT: String(options.bridgePort),
        _CH_WORKSPACE_PATH: options.cwd,
        ANTHROPIC_BASE_URL: options.mockUrl,
        // A bearer token rather than ANTHROPIC_API_KEY: an API key makes Claude
        // ask the user to approve it once, and nobody is there to answer.
        ANTHROPIC_AUTH_TOKEN: "codehydra-boundary-test",
        ANTHROPIC_MODEL: "claude-sonnet-4-5",
        CLAUDE_CONFIG_DIR: options.configDir,
        // Keep the run to the turn under test, and keep a version check or a
        // crash report from reaching the network mid-test.
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

/** How long one scenario may take before it is called a failure. */
const SCENARIO_TIMEOUT_MS = 60_000;

/** How long trailing hooks may keep arriving after `claude` has exited. */
const POST_EXIT_GRACE_MS = 3_000;

/** Poll until the recording satisfies `until`, or the agent dies, or time runs out. */
async function waitForRecording(
  records: readonly HookRecord[],
  until: (records: readonly HookRecord[]) => boolean,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  let exited = false;
  child.on("exit", () => (exited = true));

  while (Date.now() < deadline) {
    if (until(records)) return;
    if (exited) {
      // A hook is a separate process Claude spawns, so the last few can still be
      // in flight — or not yet started — when Claude itself has gone. `Stop` and
      // `SessionEnd` routinely land after exit. Give them room before calling it
      // a failure.
      await new Promise((done) => setTimeout(done, POST_EXIT_GRACE_MS));
      if (until(records)) return;
      throw new Error(
        `claude exited before the scenario completed.\n` +
          `hooks seen: ${records.map((entry) => entry.hook).join(", ") || "(none)"}\n` +
          `stderr: ${stderr.slice(-800)}`
      );
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `scenario timed out after ${SCENARIO_TIMEOUT_MS}ms.\n` +
      `hooks seen: ${records.map((entry) => entry.hook).join(", ") || "(none)"}\n` +
      `stderr: ${stderr.slice(-800)}`
  );
}

/** Stop the agent. Scenarios never need a clean exit — only the hooks it already sent. */
function killAgent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill("SIGKILL");
    // A process that refuses to die must not hang the suite.
    setTimeout(done, 2_000).unref?.();
  });
}

/** Wrap the raw records in the lookups the assertions use. */
function buildRun(records: readonly HookRecord[]): ScenarioRun {
  const pick = (hook: ClaudeCodeHookName, index: number): HookRecord => {
    const matches = records.filter((entry) => entry.hook === hook);
    const match = matches[index];
    if (match === undefined) {
      throw new Error(
        `no ${hook}[${index}] in this run — hooks seen: ` +
          `${records.map((entry) => entry.hook).join(", ") || "(none)"}`
      );
    }
    return match;
  };

  return {
    records,
    statusAfter: (hook, index = 0) => pick(hook, index).after,
    statusAcross: (hook, index = 0) => {
      const { before, after } = pick(hook, index);
      return { before, after };
    },
    count: (hook) => records.filter((entry) => entry.hook === hook).length,
    finalStatus: records.at(-1)?.after ?? "none",
  };
}

/** `resources/bin`, for the scenario whose shell must really find `ch-bg`. */
export function chBgPathEntry(): string {
  return RESOURCES_BIN;
}

/** Convenience: has `hook` arrived at least `count` times? */
export function seen(records: readonly HookRecord[], hook: ClaudeCodeHookName, count = 1): boolean {
  return records.filter((entry) => entry.hook === hook).length >= count;
}
