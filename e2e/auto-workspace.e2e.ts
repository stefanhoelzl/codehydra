/**
 * Auto-workspace sources, both modes, against real git and a real spawned cmd.
 *
 * The source `cmd` is the one part of this feature that no integration test can
 * exercise: it is a user-authored command line handed to the platform shell.
 * Here it is a real process, spawned by the packaged app, whose stdout drives
 * everything downstream — so this spec covers the seam between ProcessRunner's
 * `shell: true` and the module's JSON contract on every OS the suite runs on.
 *
 * Both sources are configured at launch via a single `--auto-workspace.sources`
 * flag (parseCliArgs splits at the first `=`, so a multi-document YAML stream
 * rides in intact) and both point at the same emitter script. The spec controls
 * what each poll sees by writing that source's "armed" file:
 *
 *   workspaces mode — the file IS the desired list, so it persists across polls.
 *     Writing it makes the item appear; deleting it makes the item disappear.
 *   events mode — the emitter consumes the file, which is the ack. One write
 *     equals exactly one event, which is the module's dedup contract stated as
 *     a fixture.
 *
 * Neither source needs the project opened first: the templates carry `project`,
 * so the sources bootstrap it themselves.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import {
  DATA_ROOT,
  appLogEntries,
  expandSidebar,
  collapseSidebar,
  launchApp,
  useApp,
  waitForWorkspaceFrame,
  workspaceRow,
  workspacesDir,
} from "./fixtures";

/** Seconds between polls. The floor is 1; 2 keeps the log readable. */
const POLL_SECONDS = 2;
/** Generous: a poll has to land, then a worktree, IDE server and agent come up. */
const CREATE_TIMEOUT = 180_000;

let repo: { path: string; cleanup: () => Promise<void> };
let fixtureDir: string;
let wsArmed: string;
let evArmed: string;

/**
 * Emitter for both sources. `--consume` deletes the file after printing it,
 * which is how an events-mode cmd acks; without it the file is a standing
 * desired-state list. Missing file prints an empty array either way.
 *
 * CommonJS in a temp dir with no package.json, hence `.cjs` and `require`.
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

/**
 * Build the sources stream.
 *
 * Each path is quoted exactly once, by the layer that needs it. Inside the
 * command line, plain `"` around the raw path (no path here contains a quote);
 * then JSON.stringify for the YAML scalar, whose double-quoted style reads
 * backslashes as escapes and shares JSON's escaping rules. Stringifying twice
 * would quadruple every backslash in a Windows path and yield `D:\\a\\node.exe`
 * after parsing.
 */
function sourcesYaml(): string {
  const emitter = join(fixtureDir, "emit.cjs");
  const wsCmd = `"${process.execPath}" "${emitter}" "${wsArmed}"`;
  const evCmd = `"${process.execPath}" "${emitter}" "${evArmed}" --consume`;
  const project = JSON.stringify(repo.path);

  return `name: ws-src
type: cron
mode: workspaces
cmd: ${JSON.stringify(wsCmd)}
template:
  name: "{{ name }}"
  key: "{{ id }}"
  project: ${project}
  metadata:
    title: "Tracked {{ id }}"
---
name: ev-src
type: cron
mode: events
cmd: ${JSON.stringify(evCmd)}
template:
  name: "{{ name }}"
  project: ${project}
  focus: true
  metadata:
    title: "Event {{ reason }}"
    tags:
      nudge: { color: "#c47f2a" }
`;
}

/** The module's tracking map, or {} before anything has been persisted. */
function trackedEntries(): Record<string, { workspaceName: string }> {
  const path = join(DATA_ROOT, "state.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return (parsed["auto-workspaces"] ?? {}) as Record<string, { workspaceName: string }>;
}

/**
 * Write an armed file atomically.
 *
 * A poll runs every two seconds and reads whatever is there. A plain write is
 * not atomic, so a poll can catch a half-written file — and in events mode the
 * emitter would then consume it, printing truncated JSON. The module logs "not
 * valid JSON" and skips, the event is gone for good, and the spec hangs until
 * its timeout with no useful failure. Rename within the same directory is
 * atomic, so a poll sees either the old state or the new one.
 */
function writeArmed(path: string, items: unknown[]): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(items));
  renameSync(temp, path);
}

