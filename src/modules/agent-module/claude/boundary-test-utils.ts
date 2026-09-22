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
 * By default `claude` runs headless rather than in the interactive TUI
 * CodeHydra actually launches. The hook payloads are built by the same code
 * either way, and a headless scenario costs under a second. What headless
 * cannot reach stays covered by the synthetic tests in
 * `server-manager.integration.test.ts`: `PermissionRequest` never fires,
 * `AskUserQuestion` is refused outright ("disabled for this session, in
 * subagents as well as here"), there is no idle prompt for `idle_prompt` to
 * follow, and `!cmd` is a TUI input mode with no headless equivalent.
 *
 * A headless run is a **stream-json session on stdin**, not a one-shot
 * `-p "prompt"`. See {@link sendStreamJsonPrompt}: an open stdin keeps Claude
 * alive past the end of a turn, and without that its hooks lose a race against
 * its own teardown.
 *
 * `mode: "tui"` runs the interactive TUI in a pseudo-terminal instead, for what
 * only happens there. The motivating case is the prompt-suggestion fork: after
 * every turn Claude forks a hidden agent to guess the user's next prompt, and
 * that fork runs the session's hooks — so a tool call it makes reaches the
 * bridge as if the agent had made it, with no transcript entry to show for it.
 * Headless mode never forks (`non_interactive` disables it). A TUI scenario
 * waits for the input prompt to render, types the prompt and presses Enter,
 * and is otherwise the same chain.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import { createServer, type Server } from "node:http";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { LLMock, type ChatCompletionRequest, type ChatMessage } from "@copilotkit/aimock";
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
  /**
   * The payload's `tool_name`, for the tool hooks. Only for telling one record
   * from another (which `PreToolUse` is the fork's) — assertions stay on status.
   */
  readonly toolName: string | undefined;
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
   * Headless only.
   */
  readonly thenEndSession?: boolean;
  /**
   * `headless` (default): `claude -p` on a stream-json stdin.
   * `tui`: the interactive TUI in a pseudo-terminal — for behavior only the
   * TUI has, such as the prompt-suggestion fork. Slower: it waits for the TUI
   * to render before it can type.
   */
  readonly mode?: "headless" | "tui";
}

