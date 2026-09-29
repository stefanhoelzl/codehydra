/**
 * A real agent, taking a real turn, calling back into CodeHydra over MCP.
 *
 * Every other spec stops at the wiring: a workspace is created, an agent
 * terminal opens, and the sidebar reports a status derived from the terminal's
 * own open/close. Nothing checks the part CodeHydra exists for — that what it
 * hands the agent (a system prompt, an MCP server, an initial prompt) arrives,
 * that the agent can act on it, and that acting on it lands back in the UI.
 *
 * The agent is real; only the model is not. `useAgentMock` points it at a local
 * mock whose fixtures match ONLY when CodeHydra's system prompt and its MCP tool
 * are both present in the request, with the server in strict mode — so the
 * assertions below are not the whole test. A launch that stopped injecting
 * either one matches no fixture, gets a 503, and fails the turn.
 *
 * Runs once per warm Playwright project, so both agents are held to the same
 * behaviour through their two very different launch paths.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { projectDirName } from "../src/boundaries/platform/paths";
import { Path } from "../src/utils/path/path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import {
  AGENT_PROMPT,
  AGENT_SET_TITLE,
  MESSAGE_PROBE,
  setTitleTool,
  useAgentMock,
} from "./agent-mock.ts";
import { chAsync, json } from "./ch.ts";
import {
  appLogEntries,
  DATA_ROOT,
  type LogEntry,
  useApp,
  waitForConnectionDetails,
  waitForWorkspaceFrame,
  workspaceRow,
  workspacesDir,
  POLL_INTERVALS,
} from "./fixtures";
import type { Agent } from "./env.ts";

const WORKSPACE_NAME = "agent-turn";

/** A second workspace, for messages: an agent launched without a prompt. */
const MESSAGE_WORKSPACE_NAME = "agent-message";

/** A whole turn: worktree, IDE server, agent boot, two round trips to the mock. */
const TURN_TIMEOUT_MS = 240_000;

// The teardown test deletes the workspace the turn created: one story.
test.describe.configure({ mode: "serial", timeout: TURN_TIMEOUT_MS + 120_000 });

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

/**
 * `<dataRoot>/projects/<id>/workspaces` as the app will name it for the test
 * repository — known before the project is opened, so Claude's trust can be
 * written before any Claude runs.
 *
 * The same derivation as `workspacesRoot()` in the app (`paths.workspaces` is
 * unset in the suite, so the root is the data root). The first test asserts it
 * against the directory the app actually creates.
 */
function plannedWorkspacesDir(): string {
  return join(DATA_ROOT, "projects", projectDirName(new Path(repo.path).toString()), "workspaces");
}

// Order matters: all three register `beforeAll`, Playwright runs them in
// registration order — the repository above names the workspaces the mock
// trusts, and the app's launch environment is built from the mock's port.
const mock = useAgentMock({
  trustedWorkspaces: () =>
    [WORKSPACE_NAME, MESSAGE_WORKSPACE_NAME].map((name) => join(plannedWorkspacesDir(), name)),
});
const app = useApp({ env: () => mock().env });

// What each agent terminal shows when a test fails. An agent stuck before its
// session starts — on a prompt nobody answers — reports nothing to the app or the
// mock, so its screen is the only witness. Only the active workspace's frame is
// rendered, hence the switch.
test.afterEach(async () => {
  const info = test.info();
  if (info.status === info.expectedStatus) return;
  for (const name of [WORKSPACE_NAME, MESSAGE_WORKSPACE_NAME]) {
    const switched = await chAsync(["ws", "switch", name]);
    if (switched.status !== 0) continue;
    try {
      await waitForWorkspaceFrame(app(), name, 30_000);
      // The frame attaches before the terminal repaints.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // A file, not a body: CI uploads the output directory, and a body only
      // reaches the HTML report, which it does not.
      const path = info.outputPath(`screen-${name}.png`);
      await app().uiPage().screenshot({ path });
      await info.attach(`screen-${name}.png`, { path, contentType: "image/png" });
    } catch (error) {
      console.log(`[agent-turn] no screenshot of ${name}: ${String(error)}`);
    }
  }
});

