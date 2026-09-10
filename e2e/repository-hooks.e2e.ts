/**
 * A repository's own hooks, end to end against the packaged app.
 *
 * This is the chain the integration tests deliberately stop short of: a hook
 * committed in a real repository, checked out into a real worktree, spawned
 * through the real platform shell, with what it returns reaching the
 * `.code-workspace` file the agent and the editor's terminals actually read.
 *
 * The story is one workspace, in order: trust is asked, the setup hook's
 * environment/title/tags land, the deletion hook refuses, and Dismiss escapes
 * the refusal — which is the documented way out of a gate that says no.
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import {
  createWorkspace,
  expandSidebar,
  openProject,
  useApp,
  workspaceRow,
  workspacesDir,
} from "./fixtures";

const app = useApp();
const isWindows = process.platform === "win32";

/** Windows cannot run an extensionless file, so the hook is named for the platform. */
const HOOK_EXT = isWindows ? ".cmd" : "";

const ENV_NAME = "CH_HOOK_E2E";
const ENV_VALUE = "hooked";
const TITLE = "Hooked Alpha";
const REFUSAL = "e2e gate says no";
const EVENT_MARKER = ".on-workspace-created-ran";

let repo: { path: string; cleanup: () => Promise<void> };

/**
 * A hook that swallows stdin and prints `json`.
 *
 * Reading stdin matters: CodeHydra writes the input and closes the pipe, and a
 * script that never drains it is the shape most likely to surprise someone.
 */
function hookScript(json: string): string {
  return isWindows
    ? ["@echo off", "more > nul", `echo ${json}`, ""].join("\r\n")
    : ["#!/bin/sh", "cat > /dev/null", `echo '${json}'`, ""].join("\n");
}

/** A hook that swallows stdin and touches a file in the worktree it runs in. */
function markerScript(marker: string): string {
  return isWindows
    ? ["@echo off", "more > nul", `type nul > ${marker}`, ""].join("\r\n")
    : ["#!/bin/sh", "cat > /dev/null", `touch ${marker}`, ""].join("\n");
}

async function writeHookScript(name: string, body: string): Promise<void> {
  const dir = join(repo.path, ".codehydra", "hooks");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}${HOOK_EXT}`);
  await writeFile(file, body);
  if (!isWindows) await chmod(file, 0o755);
}

async function writeHook(name: string, json: string): Promise<void> {
  await writeHookScript(name, hookScript(json));
}

test.beforeAll(async () => {
  repo = await createTestGitRepo();

  await writeHook(
    "after-worktree-created",
    JSON.stringify({
      env: { [ENV_NAME]: ENV_VALUE },
      title: TITLE,
      tags: { e2e: { color: "#3498db", description: "created by a repository hook" } },
    })
  );
  await writeHook("before-worktree-deleted", JSON.stringify({ blocked: true, reason: REFUSAL }));

  // Same directory as the two blocking entries: the `on-` prefix is what makes
  // this one fire-and-forget, not where it lives.
  await writeHookScript("on-workspace-created", markerScript(EVENT_MARKER));

  // Hooks are read from the *worktree*, so they only exist in a new workspace if
  // they are committed on the branch it is created from.
  const git = simpleGit(repo.path);
  await git.add(".codehydra");
  await git.commit("Add CodeHydra hooks");
});

test.afterAll(async () => {
  await repo?.cleanup();
});

// One workspace, one story.
test.describe.configure({ mode: "serial" });

test("asks whether to trust the repository, then runs its setup hook", async () => {
  const ui = app().uiPage();
  await openProject(app(), repo.path);

  // Creation parks on the trust dialog partway through, so it cannot be awaited
  // before the question is answered.
  const creating = createWorkspace(app(), "alpha");

  const dialog = ui.getByRole("dialog", { name: "Run repository hooks?" });
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByText(".codehydra/hooks/after-worktree-created")).toBeVisible();
  await dialog.getByRole("button", { name: "Always", exact: true }).click();

  await creating;
});

test("the hook's environment reaches the file the agent reads", async () => {
  const file = join(workspacesDir(), "alpha.code-workspace");
  expect(existsSync(file)).toBe(true);

  const content = JSON.parse(readFileSync(file, "utf8")) as {
    settings: { "claudeCode.environmentVariables": { name: string; value: string }[] };
  };

  expect(content.settings["claudeCode.environmentVariables"]).toContainEqual({
    name: ENV_NAME,
    value: ENV_VALUE,
  });
});

test("the hook's title and tag reach the sidebar", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  // The row keeps the branch as its accessible name — the title is what it
  // *shows*, and the branch stays the identity everywhere else.
  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, "alpha") })
    .last();

  await expect(row.getByText(TITLE, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText("e2e", { exact: true })).toBeVisible();
});

test("the on- entry fires from the same directory, without being waited for", async () => {
  // Fire-and-forget, so it lands after the open has already returned — and it
  // never raised a trust dialog of its own, because Always was answered for the
  // project, not for one entry.
  await expect
    .poll(() => existsSync(join(workspacesDir(), "alpha", EVENT_MARKER)), { timeout: 60_000 })
    .toBe(true);
});

test("the deletion hook refuses, and the worktree survives", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, "alpha") })
    .last();
  await row.getByRole("button", { name: "Remove workspace" }).click();

  const confirm = ui.getByRole("dialog", { name: "Remove Workspace" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();

  // Trust was answered Always, so the hook just runs — no second question.
  // The row is the durable evidence: the progress panel is only on screen while
  // the workspace being deleted is the one you are looking at, and deleting the
  // last workspace switches away from it.
  await expect(row.getByRole("img", { name: "Deletion failed" })).toBeVisible({
    timeout: 60_000,
  });

  // Refused before `git worktree remove`: the worktree is still on disk.
  expect(existsSync(join(workspacesDir(), "alpha"))).toBe(true);
});

test("Dismiss force-deletes past the refusing hook", async () => {
  const ui = app().uiPage();
  await expandSidebar(ui);

  // Selecting the failed workspace brings its deletion panel back — which is how
  // a user reaches Retry and Dismiss after switching away.
  await workspaceRow(ui, "alpha").click();

  const panel = ui.getByRole("region", { name: "Removing workspace" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(REFUSAL)).toBeVisible();

  // Force-delete: the documented way past a gate that says no. Hooks are skipped
  // entirely on this path, so the same refusing hook cannot block it again.
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();

  await expect(workspaceRow(ui, "alpha")).toBeHidden({ timeout: 120_000 });
  await expect
    .poll(() => existsSync(join(workspacesDir(), "alpha")), { timeout: 60_000 })
    .toBe(false);
});