/** Every scenario the boundary tests drive, and the fixtures that produce it. */
export type ScenarioName =
  | "plain"
  | "tool"
  | "bgcomplete"
  | "chbg"
  | "subagent"
  | "maxtokens"
  | "suggestionfork";

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
function sendStreamJsonPrompt(child: ChildProcess): void {
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
 * The titling agent's system prompt — the only thing that tells its call apart
 * from a turn of the conversation. Shared by {@link NAMING_FIXTURE}, which
 * answers that call, and {@link isNamingCall}, which keeps other fixtures off
 * it; the two must agree, so they read the same constant.
 */
const NAMING_SYSTEM_PROMPT = "You are naming a coding session";

/**
 * Claude names the session before it does anything else, in a separate call
 * carrying its own system prompt. `DISABLE_NON_ESSENTIAL_MODEL_CALLS` does not
 * suppress it (checked on 2.1.250), and strict mode would 503 it and kill the
 * run, so it gets a fixture of its own.
 *
 * This fixture decides what the naming call is ANSWERED with. It does not keep
 * the call away from other fixtures — see {@link installFixtures}.
 */
const NAMING_FIXTURE = {
  match: { systemMessage: NAMING_SYSTEM_PROMPT },
  response: { content: "Boundary probe" },
} as const;

/** The text of a message, whichever shape it arrived in. */
function messageText(message: ChatMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

/** The text of a request's system message. */
function systemText(req: ChatCompletionRequest): string {
  return messageText(req.messages.find((message: ChatMessage) => message.role === "system"));
}

/**
 * How the prompt-suggestion fork's prompt opens (checked on 2.1.280). The fork
 * reuses the parent's system prompt and history — it has to, to share the
 * parent's prompt cache — so this user message is the only thing that tells
 * its calls apart from the agent's own.
 */
const SUGGESTION_MARKER = "[SUGGESTION MODE:";

function isSuggestionPrompt(message: ChatMessage): boolean {
  return message.role === "user" && messageText(message).includes(SUGGESTION_MARKER);
}

/** Any call of the prompt-suggestion fork. */
function isSuggestionFork(req: ChatCompletionRequest): boolean {
  return req.messages.some(isSuggestionPrompt);
}

/**
 * The fork's opening call: nothing answered since its prompt. By shape, not by
 * counting (see {@link installFixtures}) — the call after the fork's denied
 * tool carries an assistant turn past the marker and must get plain text, or
 * the fork would keep calling the tool.
 */
function isSuggestionForkOpening(req: ChatCompletionRequest): boolean {
  const marker = req.messages.findLastIndex(isSuggestionPrompt);
  const answered = req.messages.findLastIndex((message) => message.role === "assistant");
  return marker !== -1 && marker > answered;
}

/**
 * The call the fork makes in the report this scenario reproduces: a model deep
 * in an interview answers "what will the user type next?" with a question of
 * its own. Claude denies it ("No tools needed for suggestion") — but only after
 * `PreToolUse` has run, and nothing follows it: no `PostToolUse`, no
 * `PostToolUseFailure`.
 */
const SUGGESTION_ASK_CALL = {
  reasoning: "Asking which option to take.",
  toolCalls: [
    {
      id: "call_ask",
      name: "AskUserQuestion",
      arguments: JSON.stringify({
        questions: [
          {
            question: "Which option should we take?",
            header: "Option",
            multiSelect: false,
            options: [
              { label: "A", description: "The first option" },
              { label: "B", description: "The second option" },
            ],
          },
        ],
      }),
    },
  ],
};

/** Claude's session-naming call, which is not a turn of the conversation. */
function isNamingCall(req: ChatCompletionRequest): boolean {
  return systemText(req).includes(NAMING_SYSTEM_PROMPT);
}

/**
 * The scenario's opening turn: the coding agent, before it has said anything.
 *
 * Two requests have to be excluded, and both are excluded by SHAPE rather than
 * by counting. The naming call above is one. The other is the turn Claude
 * re-invokes when a background shell exits: it carries no tool result, so it
 * looks like a fresh user turn, and only the assistant message from the first
 * turn tells them apart. Serving that turn a second background shell would
 * start a shell that outlives the run and never let the scenario end.
 */
function isFirstAgentTurn(req: ChatCompletionRequest): boolean {
  if (isNamingCall(req)) return false;
  return !req.messages.some((message: ChatMessage) => message.role === "assistant");
}

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
 * Install the fixtures for one scenario. The earliest match wins, so order
 * decides which fixture ANSWERS a request — but not which fixtures are
 * consulted about it. aimock evaluates every fixture's `predicate` on every
 * request and picks a winner afterwards, so a predicate runs even for requests
 * an earlier fixture is about to answer. A predicate must therefore be a pure
 * question about the request in hand: one that counts calls instead is hostage
 * to how many unrelated model calls the agent happens to make, which is no part
 * of any contract. See {@link isFirstAgentTurn}.
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

  if (scenario === "suggestionfork") {
    // The fork first: it carries the parent's system prompt and history, so any
    // fixture below would answer it as though it were the agent.
    mock.addFixture({
      match: { predicate: isSuggestionForkOpening },
      response: SUGGESTION_ASK_CALL,
    });
    mock.addFixture({ match: { predicate: isSuggestionFork }, response: { content: "" } });
    // A background sub-agent that is still working when the fork runs — the
    // report's two research agents. The fork's hook lands within a second of
    // the main Stop, so 5s outlasts the scenario; and no longer, because Claude
    // runs the shell in a process group of its own, which outlives the kill.
    mock.addFixture({
      match: { systemMessage: "You are an agent", hasToolResult: false },
      response: bashCall("sleep 5", "long research", false),
    });
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
    case "bgcomplete":
      // Short enough to finish inside the run, so one scenario covers
      // busyForBackgroundTasks being set AND cleared.
      //
      // Only the opening turn gets a shell, and that is load-bearing — see
      // `isFirstAgentTurn` for what else asks for one and must not get it.
      mock.addFixture({
        match: { predicate: isFirstAgentTurn },
        response: bashCall("sleep 2", "short sleep", true),
      });
      mock.addFixture({ match: {}, response: { content: "The shell has finished." } });
      break;
    case "chbg":
      // Long enough to still be running at Stop, so `taskKeepsBusy` really sees
      // a running shell and opts it out on the marker rather than on an empty
      // background_tasks — which would pass for the wrong reason.
      mock.addFixture({ match: {}, response: bashCall("ch-bg sleep 30", "opted-out sleep", true) });
      break;
    case "suggestionfork":
      // Delegate in the background, then end the turn waiting on it. Two
      // assistant messages (the call and the reply) are what the fork needs
      // before it runs at all ("early_conversation" otherwise).
      mock.addFixture({
        match: {},
        response: {
          reasoning: "Delegating to a background sub-agent.",
          toolCalls: [
            {
              id: "call_agent",
              name: "Task",
              arguments: JSON.stringify({
                subagent_type: "general-purpose",
                description: "research",
                prompt: "research the thing",
                run_in_background: true,
              }),
            },
          ],
        },
      });
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

  const mode = options.mode ?? "headless";
  if (mode === "tui" && options.thenEndSession === true) {
    throw new Error("thenEndSession is headless-only");
  }
  writeAgentConfig(agentConfig.path, repo.path);

  const spawnOptions: SpawnAgentOptions = {
    cwd: repo.path,
    settingsPath,
    bridgePort: tap.port,
    mockUrl,
    configDir: agentConfig.path,
    pathPrefix: options.pathPrefix ?? [],
  };
  const agent = mode === "tui" ? spawnTuiAgent(spawnOptions) : spawnHeadlessAgent(spawnOptions);
  disposables.cleanups.push(() => agent.kill());
  await agent.sendPrompt();

  await waitForRecording(records, options.until, agent);

  if (options.thenEndSession === true) {
    agent.endSession();
    await waitForRecording(records, (entries) => seen(entries, "SessionEnd"), agent);
  }

  return buildRun(records);
}

/** A running `claude`, however it was started. */
interface AgentHandle {
  /** Deliver {@link PROMPT}. Resolves once it has been handed over. */
  sendPrompt(): Promise<void>;
  /** End the session the way its user would. */
  endSession(): void;
  /** Stop it. Scenarios never need a clean exit — only the hooks it already sent. */
  kill(): Promise<void>;
  /** Whether it is gone, and why if it never started. */
  readonly state: { exited: boolean; spawnError: Error | undefined };
  /** Its most recent output, for a failure message. */
  diagnostics(): string;
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
        const toolName = readToolName(body);
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
          records.push({ hook, before, after: readStatus(), toolName });
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

/** The hook payload's `tool_name`, if it has one. */
function readToolName(body: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload === "object" && payload !== null && "tool_name" in payload) {
      return typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    }
  } catch {
    // Not JSON: no tool name to report.
  }
  return undefined;
}

/**
 * Claude's own config for this run: past onboarding, past the
 * bypass-permissions warning, past the workspace trust dialog, and isolated
 * from the developer's ~/.claude.
 */
function writeAgentConfig(configDir: string, workspacePath: string): void {
  // The TUI asks whether to trust the folder before it takes any input (print
  // mode skips the dialog). Keyed by path, and Claude's spelling of it is not
  // ours, so every spelling is trusted: a symlinked temp dir (macOS /var ->
  // /private/var), an 8.3 short name (GitHub's Windows TEMP is
  // C:\Users\RUNNER~1\..., which only the native realpath expands), and either
  // separator.
  const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  const spellings = [
    workspacePath,
    realpathSync(workspacePath),
    realpathSync.native(workspacePath),
  ];
  const projects = Object.fromEntries(
    spellings
      .flatMap((spelling) => [spelling, spelling.replaceAll("\\", "/")])
      .map((key) => [key, trusted])
  );
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      // `--permission-mode bypassPermissions` otherwise stops on a one-time
      // warning screen, which in print mode means it stops for good.
      bypassPermissionsModeAccepted: true,
      projects,
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

/**
 * Quote an argument for cmd.exe, the way `wrapper.ts` does.
 *
 * Node's `shell: true` joins the file and args with single spaces and wraps the
 * whole line in ONE outer pair of quotes — it does not quote them individually,
 * so any arg containing a space (every temp path here) is re-split by cmd.exe.
 */
function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * How `claude` has to be spawned here.
 *
 * A global npm install puts `claude.cmd` on PATH on Windows, and Node has
 * refused to execute a `.cmd` directly since CVE-2024-27980 — it needs a shell,
 * and therefore the hand-quoting above. Mirrors `findSystemClaude()` in
 * `wrapper.ts`, which resolves the very same binary in production.
 */
function resolveClaudeCommand(): { command: string; useShell: boolean } {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "claude.exe", useShell: false },
          { command: "claude.cmd", useShell: true },
        ]
      : [{ command: "claude", useShell: false }];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, ["--version"], {
        stdio: "ignore",
        shell: candidate.useShell,
      });
      return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  throw new Error(
    `No working \`claude\` on PATH (tried ${candidates.map((c) => c.command).join(", ")}).\n` +
      `These tests drive the real CLI: \`npm install -g @anthropic-ai/claude-code\`.`
  );
}