/**
 * The workspace's title as CodeHydra stores it: `codehydra.title` on the
 * workspace's branch, in the project repository's git config.
 */
function readWorkspaceTitle(): string {
  const run = spawnSync(
    "git",
    ["-C", repo.path, "config", "--get", `branch.${WORKSPACE_NAME}.codehydra.title`],
    { encoding: "utf-8" }
  );
  return (run.stdout ?? "").trim();
}

/** The agent this Playwright project exercises. */
function currentAgent(): Agent {
  return test.info().project.name as Agent;
}

/**
 * `<dataRoot>/projects/<id>/workspaces`, once opening the project has created it.
 *
 * `workspacesDir()` throws until exactly one project directory exists, and the
 * app writes it a moment after `ch project open` returns.
 */
async function resolvedWorkspacesDir(): Promise<string> {
  let dir = "";
  await expect
    .poll(
      () => {
        try {
          dir = workspacesDir();
          return true;
        } catch {
          return false;
        }
      },
      { intervals: POLL_INTERVALS, timeout: 60_000 }
    )
    .toBe(true);
  return dir;
}

test("an agent takes a turn and renames its own workspace over MCP", async () => {
  const agent = currentAgent();
  const ui = app().uiPage();

  // launchApp returns at the `show-ui` hook point, two before the API server
  // binds and publishes its port — so `ch` would otherwise race startup and
  // report the app as not running.
  await waitForConnectionDetails();

  // Open the project first, for one reason: Claude's trust was written for the
  // workspace directories the app was expected to create, keyed by exact path.
  // Checked here, before any agent launches: a mismatch would otherwise show up
  // as an agent parked on a trust prompt nobody is there to answer.
  expect(json(await chAsync(["project", "open", repo.path]))).toBeTruthy();
  expect(
    await resolvedWorkspacesDir(),
    "the app named the workspaces directory differently from plannedWorkspacesDir(), " +
      "so Claude is trusted for the wrong paths"
  ).toBe(plannedWorkspacesDir());

  // Created through the CLI rather than the panel: that is the path a caller
  // (or another agent) actually uses to hand a new workspace a prompt, and it
  // exercises the initial-prompt file the wrapper consumes at launch.
  //
  // `chAsync`, never the synchronous `ch`: the mock LLM lives in this process,
  // and OpenCode's server comes up and sends its first prompt DURING creation.
  // A blocking spawn here would stop the mock answering it, and the agent would
  // hang on a socket nobody is reading.
  const created = await chAsync([
    "ws",
    "create",
    WORKSPACE_NAME,
    "--project",
    repo.path,
    "--prompt",
    AGENT_PROMPT,
    "--agent",
    agent,
    // Claude would otherwise stop on a permission prompt for the MCP tool, and
    // `PermissionRequest` maps to *idle* — the workspace would look finished.
    // OpenCode has no such flag; its grant is in the config the mock wrote.
    ...(agent === "claude" ? ["--permission-mode", "bypassPermissions"] : []),
  ]);
  expect(created.status, `ch ws create failed: ${created.stderr}`).toBe(0);

  // Two separate facts, asserted separately so a failure says which one broke.
  //
  // First: the agent's MCP call reached CodeHydra and took effect. Read straight
  // out of git config, where workspace metadata lives — no app connection, so a
  // transport problem cannot be mistaken for the agent not having acted.
  await expect
    .poll(() => readWorkspaceTitle(), {
      intervals: POLL_INTERVALS,
      timeout: TURN_TIMEOUT_MS,
      message:
        "the agent never set the title — its MCP call to CodeHydra did not land " +
        "(the mock's per-request diagnostic above says how far the conversation got)",
    })
    .toBe(AGENT_SET_TITLE);

  // Second: it reached the UI. On the row's TEXT, not its accessible name: the
  // aria-label is built from `workspace.name` (Sidebar.svelte), while the title
  // is what the row renders (`primaryLabel = workspace.title ?? workspace.name`).
  //
  // No need to expand the sidebar: it is overflow-clipped but its rows still
  // have a box, which is why `createWorkspace()` asserts on them the same way.
  await expect(workspaceRow(ui, WORKSPACE_NAME)).toBeVisible({ timeout: TURN_TIMEOUT_MS });
  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, WORKSPACE_NAME) })
    .last();
  await expect(row).toContainText(AGENT_SET_TITLE, { timeout: TURN_TIMEOUT_MS });

  // Idle, and idle because the agent finished: with permissions granted there is
  // no PermissionRequest to park on, and a turn that ended any other way leaves
  // the workspace busy.
  await expect(
    ui.getByRole("button", { name: new RegExp(`^${WORKSPACE_NAME} in .* - 1 agent idle$`) })
  ).toBeVisible({ timeout: TURN_TIMEOUT_MS });

  // The mock's own account of the conversation. Two turns: the tool call, then
  // the reply to its result.
  const requests = mock().server.getRequests();
  const unmatched = requests.filter((entry) => entry.response.fixture === null);
  expect(
    unmatched.map((entry) => `${entry.path} -> ${entry.response.status}`),
    "the agent made a call no fixture anticipated — read it in the journal and give it one, " +
      "rather than adding a catch-all"
  ).toEqual([]);
  expect(requests.length, "expected a tool-call turn and a follow-up turn").toBeGreaterThanOrEqual(
    2
  );

  // That the injections arrived is asserted by WHICH fixture served the turn:
  // the tool-call fixture matches only when CodeHydra's system prompt and its
  // MCP tool are both in the request. Asserted through the fixture rather than
  // by re-reading the request, because the journal truncates a body over 64KB
  // and Claude's main turn — system prompt plus every tool schema — is ~130KB.
  const gatedTurn = mock()
    .server.getFixtures()
    .find((fixture) => "toolCalls" in fixture.response);
  expect(gatedTurn, "the tool-call fixture is missing from the fixture file").toBeDefined();
  expect(
    requests.some((entry) => entry.response.fixture === gatedTurn),
    `nothing was served by the gated fixture — the agent never sent a request carrying both ` +
      `CodeHydra's system prompt and ${setTitleTool(agent)}`
  ).toBe(true);
});

