/**
 * Plugins, end to end against the packaged app: real manifests, real shells,
 * real git, real processes.
 *
 * This is the chain the integration tests deliberately stop short of: a script
 * written into a manifest, run through the shell it names on the OS the suite
 * runs on — bash everywhere (Git Bash on Windows), cmd and PowerShell on
 * Windows — with what it returns reaching the app.
 *
 * One story, in order:
 *
 * - a repository ships two plugins; the trust question lists both, and once
 *   remembered they run with the user's own plugins, whose title they override;
 * - the open hook's environment stays out of every file; `ch` works in a hook;
 * - `ch plugin` lists, disables and reports;
 * - the deletion gate refuses, Dismiss escapes it, and Cancel stops hooks that
 *   never finish, on the loading panel and on the deletion panel;
 * - automations create workspaces (reconciled and as events, waking a
 *   hibernated one), run another action, and report a failing script with its
 *   run log;
 * - a repository still carrying the old `.codehydra/hooks` is offered Migrate.
 *
 * The user's plugins are written after launch: `useApp` resets the data root
 * (the home's plugins included) right before it launches, and plugins are read
 * each time they would run, so nothing needs a restart to see them.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import { ch, json } from "./ch.ts";
import {
  DATA_ROOT,
  HOME_ROOT,
  appLogEntries,
  collapseSidebar,
  createWorkspace,
  expandSidebar,
  launchApp,
  openProject,
  useApp,
  waitForConnectionDetails,
  waitForWorkspaceFrame,
  workspaceRow,
  workspacesDir,
} from "./fixtures";

const isWindows = process.platform === "win32";

/** Seconds between automation polls. The floor is 1; 2 keeps the log readable. */
const POLL_SECONDS = 2;
/** Generous: a poll has to land, then a worktree, IDE server and agent come up. */
const CREATE_TIMEOUT = 180_000;

const TITLE = "Set up by the repository";
const ENV_NAME = "CH_PLUGIN_E2E";
const ENV_VALUE = "plugged";
const REFUSAL = "e2e gate says no";

/** Markers the hooks leave in the worktree they run in. */
const MARK = {
  bash: ".bash-ran",
  pluginDir: ".plugin-dir-seen",
  cmd: ".cmd-ran",
  powershell: ".powershell-ran",
  otherPlatform: ".other-platform-ran",
  extra: ".extra-ran",
  open: ".before-workspace-opened-ran",
  event: ".on-workspace-opened-ran",
  gate: ".before-worktree-deleted-running",
} as const;

/** A platform this run is not on, for a document that must not apply. */
const OTHER_PLATFORM = process.platform === "linux" ? "macos" : "linux";

/** A path as bash on every platform reads it: Git Bash takes `C:/x/y`. */
function forBash(path: string): string {
  return path.replace(/\\/g, "/");
}

let repo: { path: string; cleanup: () => Promise<void> };
let fixtureDir: string;
let wsArmed: string;
let evArmed: string;
let notifyArmed: string;
let renderArmed: string;

// =============================================================================
// Manifests
// =============================================================================

/** The repository's own plugins, committed so a new worktree has them. */
function setupManifest(options: { hangSetup?: boolean } = {}): string {
  const setup = options.hangSetup
    ? "cat > /dev/null\nsleep 600"
    : `cat > /dev/null\necho '${JSON.stringify({ title: TITLE, tags: { e2e: { color: "#3498db" } } })}'`;
  return [
    "description: The repository's setup",
    "hooks:",
    `  after-worktree-created: ${JSON.stringify(setup)}`,
    `  before-workspace-opened: ${JSON.stringify(
      `cat > /dev/null\ntouch ${MARK.open}\necho '${JSON.stringify({ env: { [ENV_NAME]: ENV_VALUE } })}'`
    )}`,
    `  before-worktree-deleted: ${JSON.stringify(
      `cat > /dev/null\necho '${JSON.stringify({ blocked: true, reason: REFUSAL })}'`
    )}`,
    `  on-workspace-opened: ${JSON.stringify(`cat > /dev/null\ntouch ${MARK.event}`)}`,
    "",
  ].join("\n");
}

const EXTRA_MANIFEST = [
  "hooks:",
  `  after-worktree-created: ${JSON.stringify(`cat > /dev/null\ntouch ${MARK.extra}`)}`,
  "",
].join("\n");