/** The environment `claude` runs in: pointed at the mock and at the recording tap. */
function agentEnv(options: SpawnAgentOptions): Record<string, string | undefined> {
  // Run from inside a Claude session (a developer's agent running the suite),
  // the environment carries that session's markers — CLAUDE_CODE_CHILD_SESSION
  // alone turns transcript saving off. Nothing of the parent's may leak in.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CLAUDE_CODE_") && key !== "CLAUDECODE"
    )
  );
  return {
    ...inherited,
    PATH: [...options.pathPrefix, process.env.PATH ?? ""].join(delimiter),
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
  };
}

/** The flags every run shares. */
function agentArgs(options: SpawnAgentOptions): string[] {
  return [
    "--settings",
    options.settingsPath,
    // Without this Claude parks on a permission prompt nobody is there to
    // answer.
    "--permission-mode",
    "bypassPermissions",
  ];
}

/** Spawn `claude -p` on a stream-json stdin. */
function spawnHeadlessAgent(options: SpawnAgentOptions): AgentHandle {
  const { command, useShell } = resolveClaudeCommand();
  const quote = (value: string): string => (useShell ? quoteForCmd(value) : value);
  const child = spawn(
    quote(command),
    [
      "-p",
      // The prompt arrives on stdin, not argv — see `--input-format` below.
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...agentArgs(options),
    ].map(quote),
    { cwd: options.cwd, shell: useShell, env: agentEnv(options), stdio: ["pipe", "pipe", "pipe"] }
  );

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const state: AgentHandle["state"] = { exited: false, spawnError: undefined };
  child.on("exit", () => (state.exited = true));
  // Without this a failed spawn is invisible: no "exit" fires, so the wait
  // would sit out the full timeout and report "timed out" for what is really
  // "the binary could not be started".
  child.on("error", (error: Error) => {
    state.spawnError = error;
    state.exited = true;
  });

  return {
    state,
    sendPrompt: () => {
      sendStreamJsonPrompt(child);
      return Promise.resolve();
    },
    endSession: () => child.stdin?.end(),
    diagnostics: () => `stderr: ${stderr.slice(-800)}`,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((done) => {
        child.once("exit", () => done());
        child.kill("SIGKILL");
        // A process that refuses to die must not hang the suite.
        setTimeout(done, 2_000).unref?.();
      });
    },
  };
}

