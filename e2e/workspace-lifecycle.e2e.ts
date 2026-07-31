/**
 * Create, switch, delete — the intent dispatcher end-to-end against real git.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import {
  appLogEntries,
  createWorkspace,
  expandSidebar,
  openProject,
  removeWorkspace,
  useApp,
  workspaceRow,
  workspacesDir,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

// The workspaces accumulate across these tests on purpose: they are one story.
test.describe.configure({ mode: "serial" });

test("two workspaces coexist, each with its own worktree", async () => {
  const ui = app().uiPage();
  await openProject(app(), repo.path);

  await createWorkspace(app(), "alpha");
  await createWorkspace(app(), "beta");

  await expect(workspaceRow(ui, "alpha")).toBeVisible();
  await expect(workspaceRow(ui, "beta")).toBeVisible();

  const dir = workspacesDir();
  await expect.poll(() => existsSync(join(dir, "alpha")), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => existsSync(join(dir, "beta")), { timeout: 60_000 }).toBe(true);
});

test("switching workspaces swaps the active iframe", async () => {
  const ui = app().uiPage();
  const activeUrl = async (): Promise<string> => (await app().findTarget("workspace")).frame.url();

  // `beta` was created last, so it becomes the active one — but activation lands
  // after the sidebar row does, so poll rather than assume.
  await expect.poll(activeUrl, { timeout: 60_000 }).toContain("beta.code-workspace");

  await expandSidebar(ui);
  await workspaceRow(ui, "alpha").click();

  await expect.poll(activeUrl, { timeout: 60_000 }).toContain("alpha.code-workspace");
});

test("removing a workspace deletes its git worktree", async () => {
  const ui = app().uiPage();
  const dir = workspacesDir();

  await removeWorkspace(ui, "beta");

  await expect(workspaceRow(ui, "alpha")).toBeVisible();
  await expect.poll(() => existsSync(join(dir, "beta")), { timeout: 60_000 }).toBe(false);
  expect(existsSync(join(dir, "beta.code-workspace"))).toBe(false);
  // The survivor is untouched.
  expect(existsSync(join(dir, "alpha"))).toBe(true);
});

test("teardown stops the agent before releasing its IDE frame", async () => {
  // Regression guard for a deletion that failed on Windows with the worktree
  // locked. The frame was released on the first deletion-progress event, which
  // is emitted BEFORE the shutdown hook point runs — so the iframe went away,
  // the IDE client disconnected, the extension host was disposed, and the
  // "terminal closed" that came out of that was read as "the agent exited".
  // It had not: it kept running with the workspace as its CWD, and Windows
  // refused to remove the directory.
  //
  // Asserted from the dispatcher's own log rather than the UI, because the
  // ordering is the behaviour under test and it is invisible from outside. The
  // visible symptom only reproduces on Windows; this ordering is wrong on every
  // platform, so pin the ordering.
  const shutdownHooks = appLogEntries().filter(
    (entry) =>
      entry.message === "hook" &&
      entry.context?.["op"] === "delete-workspace" &&
      entry.context?.["hook"] === "shutdown"
  );

  expect(
    shutdownHooks.length,
    "no delete-workspace shutdown hook ran — the earlier removal test should have produced one"
  ).toBeGreaterThan(0);

  for (const entry of shutdownHooks) {
    // `modules` is the run order across capability waves, so this reads the
    // actual sequence rather than mere registration.
    const ran = String(entry.context?.["modules"] ?? "").split(",");
    const stopsAgent = ran.indexOf("plugin-server");
    const releasesFrame = ran.indexOf("presentation");

    expect(
      stopsAgent,
      `plugin-server did not run in the shutdown hook: ${ran.join(",")}`
    ).toBeGreaterThanOrEqual(0);
    expect(
      releasesFrame,
      `presentation did not run in the shutdown hook: ${ran.join(",")}. Its handler is what ` +
        `releases the IDE frame; if it is missing, the frame is being released somewhere ` +
        `ungated again.`
    ).toBeGreaterThanOrEqual(0);
    expect(
      releasesFrame,
      `the IDE frame was released before the agent was stopped (order: ${ran.join(",")})`
    ).toBeGreaterThan(stopsAgent);
  }
});