/** A gate that never finishes on its own; the marker says it started. */
const HANGING_GATE = [
  "hooks:",
  `  before-worktree-deleted: ${JSON.stringify(`cat > /dev/null\ntouch ${MARK.gate}\nsleep 600`)}`,
  "",
].join("\n");

/** The user's plugin exercising every shell and the platform filter. */
function shellsManifest(): string {
  return [
    "hooks:",
    `  after-worktree-created: ${JSON.stringify(
      [
        "cat > /dev/null",
        `touch "$CH_WORKSPACE_DIR/${MARK.bash}"`,
        `test -f "$CH_PLUGIN_DIR/plugin.yaml" && touch "$CH_WORKSPACE_DIR/${MARK.pluginDir}"`,
        // The repository's plugin runs after this one and its title wins.
        `echo '{"title": "From the user"}'`,
      ].join("\n")
    )}`,
    "---",
    "platform: [linux, macos]",
    "hooks:",
    `  on-workspace-opened: ${JSON.stringify("cat > /dev/null\nch ws tag set via-ch")}`,
    "---",
    "platform: windows",
    "shell: cmd",
    "hooks:",
    `  after-worktree-created: ${JSON.stringify(
      `more > nul\r\ntype nul > "%CH_WORKSPACE_DIR%\\${MARK.cmd}"`
    )}`,
    `  on-workspace-opened: ${JSON.stringify("more > nul\r\ncall ch ws tag set via-ch")}`,
    "---",
    "platform: windows",
    "shell: powershell",
    "hooks:",
    `  after-worktree-created: ${JSON.stringify(
      `$null = [Console]::In.ReadToEnd()\nNew-Item -ItemType File -Path (Join-Path $env:CH_WORKSPACE_DIR "${MARK.powershell}") | Out-Null`
    )}`,
    "---",
    `platform: ${OTHER_PLATFORM}`,
    "hooks:",
    `  after-worktree-created: ${JSON.stringify(
      `cat > /dev/null\ntouch "$CH_WORKSPACE_DIR/${MARK.otherPlatform}"`
    )}`,
    "",
  ].join("\n");
}

/**
 * Emitter for the automations. `--consume` deletes the file after printing it,
 * which is how an events automation acks; without it the file is a standing
 * desired-state list. A missing file prints an empty array either way.
 */
const EMITTER = `const { existsSync, readFileSync, unlinkSync } = require("node:fs");
const file = process.argv[2];
const consume = process.argv[3] === "--consume";
if (!existsSync(file)) {
  console.log("[]");
} else {
  const body = readFileSync(file, "utf8");
  if (consume) unlinkSync(file);
  console.log(body);
}
`;

/** The user's automations plugin: a folder bundling its emitter. */
function automationsManifest(): string {
  const emit = (armed: string, consume: boolean): string =>
    `"${forBash(process.execPath)}" "$CH_PLUGIN_DIR/emit.cjs" "${forBash(armed)}"${consume ? " --consume" : ""}`;
  return `automations:
  tracked: ${JSON.stringify(emit(wsArmed, false))}
  events: ${JSON.stringify(emit(evArmed, true))}
  notify: ${JSON.stringify(emit(notifyArmed, true))}
  rendered: ${JSON.stringify(`${emit(renderArmed, true)} | ch plugin render "$CH_PLUGIN_DIR/render.yaml"`)}
  failing: "echo 'token=e2e-secret went wrong' >&2; exit 3"
`;
}

/** The template the `rendered` automation pipes its raw items through. */
const RENDER_TEMPLATE = `action: notification.show
title: "Rendered {{ n }}"
type: info
`;

/** A tracked workspace item: what the `tracked` automation's script prints. */
function trackedItem(id: string, name: string): unknown {
  return {
    action: "workspace.create",
    project: repo.path,
    name,
    key: id,
    metadata: { title: `Tracked ${id}` },
  };
}

/** An event item: what the `events` automation's script prints, once. */
function eventItem(name: string, reason: string): unknown {
  return {
    action: "workspace.create",
    event: true,
    project: repo.path,
    name,
    stealFocus: true,
    metadata: { title: `Event ${reason}`, tags: { nudge: { color: "#c47f2a" } } },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function writePlugin(dir: string, name: string, files: Record<string, string>): void {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
}

async function commitRepoPlugins(files: Record<string, string>, message: string): Promise<void> {
  const dir = join(repo.path, ".codehydra", "plugins");
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  const git = simpleGit(repo.path);
  await git.add(".codehydra");
  await git.commit(message);
}

/** Write an armed file atomically, so a poll never reads half of it. */
function writeArmed(path: string, items: unknown[]): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(items));
  renameSync(temp, path);
}