/**
 * The input box's prompt glyph, drawn once the TUI takes input (checked on
 * 2.1.280). Typed any earlier, the keystrokes land on the startup screen and
 * are lost. Not the footer's hint text: that changes with the permission mode
 * ("? for shortcuts" vs "bypass permissions on").
 */
const TUI_READY_MARKER = "\u276f";

/**
 * A dialog's footer (checked on 2.1.280). A dialog draws the same glyph as its
 * selection cursor ("\u276f No, exit"), and Enter would pick that option — so while
 * this is on screen, the TUI is not ready, it is waiting on a question the
 * scenario never meant to answer (the folder trust dialog, when the trust
 * seeded in {@link writeAgentConfig} did not match).
 */
const TUI_DIALOG_MARKER = "Enter to confirm";

/** How long the TUI may take to render its input box. */
const TUI_READY_TIMEOUT_MS = 30_000;

const ESC = 0x1b;
const BEL = 0x07;

/**
 * Terminal output as plain text, so markers can be searched: CSI sequences
 * (`ESC [ … final`), OSC strings (`ESC ] … BEL` or `ESC \`) and two-byte
 * escapes are dropped. A scanner rather than a regex, which would have to
 * spell out the very control characters `no-control-regex` rejects.
 */
function stripAnsi(output: string): string {
  let text = "";
  let i = 0;
  while (i < output.length) {
    if (output.charCodeAt(i) !== ESC) {
      text += output[i];
      i++;
      continue;
    }
    const kind = output[i + 1];
    i += 2;
    if (kind === "[") {
      // Parameters and intermediates, up to the final byte (0x40-0x7e).
      while (i < output.length && !(output.charCodeAt(i) >= 0x40 && output.charCodeAt(i) <= 0x7e))
        i++;
      i++;
    } else if (kind === "]") {
      while (i < output.length && output.charCodeAt(i) !== BEL && output.charCodeAt(i) !== ESC) i++;
      // BEL ends it in one byte, ESC \ in two.
      i += output.charCodeAt(i) === ESC ? 2 : 1;
    }
  }
  return text;
}

