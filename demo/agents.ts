/**
 * The demo's agents: the real `claude` CLI, answered by a scripted mock model.
 *
 * Every workspace in the story has a script — the turns its agent takes, each a
 * list of steps (tool calls, with a line of text to show) and a closing reply.
 * One response factory serves all of them: it finds the workspace from the
 * working directory in Claude's system prompt, the turn from the user messages,
 * and the step from the tool-call ids it handed out earlier in the same
 * conversation (`demo_<turn>_<step>_<n>`). So the conversation itself is the
 * state, and an agent that restarts (`--continue` after a wake) carries on.
 *
 * Steps can wait on a gate the recorder opens, which is how the story's beats
 * happen on camera instead of whenever an agent gets there.
 */
import { getTextContent, LLMock, type ChatCompletionRequest } from "@copilotkit/aimock";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  FLAKY_TEST,
  FLAKY_TEST_FIXED_LINE,
  OWN_PR,
  PULL_REQUESTS,
  STYLES,
  styledPage,
} from "./scaffold.ts";
import { sleep } from "./film.ts";

/** The prompts typed on camera. The scripts match on them. */
export const PROMPTS = {
  restyle: "Try three looks for Nimbus — minimal, gradient and retro — one workspace each.",
  flaky: "The forecast test fails every morning. Fix it and open a PR.",
} as const;

/** The look picked on camera, and its position among the choices offered. */
export const PICK = "style-gradient";
const CHOICES = Object.keys(STYLES);
export const PICK_INDEX = CHOICES.indexOf(PICK);

/** The workspaces each project's agents run in, for Claude's folder trust. */
export const SITE_WORKSPACES = ["restyle", ...CHOICES];
export const API_WORKSPACES = ["flaky-test", ...PULL_REQUESTS.map((pr) => `pr-${pr.number}`)];

/** Gates the recorder opens to release a step. */
export type Gate = "spawn" | "hibernate" | "compare";

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface Step {
  /** Shown before the calls, as the agent's own words. */
  readonly text?: string;
  readonly calls: (cwd: string) => readonly Call[];
  /** Held until the recorder opens this gate. */
  readonly gate?: Gate;
  /** "Thinking" time before the step is answered. */
  readonly thinkMs?: number;
}

interface Turn {
  /** A substring of the user message that starts this turn. */
  readonly trigger: string;
  readonly steps: readonly Step[];
  /** The reply that ends the turn. */
  readonly reply: string;
}

const mcp = (tool: string): string => `mcp__codehydra__${tool}`;

function variantTurn(workspace: string): Turn {
  const style = STYLES[workspace]!;
  const page = (cwd: string): string => join(cwd, "index.html");
  return {
    trigger: "Restyle Nimbus",
    steps: [
      { calls: () => [{ name: mcp("workspace_set_title"), args: { title: style.title } }] },
      {
        text: `Restyling Nimbus: ${style.title.toLowerCase()}.`,
        thinkMs: 2500,
        calls: (cwd) => [
          {
            name: "Write",
            args: { file_path: join(cwd, "theme.css"), content: `${style.css.trim()}\n` },
          },
        ],
      },
      {
        text: "Opening a preview beside this session.",
        calls: () => [
          {
            name: mcp("workspace_execute_command"),
            args: { command: "workbench.action.newGroupRight" },
          },
        ],
      },
      {
        calls: (cwd) => [
          { name: mcp("workspace_open_browser"), args: { url: `file://${page(cwd)}` } },
        ],
      },
    ],
    reply: `Done — Nimbus now has a ${style.title.toLowerCase()} look. The preview is open on the right.`,
  };
}

function reviewTurn(pr: (typeof PULL_REQUESTS)[number]): Turn {
  return {
    trigger: `Review pull request #${pr.number}`,
    steps: [
      {
        text: `Reading the diff of #${pr.number}.`,
        calls: () => [
          {
            name: "Bash",
            args: { command: `gh pr diff ${pr.number}`, description: "Show the PR diff" },
          },
        ],
      },
    ],
    reply:
      `**#${pr.number} ${pr.title}** — looks good.\n\n` +
      "- The markup is small and self-contained.\n" +
      "- One nit: the times are hard-coded; they should come from the forecast data.\n\n" +
      "Approve once the times are wired up.",
  };
}