/** The automations' tracking map, or {} before anything has been persisted. */
function trackedEntries(): Record<string, { workspaceName: string }> {
  const path = join(DATA_ROOT, "state.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return (parsed["auto-workspaces"] ?? {}) as Record<string, { workspaceName: string }>;
}

function marker(workspace: string, name: string): boolean {
  return existsSync(join(workspacesDir(), workspace, name));
}

function rowOf(ui: Page, name: string): Locator {
  return ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, name) })
    .last();
}

/** Text inside the sidebar only — short tag names are too generic page-wide. */
function sidebarText(ui: Page, text: string): Locator {
  return ui.locator("nav.sidebar").getByText(text, { exact: true });
}

/** A hibernated row announces itself in its accessible name. */
function hibernatedRow(ui: Page, name: string): Locator {
  return ui.getByRole("button", { name: new RegExp(`^${name} in .*Hibernated`) });
}

function hibernatedFlag(name: string): string {
  const result = spawnSync("git", ["config", "--get", `branch.${name}.codehydra.hibernated`], {
    cwd: repo.path,
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

/** Click until `done` holds: `<vscode-button>` can swallow a click on Windows. */
async function clickUntil(button: Locator, done: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await button.click();
    try {
      await done();
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

async function removeViaSidebar(ui: Page, name: string): Promise<void> {
  await expandSidebar(ui);
  await rowOf(ui, name).getByRole("button", { name: "Remove workspace" }).click();
  const confirm = ui.getByRole("dialog", { name: "Remove Workspace" });
  await expect(confirm).toBeVisible();
  await clickUntil(confirm.getByRole("button", { name: "Remove", exact: true }), () =>
    expect(confirm).toBeHidden({ timeout: 5_000 })
  );
}

function launchFlags(): string[] {
  return [`--automations.poll-interval=${POLL_SECONDS}`];
}

// =============================================================================
// Setup
// =============================================================================

test.beforeAll(async () => {
  repo = await createTestGitRepo();
  fixtureDir = mkdtempSync(join(tmpdir(), "ch-e2e-plugins-"));
  wsArmed = join(fixtureDir, "workspaces.json");
  evArmed = join(fixtureDir, "events.json");
  notifyArmed = join(fixtureDir, "notify.json");
  renderArmed = join(fixtureDir, "render.json");
  await commitRepoPlugins(
    { "setup.yaml": setupManifest(), "extra.yaml": EXTRA_MANIFEST },
    "Add CodeHydra plugins"
  );
});

const app = useApp({ extraArgs: launchFlags });

// After useApp's own beforeAll: it resets the home right before launching.
test.beforeAll(() => {
  const local = join(HOME_ROOT, "plugins");
  writePlugin(local, "shells", { "plugin.yaml": shellsManifest() });
  writePlugin(local, "automations", {
    "plugin.yaml": automationsManifest(),
    "emit.cjs": EMITTER,
    "render.yaml": RENDER_TEMPLATE,
  });
  writeFileSync(join(local, "broken.yaml"), "hooks:\n  after-open: echo nope\n");
});

test.afterAll(async () => {
  await repo?.cleanup();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

// One story, told in order: each test leaves state the next one relies on.
test.describe.configure({ mode: "serial" });

// =============================================================================
// Hooks
// =============================================================================

test("asks once about the repository's plugins, then runs them with the user's", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();
  await openProject(app(), repo.path);

  // Creation parks on the trust dialog partway through.
  const creating = createWorkspace(app(), "alpha");
  const dialog = ui.getByRole("dialog", { name: "Run this repository's plugins?" });
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByText("setup", { exact: true })).toBeVisible();
  await expect(dialog.getByText("extra", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Remember", exact: true }).click();
  await creating;

  // bash everywhere, with the plugin's own folder in reach.
  expect(marker("alpha", MARK.bash)).toBe(true);
  expect(marker("alpha", MARK.pluginDir)).toBe(true);
  // cmd and PowerShell documents apply on Windows only.
  expect(marker("alpha", MARK.cmd)).toBe(isWindows);
  expect(marker("alpha", MARK.powershell)).toBe(isWindows);
  // A document for another platform never applies.
  expect(marker("alpha", MARK.otherPlatform)).toBe(false);
  // Both of the repository's plugins ran, and its open hook did too.
  expect(marker("alpha", MARK.extra)).toBe(true);
  expect(marker("alpha", MARK.open)).toBe(true);
});

test("the repository's title wins, and a tag set with ch in a hook shows", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  const row = rowOf(ui, "alpha");
  await expect(row.getByText(TITLE, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText("e2e", { exact: true })).toBeVisible();
  // on-workspace-opened is fire-and-forget: it lands after the open returned.
  await expect(row.getByText("via-ch", { exact: true })).toBeVisible({ timeout: 60_000 });
  // Local plugins run first, so the tag can show before the repository's plugin has run.
  await expect.poll(() => marker("alpha", MARK.event), { timeout: 60_000 }).toBe(true);
  await collapseSidebar(ui);
});

test("the open hook's environment is never written to the workspace file", () => {
  const content = readFileSync(join(workspacesDir(), "alpha.code-workspace"), "utf8");
  expect(content).not.toContain(ENV_VALUE);
});

test("ch plugin lists, disables and reports", async () => {
  await waitForConnectionDetails();
  const worktree = join(workspacesDir(), "alpha");

  const rows = json(ch(["plugin", "list"], worktree)) as { name: string; state: string }[];
  expect(rows.map((row) => [row.name, row.state])).toEqual([
    ["local:automations", "enabled"],
    ["local:broken", "enabled"],
    ["local:shells", "enabled"],
    ["workspace:extra", "enabled"],
    ["workspace:setup", "enabled"],
  ]);
  // Outside every workspace, only the user's own.
  const outside = json(ch(["plugin", "list"])) as { name: string }[];
  expect(outside.map((row) => row.name)).not.toContain("workspace:setup");

  expect(json(ch(["plugin", "disable", "workspace:extra"], worktree))).toMatchObject({
    state: "disabled",
  });

  const errors = json(ch(["plugin", "errors"])) as { plugin: string; message: string }[];
  expect(errors.find((row) => row.plugin === "local:broken")?.message).toMatch(
    /unknown key after-open/
  );

  const schema = json(ch(["plugin", "schema"])) as { properties: Record<string, unknown> };
  expect(Object.keys(schema.properties)).toEqual(
    expect.arrayContaining(["shell", "platform", "hooks", "automations"])
  );
});

test("a disabled plugin no longer runs, and nothing is asked again", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  await createWorkspace(app(), "beta");

  expect(marker("beta", MARK.bash)).toBe(true);
  expect(marker("beta", MARK.extra)).toBe(false);
  await expect(
    app().uiPage().getByRole("dialog", { name: "Run this repository's plugins?" })
  ).toBeHidden();
});

test("the deletion gate refuses, and Dismiss force-deletes past it", async () => {
  const ui = app().uiPage();
  await removeViaSidebar(ui, "alpha");

  await expect(rowOf(ui, "alpha").getByRole("img", { name: "Deletion failed" })).toBeVisible({
    timeout: 60_000,
  });
  expect(existsSync(join(workspacesDir(), "alpha"))).toBe(true);

  await expandSidebar(ui);
  await workspaceRow(ui, "alpha").click();
  const panel = ui.getByRole("region", { name: "Removing workspace" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(REFUSAL)).toBeVisible();
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();

  await expect(workspaceRow(ui, "alpha")).toBeHidden({ timeout: 120_000 });
  await expect
    .poll(() => existsSync(join(workspacesDir(), "alpha")), { timeout: 60_000 })
    .toBe(false);
});

test("Cancel on the loading panel stops a setup hook that never finishes", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();
  await commitRepoPlugins({ "setup.yaml": setupManifest({ hangSetup: true }) }, "Hang setup");

  const creating = createWorkspace(app(), "gamma");
  const running = ui.getByText("Running after-worktree-created (workspace:setup)", {
    exact: true,
  });
  await expect(running).toBeVisible({ timeout: 120_000 });
  await clickUntil(ui.getByRole("button", { name: "Cancel", exact: true }), () =>
    expect(running).toBeHidden({ timeout: 10_000 })
  );

  // A canceled setup hook is a failed one: loud, but the workspace still opens.
  await creating;
  await expandSidebar(ui);
  await expect(ui.getByText(/workspace:setup after-worktree-created: canceled/)).toBeVisible();
  await collapseSidebar(ui);

  // Every later workspace of this project would otherwise hang the same way.
  await commitRepoPlugins({ "setup.yaml": setupManifest() }, "Setup no longer hangs");
});

test("Cancel on the deletion panel stops a gate that never finishes, and fails it closed", async () => {
  const ui = app().uiPage();

  // An uncommitted edit in the worktree is what runs: plugins are read from the
  // workspace being deleted, as it stands.
  const worktree = join(workspacesDir(), "gamma");
  writeFileSync(join(worktree, ".codehydra", "plugins", "setup.yaml"), HANGING_GATE);
  await removeViaSidebar(ui, "gamma");

  await expect.poll(() => existsSync(join(worktree, MARK.gate)), { timeout: 60_000 }).toBe(true);

  await expandSidebar(ui);
  await workspaceRow(ui, "gamma").click();
  const panel = ui.getByRole("region", { name: "Removing workspace" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  await clickUntil(panel.getByRole("button", { name: "Cancel", exact: true }), () =>
    expect(retry).toBeVisible({ timeout: 10_000 })
  );

  await expect(
    panel.getByText(/before-worktree-deleted \(workspace:setup\) failed: canceled/)
  ).toBeVisible();
  expect(existsSync(worktree)).toBe(true);

  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(workspaceRow(ui, "gamma")).toBeHidden({ timeout: 120_000 });
});

// =============================================================================
// Automations
// =============================================================================

test("a workspaces automation creates a worktree and records it", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();

  writeArmed(wsArmed, [trackedItem("1", "tracked-1")]);

  await expect(workspaceRow(ui, "tracked-1")).toBeVisible({ timeout: CREATE_TIMEOUT });
  await expect
    .poll(() => existsSync(join(workspacesDir(), "tracked-1")), { timeout: CREATE_TIMEOUT })
    .toBe(true);
  await expect
    .poll(() => Object.keys(trackedEntries()), { timeout: 30_000 })
    .toContain("automations/tracked/1");
});

test("the tracked item disappearing keeps the entry while the workspace is there", async () => {
  rmSync(wsArmed, { force: true });

  await expect
    .poll(
      () =>
        appLogEntries().filter(
          (entry) =>
            entry.message === "Keeping automation entry (workspace still exists)" &&
            entry.context?.["key"] === "automations/tracked/1"
        ).length,
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  expect(Object.keys(trackedEntries())).toContain("automations/tracked/1");
  expect(existsSync(join(workspacesDir(), "tracked-1"))).toBe(true);
});

test("an events automation creates on the first event, and a repeat refreshes it", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();

  writeArmed(evArmed, [eventItem("ev-42", "review_requested")]);
  await expect(workspaceRow(ui, "ev-42")).toBeVisible({ timeout: CREATE_TIMEOUT });
  await waitForWorkspaceFrame(app(), "ev-42"); // focus: true — it takes the view

  await expandSidebar(ui);
  await expect(sidebarText(ui, "Event review_requested")).toBeVisible({ timeout: 60_000 });
  await expect(sidebarText(ui, "nudge")).toBeVisible();

  writeArmed(evArmed, [eventItem("ev-42", "commented")]);
  await expect(sidebarText(ui, "Event commented")).toBeVisible({ timeout: 60_000 });
  await expect(workspaceRow(ui, "ev-42")).toHaveCount(1);
  await collapseSidebar(ui);

  expect(
    Object.keys(trackedEntries()).filter((key) => key.startsWith("automations/events/"))
  ).toEqual([]);
});

test("an event wakes the hibernated workspace it matches", async () => {
  test.setTimeout(CREATE_TIMEOUT * 2);

  // Hibernation has no affordance a spec can drive (it is Alt+X then H, which
  // CDP input cannot reach), so write the flag the app writes and relaunch.
  spawnSync("git", ["config", "branch.ev-42.codehydra.hibernated", "true"], { cwd: repo.path });
  await app().stop();
  await launchApp(app(), { agent: test.info().project.name as Agent, extraArgs: launchFlags() });
  const ui = app().uiPage();
  await expect(hibernatedRow(ui, "ev-42")).toBeVisible({ timeout: CREATE_TIMEOUT });

  writeArmed(evArmed, [eventItem("ev-42", "nudged")]);

  await expect.poll(() => hibernatedFlag("ev-42"), { timeout: CREATE_TIMEOUT }).toBe("");
  await waitForWorkspaceFrame(app(), "ev-42");
  await expandSidebar(ui);
  await expect(sidebarText(ui, "Event nudged")).toBeVisible({ timeout: 60_000 });
  await collapseSidebar(ui);
});

test("an automation runs another action for each item", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  writeArmed(notifyArmed, [
    { action: "notification.show", title: "From an automation", type: "warning" },
  ]);

  await expect(ui.getByRole("status", { name: /^From an automation/ })).toBeVisible({
    timeout: 60_000,
  });
  await collapseSidebar(ui);
});

test("an automation pipes its raw items through ch plugin render", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  writeArmed(renderArmed, [{ n: 7 }]);

  await expect(ui.getByRole("status", { name: /^Rendered 7/ })).toBeVisible({ timeout: 60_000 });
  await collapseSidebar(ui);
});

test("an item the action does not accept is refused and reported", async () => {
  await waitForConnectionDetails();
  writeArmed(notifyArmed, [{ action: "notification.show", title: "x", typo: 1 }]);

  await expect
    .poll(
      () =>
        (json(ch(["plugin", "errors"])) as { entry: string; message: string }[]).find(
          (row) => row.entry === "automations.notify"
        )?.message ?? "",
      { timeout: 60_000 }
    )
    .toMatch(/item 0: notification\.show: unknown field typo/);
});

test("a failing automation is reported with its run log, never its output", async () => {
  await waitForConnectionDetails();
  let failing: { message: string; log: string } | undefined;
  await expect
    .poll(
      () => {
        const rows = json(ch(["plugin", "errors"])) as {
          plugin: string;
          entry: string;
          message: string;
          log: string;
        }[];
        failing = rows.find((row) => row.entry === "automations.failing");
        return failing?.message;
      },
      { timeout: 60_000 }
    )
    .toBe("exit 3");

  expect(failing!.log).not.toBe("");
  expect(readFileSync(failing!.log, "utf8")).toContain("token=e2e-secret went wrong");
  // The secret is in the run log only: not in the app log.
  expect(JSON.stringify(appLogEntries())).not.toContain("e2e-secret");
});

// =============================================================================
// Repository hooks from before plugins
// =============================================================================

test("a repository with old hooks is offered Migrate, which writes a plugin", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const legacy = await createTestGitRepo();
  try {
    const hooks = join(legacy.path, ".codehydra", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "after-worktree-created"), "#!/bin/sh\ncat > /dev/null\n");
    const git = simpleGit(legacy.path);
    await git.add(".codehydra");
    await git.commit("Old-style hooks");

    // The creation panel is not on screen while other workspaces are, so open
    // the second project, and its workspace, the way a shell would.
    expect(ch(["project", "open", legacy.path]).status).toBe(0);
    expect(ch(["ws", "create", "legacy-1", "--project", legacy.path]).status).toBe(0);
    expect(ch(["ws", "switch", "legacy-1", "--project", legacy.path]).status).toBe(0);
    await waitForWorkspaceFrame(app(), "legacy-1");

    // The sidekick shows an offer with a button as a modal dialog in the editor.
    // Look the frame up afresh each time: the workspace iframe can be replaced
    // while the editor starts.
    const migrate = async () =>
      (await app().findTarget("workspace")).frame.getByRole("button", { name: "Migrate" });
    await expect.poll(async () => (await migrate()).isVisible(), { timeout: 120_000 }).toBe(true);
    await (await migrate()).click();

    // Two projects are open now, so find this worktree by name.
    const projects = join(DATA_ROOT, "projects");
    const worktree = readdirSync(projects)
      .map((dir) => join(projects, dir, "workspaces", "legacy-1"))
      .find((path) => existsSync(path));
    expect(worktree).toBeDefined();
    const manifest = join(worktree!, ".codehydra", "plugins", "hooks.yaml");
    // Poll the content, not the file: an exclusive write creates it empty first.
    await expect
      .poll(() => (existsSync(manifest) ? readFileSync(manifest, "utf8") : ""), {
        timeout: 30_000,
      })
      .toContain("$CH_WORKSPACE_DIR/.codehydra/hooks/after-worktree-created");
  } finally {
    await legacy.cleanup();
  }
});