test("a message from outside reaches the running agent, and --wake brings a closed one back", async () => {
  test.setTimeout(TURN_TIMEOUT_MS * 2);
  const agent = currentAgent();
  const ui = app().uiPage();

  // A workspace of its own, launched without a prompt and — for Claude — in the
  // default permission mode: a session that bypasses permission prompts holds
  // a message from outside for its user's approval, which the turn workspace
  // above runs in. A message that needs no tool never meets a permission prompt.
  const created = await chAsync([
    "ws",
    "create",
    MESSAGE_WORKSPACE_NAME,
    "--project",
    repo.path,
    "--agent",
    agent,
  ]);
  expect(created.status, `ch ws create failed: ${created.stderr}`).toBe(0);

  const idleRow = ui.getByRole("button", {
    name: new RegExp(`^${MESSAGE_WORKSPACE_NAME} in .* - 1 agent idle$`),
  });
  await expect(idleRow, "the agent never came up idle").toBeVisible({ timeout: TURN_TIMEOUT_MS });

  /** Whether the model was handed a turn carrying `text`, as a message from `ch`. */
  const delivered = (text: string): boolean =>
    mock()
      .seenRequests()
      .some(
        (request) =>
          request.userMessage.includes(text) &&
          // How each agent names the sender. `ch` runs outside every workspace
          // here, so it signs as the CLI.
          request.userMessage.includes(
            agent === "claude"
              ? '<cross-session-message from-name="CodeHydra · ch">'
              : "[from CodeHydra · ch]"
          )
      );

  // `chAsync`: the mock in this process has to answer the turn the message starts.
  const first = `${MESSAGE_PROBE} one — the build is green`;
  const sent = await chAsync([
    "ws",
    "agent",
    "message",
    "--workspace",
    MESSAGE_WORKSPACE_NAME,
    first,
  ]);
  expect(sent.status, `ch ws agent message failed: ${sent.stderr}`).toBe(0);
  await expect
    .poll(() => delivered(first), {
      intervals: POLL_INTERVALS,
      timeout: TURN_TIMEOUT_MS,
      message: "the message never reached the model (the mock's diagnostic above has the requests)",
    })
    .toBe(true);
  await expect(idleRow, "the turn the message started never ended").toBeVisible({
    timeout: TURN_TIMEOUT_MS,
  });

  // Close the agent terminal: no agent to take a message, until --wake reopens it.
  const closed = await chAsync(["ws", "agent", "close", "--workspace", MESSAGE_WORKSPACE_NAME]);
  expect(closed.status, `ch ws agent close failed: ${closed.stderr}`).toBe(0);
  await expect
    .poll(
      async () => {
        const status = await chAsync(["ws", "status", "--workspace", MESSAGE_WORKSPACE_NAME]);
        return (json(status) as { agent: { type: string } }).agent.type;
      },
      {
        intervals: POLL_INTERVALS,
        timeout: 60_000,
        message: "the agent never reported its terminal closed",
      }
    )
    .toBe("none");

  const second = `${MESSAGE_PROBE} two — pick this back up`;
  const refused = await chAsync([
    "ws",
    "agent",
    "message",
    "--workspace",
    MESSAGE_WORKSPACE_NAME,
    second,
  ]);
  // Not found: there is no agent to take it. Reported, not logged as a fault.
  expect(refused.status, "a message to a closed agent terminal must fail").toBe(6);

  const woken = await chAsync([
    "ws",
    "agent",
    "message",
    "--workspace",
    MESSAGE_WORKSPACE_NAME,
    "--wake",
    second,
  ]);
  expect(woken.status, `ch ws agent message --wake failed: ${woken.stderr}`).toBe(0);
  await expect
    .poll(() => delivered(second), {
      intervals: POLL_INTERVALS,
      timeout: TURN_TIMEOUT_MS,
      message: "the message never reached the reopened agent",
    })
    .toBe(true);

  const unmatched = mock()
    .server.getRequests()
    .filter((entry) => entry.response.fixture === null);
  expect(
    unmatched.map((entry) => `${entry.path} -> ${entry.response.status}`),
    "the agent made a call no fixture anticipated"
  ).toEqual([]);

  const deleted = await chAsync([
    "ws",
    "delete",
    "--workspace",
    MESSAGE_WORKSPACE_NAME,
    "--ignore-warnings",
  ]);
  expect(deleted.status, `ch ws delete failed: ${deleted.stderr}`).toBe(0);
});