/** What each workspace's agent does, turn by turn. */
const SCRIPTS: Record<string, readonly Turn[]> = {
  restyle: [
    {
      trigger: "Try three looks",
      steps: [
        {
          gate: "spawn",
          text: "I'll give each look its own workspace and agent, and put them side by side once all three are done.",
          calls: () =>
            CHOICES.map((name) => ({
              name: mcp("workspace_create"),
              args: { name, prompt: `Restyle Nimbus: ${STYLES[name]!.title.toLowerCase()}.` },
            })),
        },
        {
          gate: "compare",
          text: "All three are done. Lining them up for you.",
          thinkMs: 1500,
          calls: (cwd) => [
            {
              name: "Write",
              args: { file_path: join(cwd, "compare.html"), content: comparePage() },
            },
          ],
        },
        {
          calls: () => [
            {
              name: mcp("workspace_execute_command"),
              args: { command: "workbench.action.newGroupRight" },
            },
          ],
        },
        {
          calls: (cwd) => [
            {
              name: mcp("workspace_open_browser"),
              args: { url: `file://${join(cwd, "compare.html")}` },
            },
          ],
        },
        {
          calls: () => [
            {
              name: "AskUserQuestion",
              args: {
                questions: [
                  {
                    question: "Which look should Nimbus keep?",
                    header: "Look",
                    multiSelect: false,
                    options: CHOICES.map((name) => ({
                      label: STYLES[name]!.title,
                      description: `Keep ${name}`,
                    })),
                  },
                ],
              },
            },
          ],
        },
        {
          text: `Keeping ${PICK}. Deleting the other looks, then this workspace.`,
          calls: () =>
            CHOICES.filter((name) => name !== PICK).map((workspace) => ({
              name: mcp("workspace_delete"),
              args: { workspace, ignoreWarnings: true },
            })),
        },
        {
          calls: () => [{ name: mcp("workspace_switch"), args: { workspace: PICK } }],
        },
        {
          // Its own deletion ends this agent, so it does not wait for it.
          calls: () => [
            {
              name: mcp("workspace_delete"),
              args: { workspace: "restyle", ignoreWarnings: true, wait: false },
            },
          ],
        },
      ],
      reply: `Only ${PICK} is left.`,
    },
  ],
  "flaky-test": [
    {
      trigger: "forecast test fails",
      steps: [
        {
          text: "Let me look at the test.",
          calls: (cwd) => [{ name: "Read", args: { file_path: join(cwd, "forecast.test.mjs") } }],
        },
        {
          text: "It asserts the afternoon greeting at whatever time the suite runs. Pinning the clock.",
          calls: (cwd) => [
            {
              name: "Edit",
              args: {
                file_path: join(cwd, "forecast.test.mjs"),
                old_string: FLAKY_TEST.split("\n").find((line) => line.startsWith("assert.equal"))!,
                new_string: FLAKY_TEST_FIXED_LINE,
              },
            },
          ],
        },
        {
          calls: () => [
            {
              name: "Bash",
              args: {
                command:
                  'node forecast.test.mjs && git commit -qam "Pin the clock in the forecast test" && gh pr create --fill',
                description: "Run the test, commit and open a PR",
              },
            },
          ],
        },
        {
          gate: "hibernate",
          text: `PR #${OWN_PR} is up. CI takes a while — I'll hibernate and wake up when it finishes.`,
          calls: () => [
            {
              name: mcp("workspace_hibernate"),
              args: {
                wakeup:
                  `gh pr checks ${OWN_PR} >/dev/null && ` +
                  `echo '{"action":"wake","message":"CI on #${OWN_PR} passed"}' || true`,
              },
            },
          ],
        },
      ],
      reply: "Hibernating until CI is done.",
    },
    {
      trigger: `CI on #${OWN_PR} passed`,
      steps: [
        {
          text: `Woken up: CI on #${OWN_PR} passed. Double-checking.`,
          calls: () => [
            {
              name: "Bash",
              args: { command: `gh pr checks ${OWN_PR}`, description: "Show the PR's checks" },
            },
          ],
        },
      ],
      reply: `All checks pass on #${OWN_PR} — the forecast test is fixed and the PR is ready to merge.`,
    },
  ],
  ...Object.fromEntries(Object.keys(STYLES).map((name) => [name, [variantTurn(name)]])),
  ...Object.fromEntries(PULL_REQUESTS.map((pr) => [`pr-${pr.number}`, [reviewTurn(pr)]])),
};