/**
 * Spawn the interactive TUI in a pseudo-terminal.
 *
 * The prompt-suggestion fork only runs here, and only when the feature is on:
 * it is gated on a server-side flag the mock cannot serve, so the env override
 * forces it.
 */
function spawnTuiAgent(options: SpawnAgentOptions): AgentHandle {
  const { command, useShell } = resolveClaudeCommand();
  const args = agentArgs(options);
  // ConPTY launches a file, not a command line: a `.cmd` needs cmd.exe in front.
  const [file, argv] = useShell
    ? [process.env.ComSpec ?? "cmd.exe", ["/c", command, ...args]]
    : [command, args];
  const pty: IPty = spawnPty(file, argv, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: options.cwd,
    env: { ...agentEnv(options), CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" },
  });

  let output = "";
  pty.onData((data) => {
    // Keep a bounded tail: a TUI redraws constantly, and only the end matters.
    output = (output + data).slice(-200_000);
  });
  const state: AgentHandle["state"] = { exited: false, spawnError: undefined };
  let exitCode: number | undefined;
  pty.onExit((event) => {
    state.exited = true;
    exitCode = event.exitCode;
  });

  const screen = (): string => stripAnsi(output);
  // An empty screen says nothing on its own: this says what was launched and
  // whether it is still there.
  const describe = (): string =>
    `launched: ${[file, ...argv].join(" ")}\n` +
    `exited: ${state.exited ? `yes, code ${String(exitCode)}` : "no"}; ` +
    `output: ${output.length} bytes, ending ${JSON.stringify(output.slice(-300))}`;

  return {
    state,
    sendPrompt: async () => {
      const deadline = Date.now() + TUI_READY_TIMEOUT_MS;
      const ready = (text: string): boolean =>
        text.includes(TUI_READY_MARKER) && !text.includes(TUI_DIALOG_MARKER);
      while (!ready(screen())) {
        if (state.exited || Date.now() > deadline) {
          throw new Error(
            `the TUI never showed its input prompt ("${TUI_READY_MARKER}" without a dialog).\n` +
              `${describe()}\nscreen: ${screen().slice(-1500)}`
          );
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      pty.write(PROMPT);
      // Typed text and Enter in one write read as a paste, which the TUI
      // inserts rather than submits.
      await new Promise((done) => setTimeout(done, 300));
      pty.write("\r");
    },
    endSession: () => {
      throw new Error("thenEndSession is headless-only");
    },
    diagnostics: () => `${describe()}\nscreen: ${screen().slice(-1500)}`,
    kill: () => {
      if (state.exited) return Promise.resolve();
      return new Promise<void>((done) => {
        pty.onExit(() => done());
        pty.kill(process.platform === "win32" ? undefined : "SIGKILL");
        // A process that refuses to die must not hang the suite.
        setTimeout(done, 2_000).unref?.();
      });
    },
  };
}

/** How long one scenario may take before it is called a failure. */
const SCENARIO_TIMEOUT_MS = 60_000;

/** How long trailing hooks may keep arriving after `claude` has exited. */
const POST_EXIT_GRACE_MS = 3_000;

/** Poll until the recording satisfies `until`, or the agent dies, or time runs out. */
async function waitForRecording(
  records: readonly HookRecord[],
  until: (records: readonly HookRecord[]) => boolean,
  agent: AgentHandle
): Promise<void> {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  const hooksSeen = (): string => records.map((entry) => entry.hook).join(", ") || "(none)";

  while (Date.now() < deadline) {
    if (until(records)) return;
    if (agent.state.spawnError !== undefined) {
      throw new Error(`could not start claude: ${agent.state.spawnError.message}`);
    }
    if (agent.state.exited) {
      // A hook is a separate process Claude spawns, so the last few can still be
      // in flight — or not yet started — when Claude itself has gone. `Stop` and
      // `SessionEnd` routinely land after exit. Give them room before calling it
      // a failure.
      await new Promise((done) => setTimeout(done, POST_EXIT_GRACE_MS));
      if (until(records)) return;
      throw new Error(
        `claude exited before the scenario completed.\n` +
          `hooks seen: ${hooksSeen()}\n${agent.diagnostics()}`
      );
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `scenario timed out after ${SCENARIO_TIMEOUT_MS}ms.\n` +
      `hooks seen: ${hooksSeen()}\n${agent.diagnostics()}`
  );
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
