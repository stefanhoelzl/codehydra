/**
 * A mock LLM the agent under test talks to, so an e2e run can drive a real
 * agent turn without a login, an API key, or the network.
 *
 * Neither agent needs the app's help to be redirected: the app hands
 * `{...process.env}` to the IDE server (whose terminals run `ch claude`) and to
 * the OpenCode server it spawns, so pointing an agent at this server is a matter
 * of the environment `launchApp` is given. Claude takes `ANTHROPIC_BASE_URL`;
 * OpenCode takes a config file naming a provider, via `OPENCODE_CONFIG` — which
 * survives because the app's own `OPENCODE_CONFIG_CONTENT` (which wins over
 * everything) only sets `instructions` and `mcp`.
 *
 * The fixtures assert as much as they answer. Each one matches only when the
 * request carries CodeHydra's system prompt AND advertises CodeHydra's MCP tool,
 * and the server runs in strict mode — so a launch that stopped injecting either
 * one produces no match, the turn fails, and the spec fails with the mock's own
 * diagnostic. There is deliberately no catch-all: an unanticipated call is a
 * finding, and gets a fixture of its own once we know what it is.
 */
import { getTextContent, LLMock, type ChatCompletionRequest } from "@copilotkit/aimock";
import { test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./env.ts";

/** The title the fixtures tell the agent to set. Asserted on in the spec. */
export const AGENT_SET_TITLE = "renamed by agent";

/**
 * The prompt the spec sends. The fixtures match a substring of it, so it has to
 * survive whatever the agent wraps around a user message.
 */
export const AGENT_PROMPT = `rename this workspace to '${AGENT_SET_TITLE}'`;

/**
 * CodeHydra's MCP tool for the title, as each agent namespaces it.
 *
 * Claude Code prefixes `mcp__<server>__`; OpenCode joins with a single
 * underscore. The fixture gates on the name, so a wrong one here reads as "the
 * MCP server never reached the agent" — which is exactly what it would mean.
 */
const SET_TITLE_TOOL: Record<Agent, string> = {
  claude: "mcp__codehydra__workspace_set_title",
  opencode: "codehydra_workspace_set_title",
};

/** A phrase from `resources/prompts/shared.md`, present for either agent. */
const SYSTEM_PROMPT_MARKER = "You are running inside CodeHydra.";

/** What every request carried, for the three things the fixtures gate on. */
export interface SeenRequest {
  readonly systemHasMarker: boolean;
  readonly system: string;
  readonly userMessage: string;
  readonly tools: readonly string[];
  readonly hasToolResult: boolean;
  /** What the last tool returned — for an MCP call, CodeHydra's own answer. */
  readonly toolResult: string;
}

export interface AgentMock {
  /** Base URL of the running mock. */
  readonly url: string;
  /** Environment for `launchApp`, pointing this run's agent at the mock. */
  readonly env: Record<string, string>;
  /** The server itself — `getRequests()` is the first stop when a spec fails. */
  readonly server: LLMock;
  /**
   * Pre-accept Claude's folder-trust dialog for `workspacePath`.
   *
   * Claude asks "is this a project you trust?" before it will do anything, and
   * in an agent terminal nobody is there to answer — it just sits on the prompt
   * until the workspace is torn down. The acceptance is keyed by **exact**
   * directory (a parent entry does not cover its children) and lives in
   * `.claude.json`, so the path has to be known before the agent launches.
   *
   * A no-op for OpenCode, which has no such dialog.
   */
  trustWorkspace(workspacePath: string): void;
  /**
   * Every request the mock was asked to serve, summarised.
   *
   * NOT read from the journal: that truncates a body over 64KB, and an agent's
   * main turn — system prompt plus every tool schema — is well past that, so the
   * one request a failure is usually about is the one the journal cannot show.
   * This comes from a match predicate instead, which sees the whole request.
   */
  seenRequests(): readonly SeenRequest[];
}

export interface AgentMockHandle {
  (): AgentMock;
}

/**
 * Start a mock LLM for the agent this Playwright project exercises.
 *
 * Call this BEFORE `useApp()`: both register `beforeAll` hooks, Playwright runs
 * them in registration order, and `launchApp` needs the mock's port.
 */
export function useAgentMock(): AgentMockHandle {
  let handle: AgentMock;
  let server: LLMock;
  let configDir: string;
  let seen: SeenRequest[] = [];

  test.beforeAll(async () => {
    const agent = test.info().project.name as Agent;
    configDir = mkdtempSync(join(tmpdir(), "ch-e2e-agent-"));

    // port 0: the suite already picks a free port for the IDE server rather than
    // colliding with a developer's running instance, and a mock is no different.
    server = new LLMock({ port: 0, strict: true });
    server.loadFixtureFile(join(import.meta.dirname, "aimock", `${agent}.json`));

    // A recorder, not a fixture: its predicate always returns false, so matching
    // carries on to the real fixtures and behaviour is unchanged. Prepended so
    // it sees every request, including ones a later fixture will serve.
    seen = [];
    server.prependFixture({
      match: {
        predicate: (request) => {
          seen.push(summarize(request));
          return false;
        },
      },
      response: { content: "" },
    });
    const url = await server.start();

    const dir = configDir;
    handle = {
      url,
      env: agentEnv(agent, url, dir),
      server,
      trustWorkspace: (workspacePath) => {
        if (agent !== "claude") return;
        writeClaudeConfig(dir, pathSpellings(workspacePath));
      },
      seenRequests: () => seen,
    };
  });

  // A failing turn is otherwise mute: the assertions can see the sidebar and the
  // app's log, but not the conversation. Print what the mock was actually asked
  // for, field by field, so a miss names the gate it failed.
  test.afterEach(() => {
    if (test.info().status === test.info().expectedStatus) return;
    if (seen.length === 0) {
      console.log("[agent-mock] the agent never called the mock at all");
      return;
    }
    for (const [index, request] of seen.entries()) {
      console.log(
        `[agent-mock] request ${index}: systemMarker=${request.systemHasMarker} ` +
          `hasToolResult=${request.hasToolResult} tools=${request.tools.length}`
      );
      console.log(`[agent-mock]   user: ${JSON.stringify(request.userMessage.slice(0, 160))}`);
      console.log(
        `[agent-mock]   last tool result: ${JSON.stringify(request.toolResult.slice(0, 300))}`
      );
      console.log(`[agent-mock]   system: ${JSON.stringify(request.system.slice(0, 160))}`);
      console.log(
        `[agent-mock]   codehydra tools: ${JSON.stringify(
          request.tools.filter((name) => name.includes("codehydra"))
        )}`
      );
    }
  });

  test.afterAll(async () => {
    await server?.stop().catch(() => {});
    if (!configDir) return;
    try {
      // Retried, like every other rm in the suite: on Windows the agent has only
      // just exited and still holds its config dir, so the first attempt sees
      // ENOTEMPTY. Tolerated if it still fails — this is an OS temp directory
      // that existed to configure a process which has now gone, and a leftover
      // must not fail a turn that passed.
      rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Left for the OS to reap.
    }
  });

  return () => handle;
}

/** Reduce a request to the fields the fixtures gate on. */
function summarize(request: ChatCompletionRequest): SeenRequest {
  const messages = request.messages ?? [];
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => getTextContent(message.content) ?? "")
    .join(" ");
  const lastUser = messages.filter((message) => message.role === "user").at(-1);
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  return {
    systemHasMarker: system.includes(SYSTEM_PROMPT_MARKER),
    system,
    userMessage: getTextContent(lastUser?.content ?? null) ?? "",
    tools: (request.tools ?? []).map((tool) => tool.function.name),
    // aimock's own `hasToolResult` scoping: a tool message after the last user
    // message.
    hasToolResult: messages.slice(lastUserIndex + 1).some((message) => message.role === "tool"),
    toolResult:
      getTextContent(
        messages.filter((message) => message.role === "tool").at(-1)?.content ?? null
      ) ?? "",
  };
}