/** Fire one event by arming the events source's file. The emitter consumes it. */
function armEvent(name: string, reason: string): void {
  writeArmed(evArmed, [{ name, reason }]);
}

/** A hibernated row announces itself in its accessible name. */
function hibernatedRow(ui: Page, name: string): Locator {
  return ui.getByRole("button", { name: new RegExp(`^${name} in .*Hibernated`) });
}

/** Text inside the sidebar only — "nudge" is too generic to match page-wide. */
function sidebarText(ui: Page, text: string): Locator {
  return ui.locator("nav.sidebar").getByText(text);
}

/**
 * Read a workspace's `hibernated` metadata straight from git.
 *
 * Metadata lives in the project repo as branch config (git-worktree-provider's
 * setMetadata), so this is the same bit the app reads at discovery — not a
 * proxy for it.
 */
function hibernatedFlag(name: string): string {
  const result = spawnSync("git", ["config", "--get", `branch.${name}.codehydra.hibernated`], {
    cwd: repo.path,
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

/**
 * Hibernate a workspace by writing the flag the app itself writes, then
 * relaunching so startup discovery picks it up.
 *
 * The UI route is Alt+X then H, and it cannot be driven from here: Electron
 * emits `before-input-event` from the browser process's input router, while
 * Playwright's CDP `Input.dispatchKeyEvent` injects at the renderer widget and
 * never passes through it. Verified, not assumed — with debug logging on, four
 * synthetic key events produced zero `Alt keyUp detected` entries and no
 * `ui:set-shortcut-active` intent, while the module's listener was registered.
 * Hibernation has no other affordance (the sidebar row offers only Remove), so
 * do not "fix" this by reaching for the keyboard again.
 *
 * What this leaves behind is the real thing: the same branch config a real
 * hibernate writes, and a workspace the next launch discovers as hibernated and
 * declines to open. The wake that follows is entirely the app's own.
 */
async function hibernateByRestart(name: string): Promise<void> {
  spawnSync("git", ["config", `branch.${name}.codehydra.hibernated`, "true"], { cwd: repo.path });
  expect(hibernatedFlag(name)).toBe("true");

  await app().stop();
  await launchApp(app(), { agent: currentAgent(), extraArgs: sourceFlags() });
}

/** The agent project this spec is running under, for a relaunch. */
function currentAgent(): Agent {
  return test.info().project.name as Agent;
}

test.beforeAll(async () => {
  repo = await createTestGitRepo();
  fixtureDir = mkdtempSync(join(tmpdir(), "ch-e2e-auto-"));
  wsArmed = join(fixtureDir, "workspaces.json");
  evArmed = join(fixtureDir, "events.json");
  writeFileSync(join(fixtureDir, "emit.cjs"), EMITTER);
  writeFileSync(join(fixtureDir, "sources.yaml"), sourcesYaml());
});

/**
 * The flags that configure both sources. Shared by the launch and the relaunch.
 *
 * The sources go in by `@path`, not inline. A multi-document YAML stream cannot
 * cross a command line on Windows — arguments are delimited on whitespace, so
 * only the first line arrives and the app rejects the fragment and refuses to
 * start. This spec is where that regressed once; keep it a file reference.
 */
function sourceFlags(): string[] {
  return [
    `--auto-workspace.poll-interval=${POLL_SECONDS}`,
    `--auto-workspace.sources=@${join(fixtureDir, "sources.yaml")}`,
  ];
}

// The flags are a thunk because they name the temp paths created above: hooks run
// in declaration order, so that beforeAll has run by the time useApp's launches —
// but `useApp()` itself is called now, when the paths are still undefined.
const app = useApp({ extraArgs: sourceFlags });

test.afterAll(async () => {
  await repo?.cleanup();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

// One story, told in order: each test leaves state the next one relies on.
test.describe.configure({ mode: "serial" });

test("a workspaces source creates a worktree and records it", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();

  writeArmed(wsArmed, [{ id: "1", name: "tracked-1" }]);

  await expect(workspaceRow(ui, "tracked-1")).toBeVisible({ timeout: CREATE_TIMEOUT });
  // Poll, don't assert: the row matches the *creating* placeholder too, which is
  // emitted before the worktree exists. On a slow runner the directory lands
  // after the row does.
  await expect
    .poll(() => existsSync(join(workspacesDir(), "tracked-1")), { timeout: CREATE_TIMEOUT })
    .toBe(true);

  // The state entry is what makes the next poll skip it rather than collide.
  await expect.poll(() => Object.keys(trackedEntries()), { timeout: 30_000 }).toContain("ws-src/1");
  expect(trackedEntries()["ws-src/1"]?.workspaceName).toBe("tracked-1");
});

test("the tracked item disappearing forgets the entry but keeps the workspace", async () => {
  const ui = app().uiPage();

  rmSync(wsArmed, { force: true }); // the source no longer lists it

  await expect
    .poll(() => Object.keys(trackedEntries()), { timeout: 30_000 })
    .not.toContain("ws-src/1");
  // There is no auto-deletion: the worktree and its row outlive the item.
  expect(existsSync(join(workspacesDir(), "tracked-1"))).toBe(true);
  await expect(workspaceRow(ui, "tracked-1")).toBeVisible();
});

test("an events source creates on the first event, writing no state", async () => {
  test.setTimeout(CREATE_TIMEOUT + 60_000);
  const ui = app().uiPage();

  armEvent("ev-42", "review_requested");

  await expect(workspaceRow(ui, "ev-42")).toBeVisible({ timeout: CREATE_TIMEOUT });
  await expect
    .poll(() => existsSync(join(workspacesDir(), "ev-42")), { timeout: CREATE_TIMEOUT })
    .toBe(true);
  await waitForWorkspaceFrame(app(), "ev-42"); // focus: true — it takes the view

  await expandSidebar(ui);
  await expect(sidebarText(ui, "Event review_requested")).toBeVisible();
  await expect(sidebarText(ui, "nudge")).toBeVisible();
  await collapseSidebar(ui);

  // An events source tracks nothing — the cmd owns dedup.
  expect(Object.keys(trackedEntries()).filter((k) => k.startsWith("ev-src/"))).toEqual([]);
});

test("a repeat event refreshes metadata instead of creating a second workspace", async () => {
  const ui = app().uiPage();

  armEvent("ev-42", "commented");

  await expandSidebar(ui);
  await expect(sidebarText(ui, "Event commented")).toBeVisible({ timeout: 60_000 });
  await expect(sidebarText(ui, "Event review_requested")).toBeHidden();
  await collapseSidebar(ui);

  // Still exactly one row for it, and still one worktree.
  await expect(workspaceRow(ui, "ev-42")).toHaveCount(1);
  expect(Object.keys(trackedEntries()).filter((k) => k.startsWith("ev-src/"))).toEqual([]);
});

test("an event wakes the hibernated workspace it matches", async () => {
  test.setTimeout(CREATE_TIMEOUT * 2);

  await hibernateByRestart("ev-42");
  const ui = app().uiPage();

  // Startup discovery declines to open a hibernated workspace, so the row is
  // there but dormant — the state an event has to act on.
  await expect(hibernatedRow(ui, "ev-42")).toBeVisible({ timeout: CREATE_TIMEOUT });

  armEvent("ev-42", "nudged");

  // The wake clears the flag in git, which is the app's own record of it.
  await expect.poll(() => hibernatedFlag("ev-42"), { timeout: CREATE_TIMEOUT }).toBe("");
  await expect(hibernatedRow(ui, "ev-42")).toBeHidden({ timeout: CREATE_TIMEOUT });
  // `focus: true` in the template: waking takes the view back.
  await waitForWorkspaceFrame(app(), "ev-42");

  await expandSidebar(ui);
  await expect(sidebarText(ui, "Event nudged")).toBeVisible({ timeout: 60_000 });
  await collapseSidebar(ui);

  // A wake, not a second creation — and the module says so itself. Asserted from
  // the log because "woke it" and "recreated it" look identical from outside.
  const woke = appLogEntries().filter(
    (entry) =>
      entry.message === "Auto-workspace event applied" && entry.context?.["action"] === "wake"
  );
  expect(woke.length, "no events-mode wake was logged").toBeGreaterThan(0);
  await expect(workspaceRow(ui, "ev-42")).toHaveCount(1);
});