/** The three looks stacked, each label above its page, scaled to half size. */
function comparePage(): string {
  const attribute = (html: string): string => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const figures = CHOICES.map(
    (name, i) => `<figure>
  <figcaption>${i + 1}. ${STYLES[name]!.title} <span>${name}</span></figcaption>
  <div class="frame"><iframe srcdoc="${attribute(styledPage(name))}"></iframe></div>
</figure>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Nimbus looks</title>
<style>
  body { margin: 0; padding: 14px; background: #0d1117; color: #e6edf3; font: 14px system-ui, sans-serif; }
  figure { margin: 0 0 14px; }
  figcaption { margin-bottom: 6px; font-weight: 650; }
  figcaption span { color: #8b949e; font-weight: 400; margin-left: 0.4rem; }
  .frame { position: relative; width: 100%; aspect-ratio: 1300 / 540; overflow: hidden;
           border: 1px solid #30363d; border-radius: 8px; }
  iframe { position: absolute; border: 0; width: 200%; height: 200%;
           transform: scale(0.5); transform-origin: 0 0; }
</style>
</head>
<body>
${figures}
</body>
</html>
`;
}

const STEP_ID = /^demo_(\d+)_(\d+)_\d+$/;
const CWD = /(?:Primary working directory|Working directory): (\S+)/;

/**
 * The agent's working directory, from the environment block Claude includes —
 * in the system prompt in some versions, in the first user message in others.
 */
function cwdOf(request: ChatCompletionRequest): string | undefined {
  for (const message of request.messages) {
    const match = CWD.exec(textOf(message.content));
    if (match) return match[1];
  }
  return undefined;
}

function textOf(content: ChatCompletionRequest["messages"][number]["content"]): string {
  return getTextContent(content) ?? "";
}

export interface DemoAgents {
  /** Environment for the app, pointing every agent at the mock. */
  readonly env: Record<string, string>;
  /** Release the steps waiting on `gate`. */
  open(gate: Gate): void;
  /** Resolves once `workspace` has been answered step `step` of its turn `turn`. */
  served(workspace: string, turn: number, step: number | "reply"): Promise<void>;
  /** Requests no script could answer; the recorder fails on any. */
  readonly unexpected: string[];
  stop(): Promise<void>;
}

/**
 * Start the mock and write Claude's config: past onboarding, every story
 * workspace trusted (by exact path — a parent entry does not cover its
 * children), and every scripted tool allowed so no call stops on a prompt.
 */
export async function startAgents(options: {
  configDir: string;
  /** Every workspace directory an agent runs in. */
  trusted: readonly string[];
  extraEnv: Record<string, string>;
  /** Every request, one line each — the first stop when a beat goes missing. */
  requestLog: string;
}): Promise<DemoAgents> {
  const { configDir } = options;
  const trace = (line: string): void => appendFileSync(options.requestLog, `${line}\n`);
  writeClaudeConfig(configDir, options.trusted);

  const gates = new Map<Gate, { open: () => void; opened: Promise<void> }>();
  const gate = (name: Gate): { open: () => void; opened: Promise<void> } => {
    let entry = gates.get(name);
    if (!entry) {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => (open = resolve));
      entry = { open, opened };
      gates.set(name, entry);
    }
    return entry;
  };

  const waiters: Array<{ key: string; resolve: () => void }> = [];
  const servedKeys = new Set<string>();
  const markServed = (key: string): void => {
    servedKeys.add(key);
    for (const waiter of waiters.filter((w) => w.key === key)) waiter.resolve();
  };
  const unexpected: string[] = [];

  const server = new LLMock({ port: 0 });
  server.addFixture({
    match: { predicate: () => true },
    // Streams the agent's words at a readable pace instead of all at once.
    streamingProfile: { ttft: 300, tps: 60 },
    response: async (request) => {
      const system = request.messages
        .filter((m) => m.role === "system")
        .map((m) => textOf(m.content))
        .join("\n");
      const users = request.messages.filter((m) => m.role === "user");
      trace(
        `${new Date().toISOString()} system=${JSON.stringify(system.slice(0, 120))} ` +
          `cwd=${cwdOf(request) ?? "-"} tools=${request.tools?.length ?? 0} ` +
          `messages=${request.messages.length} lastUser=${JSON.stringify(textOf(users.at(-1)?.content ?? null).slice(-160))}`
      );
      // Claude names each session in a call of its own, with no tools.
      if (system.includes("naming a coding session")) return { content: "Nimbus task" };

      const cwd = cwdOf(request);
      const workspace = cwd === undefined ? undefined : basename(cwd);
      const turns = workspace === undefined ? undefined : SCRIPTS[workspace];
      if (cwd === undefined || workspace === undefined || turns === undefined) {
        unexpected.push(`no script for request (cwd ${cwd ?? "unknown"})`);
        return { content: "" };
      }

      // The turn is the one whose trigger appears in the latest user message.
      let turnIndex = -1;
      let latest = -1;
      request.messages.forEach((message, position) => {
        if (message.role !== "user") return;
        const text = textOf(message.content);
        turns.forEach((turn, index) => {
          if (text.includes(turn.trigger) && position >= latest) {
            latest = position;
            turnIndex = index;
          }
        });
      });
      const turn = turns[turnIndex];
      if (turn === undefined) {
        unexpected.push(`${workspace}: no turn matches the conversation`);
        return { content: "" };
      }

      // Steps of this turn already handed out, read back from their call ids.
      let done = -1;
      for (const message of request.messages) {
        for (const call of message.tool_calls ?? []) {
          const match = STEP_ID.exec(call.id);
          if (match && Number(match[1]) === turnIndex) done = Math.max(done, Number(match[2]));
        }
      }
      const stepIndex = done + 1;
      const step = turn.steps[stepIndex];
      if (step === undefined) {
        await sleep(800);
        markServed(`${workspace}:${turnIndex}:reply`);
        return { content: turn.reply };
      }

      const calls = step.calls(cwd);
      const tools = new Set((request.tools ?? []).map((tool) => tool.function.name));
      // Claude sends the first prompt before its MCP servers are connected.
      if (calls.some((call) => call.name.startsWith("mcp__") && !tools.has(call.name))) {
        return {
          toolCalls: [{ name: "WaitForMcpServers", arguments: "{}" }],
          reasoning: "Waiting for the MCP servers to connect.",
        };
      }

      if (step.gate) await gate(step.gate).opened;
      await sleep(step.thinkMs ?? 1200);
      markServed(`${workspace}:${turnIndex}:${stepIndex}`);
      const toolCalls = calls.map((call, n) => ({
        id: `demo_${turnIndex}_${stepIndex}_${n}`,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }));
      // Anthropic rejects a tool-loop continuation whose assistant turn does not
      // begin with a thinking block; `reasoning` is replayed as exactly that.
      const reasoning = step.text ?? "Next step.";
      return step.text === undefined
        ? { toolCalls, reasoning }
        : { content: step.text, toolCalls, reasoning };
    },
  });
  const url = await server.start();

  return {
    env: {
      ...options.extraEnv,
      ANTHROPIC_BASE_URL: url,
      // A Bearer token rather than ANTHROPIC_API_KEY: an API key makes Claude ask
      // the user to approve it once.
      ANTHROPIC_AUTH_TOKEN: "codehydra-demo",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      CLAUDE_CONFIG_DIR: configDir,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
    open: (name) => gate(name).open(),
    served: (workspace, turn, step) => {
      const key = `${workspace}:${turn}:${step}`;
      if (servedKeys.has(key)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ key, resolve }));
    },
    unexpected,
    stop: async () => {
      for (const entry of gates.values()) entry.open();
      await server.stop();
    },
  };
}

function writeClaudeConfig(configDir: string, trusted: readonly string[]): void {
  mkdirSync(configDir, { recursive: true });
  // Not bypassPermissions: in that mode Claude holds every message from outside
  // until someone approves it in its terminal, and the wakeup message would sit
  // there unread. An allowlist covers every tool the scripts call instead.
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      permissions: {
        defaultMode: "acceptEdits",
        allow: ["Bash", "Read", "Edit", "Write", "AskUserQuestion", "mcp__codehydra"],
      },
    })
  );
  const version = claudeVersion();
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      // Unseen release notes force the welcome panel open.
      lastOnboardingVersion: version,
      lastReleaseNotesSeen: version,
      numStartups: 10,
      projects: Object.fromEntries(
        trusted.map((path) => [
          path,
          { hasTrustDialogAccepted: true, allowedTools: [], history: [] },
        ])
      ),
    })
  );
}

function claudeVersion(): string {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim().split(/\s+/)[0]!;
  } catch {
    return "99.0.0";
  }
}