/** Everything the agent needs to run offline against `url`. */
function agentEnv(agent: Agent, url: string, configDir: string): Record<string, string> {
  if (agent === "opencode") {
    // OpenCode resolves config as: global -> OPENCODE_CONFIG -> project file ->
    // .opencode -> OPENCODE_CONFIG_CONTENT (the app's, which wins). The app sets
    // only `instructions` and `mcp`, so everything below survives the merge.
    const configPath = join(configDir, "opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${url}/v1` },
            models: { test: { name: "Mock Model" } },
          },
        },
        model: "mock/test",
        // OpenCode has no permission mode on its AgentSpec — the grant has to
        // come from config, or the agent parks on a prompt no one will answer.
        // Keys are wildcard patterns over tool names, and an MCP tool is named
        // `<server>_<tool>`, so `*` is what `bypassPermissions` is for Claude.
        permission: { "*": "allow" },
      })
    );
    return { OPENCODE_CONFIG: configPath };
  }

  // Trust is added per workspace by `trustWorkspace`, once its path is known.
  writeClaudeConfig(configDir, []);

  return {
    ANTHROPIC_BASE_URL: url,
    // A Bearer token rather than ANTHROPIC_API_KEY: an API key makes Claude ask
    // the user to approve it once, and nobody is there to answer.
    ANTHROPIC_AUTH_TOKEN: "codehydra-e2e",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
    // A config dir of our own, so the run neither reads nor writes the
    // developer's ~/.claude, and starts past onboarding.
    CLAUDE_CONFIG_DIR: configDir,
    // Keep the mock's journal to the turn under test, and keep a version check
    // or a crash report from reaching the network mid-run.
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

/**
 * Every spelling of `path` the trust key might be written under.
 *
 * Trust is keyed by the directory as Claude sees it, matched exactly, and on
 * Windows the same directory has several spellings: CodeHydra normalizes paths
 * to forward slashes and case-folds them (`d:/a/_temp/...`), while `join()` here
 * produces the native `D:\a\_temp\...`. Seeding one spelling left the agent
 * parked on the dialog in CI with no one to answer it. Cheap to cover them all;
 * a key that matches nothing costs nothing.
 */
function pathSpellings(path: string): readonly string[] {
  // Only Windows has more than one spelling of a path. Elsewhere both transforms
  // are identity, and a backslash form would just be a key matching nothing.
  if (process.platform !== "win32") return [path];
  const separators = [path, path.replace(/\\/g, "/")];
  return [...new Set(separators.flatMap((form) => [form, form.toLowerCase()]))];
}

/**
 * Write the Claude config for this run: past first-run onboarding, past the
 * bypass-permissions warning, and trusting exactly `trusted`.
 */
function writeClaudeConfig(configDir: string, trusted: readonly string[]): void {
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      // `--permission-mode bypassPermissions` otherwise stops on a one-time
      // warning screen of its own.
      bypassPermissionsModeAccepted: true,
      projects: Object.fromEntries(
        trusted.map((path) => [
          path,
          { hasTrustDialogAccepted: true, allowedTools: [], history: [] },
        ])
      ),
    })
  );
}

/** The tool name the fixtures for `agent` expect the agent to advertise. */
export function setTitleTool(agent: Agent): string {
  return SET_TITLE_TOOL[agent];
}

export { SYSTEM_PROMPT_MARKER };