test("deleting the workspace waits for the agent to exit, not for a timeout", async () => {
  // Teardown Ctrl+Cs the agent and waits for its terminal's close, reported as
  // the "close" agent lifecycle event. The agent used to be typed into a shell
  // that outlived it, so the terminal never closed: every deletion of a
  // workspace with a live agent sat out api-server's full timeout and fell
  // back to killing the orphaned shell. Only a real terminal running a real
  // agent shows that, which is why it is asserted here.

  const forWorkspace = (entry: LogEntry): boolean => entry.scope?.["ws"] === WORKSPACE_NAME;

  const deleted = await chAsync([
    "ws",
    "delete",
    "--workspace",
    WORKSPACE_NAME,
    "--ignore-warnings",
  ]);
  expect(deleted.status, `ch ws delete failed: ${deleted.stderr}`).toBe(0);

  const entries = appLogEntries().filter(forWorkspace);
  expect(
    entries.filter(
      (entry) =>
        entry.message === "Agent terminal did not close in time; falling back to process cleanup"
    ),
    "teardown timed out waiting for the agent terminal — the shell it was launched in " +
      "outlived the agent"
  ).toEqual([]);
  expect(
    entries.some((entry) => entry.message === "Agent terminal closed"),
    "teardown never saw the agent terminal close"
  ).toBe(true);
});
