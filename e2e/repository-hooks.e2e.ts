/**
 * A repository's own hooks, end to end against the packaged app.
 *
 * This is the chain the integration tests deliberately stop short of: a hook
 * committed in a real repository, checked out into a real worktree, spawned
 * through the real platform shell, with what it returns reaching the app.
 *
 * The story is one workspace, in order: trust is asked, the setup hook's
 * title/tags land, the open hook's environment stays out of every file, the
 * deletion hook refuses, and Dismiss escapes the refusal — which is the
 * documented way out of a gate that says no. Then a second workspace meets
 * hooks that never finish, and Cancel is the way out of each: the setup hook
 * on the loading panel, the deletion gate on the deletion panel.
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
const EVENT_MARKER = ".on-workspace-opened-ran";
const OPEN_MARKER = ".before-workspace-opened-ran";

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

/** A hook that swallows stdin, touches `marker` in its worktree and prints `json`. */
function markAndPrintScript(marker: string, json: string): string {
  return isWindows
    ? ["@echo off", "more > nul", `type nul > ${marker}`, `echo ${json}`, ""].join("\r\n")
    : ["#!/bin/sh", "cat > /dev/null", `touch ${marker}`, `echo '${json}'`, ""].join("\n");
}

/**
 * A hook that swallows stdin and then never finishes on its own (ten minutes is
 * far past every timeout here). Cancel is the only thing that ends it.
 */
function hangingScript(): string {
  return isWindows
    ? ["@echo off", "more > nul", "ping -n 600 127.0.0.1 > nul", ""].join("\r\n")
    : ["#!/bin/sh", "cat > /dev/null", "sleep 600", ""].join("\n");
}

/** A hook that swallows stdin and touches a file in the worktree it runs in. */
function markerScript(marker: string): string {
  return isWindows
    ? ["@echo off", "more > nul", `type nul > ${marker}`, ""].join("\r\n")
    : ["#!/bin/sh", "cat > /dev/null", `touch ${marker}`, ""].join("\n");
}

async function writeHookScript(name: string, body: string, root = repo.path): Promise<void> {
  const dir = join(root, ".codehydra", "hooks");
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
      title: TITLE,
      tags: { e2e: { color: "#3498db", description: "created by a repository hook" } },
    })
  );
  await writeHookScript(
    "before-workspace-opened",
    markAndPrintScript(OPEN_MARKER, JSON.stringify({ env: { [ENV_NAME]: ENV_VALUE } }))
  );
  await writeHook("before-worktree-deleted", JSON.stringify({ blocked: true, reason: REFUSAL }));

  // Same directory as the blocking entries: the `on-` prefix is what makes this
  // one fire-and-forget, not where it lives.
  await writeHookScript("on-workspace-opened", markerScript(EVENT_MARKER));

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

test("the open hook's environment is never written to the workspace file", async () => {
  // Delivered in memory (to the agent and the editor's terminals) and supplied
  // afresh on every open, so it has no reason to be on disk — and a repository's
  // values in a file next to the worktree is exactly what must not happen.
  // It ran — blocking, so before the open returned — and returned its env.
  expect(existsSync(join(workspacesDir(), "alpha", OPEN_MARKER))).toBe(true);

  const file = join(workspacesDir(), "alpha.code-workspace");
  expect(existsSync(file)).toBe(true);

  const content = readFileSync(file, "utf8");
  expect(content).not.toContain(ENV_VALUE);
  expect(content).not.toContain("claudeCode.environmentVariables");
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

  // A second workspace, so the project still has one when `alpha` goes away.
  // Deleting the *only* workspace deactivates the project, and the creation
  // panel — which is the ground state when nothing is active — then renders
  // above the sidebar and swallows clicks on the rows beneath it. That is real
  // app behaviour, not a test artifact, and having a survivor is also the
  // ordinary case: nobody runs CodeHydra with exactly one workspace.
  await createWorkspace(app(), "beta");

  await expandSidebar(ui);

  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, "alpha") })
    .last();
  await row.getByRole("button", { name: "Remove workspace" }).click();

  const confirm = ui.getByRole("dialog", { name: "Remove Workspace" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();

  // Trust was answered Always, so the hook just runs — no second question, for
  // `beta`'s creation either: trust is per project, not per workspace.
  // The row is the durable evidence. The progress panel is only on screen while
  // the workspace being deleted is the one you are looking at, and `beta` has
  // the screen by now.
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
  // a user reaches Retry and Dismiss after switching away. This click is why the
  // previous test created `beta`: with `alpha` the only workspace, the creation
  // panel covers the sidebar and intercepts it (on macOS and Windows, where the
  // panel's own label overlaps the row — Linux's layout happens not to).
  await workspaceRow(ui, "alpha").click();

  const panel = ui.getByRole("region", { name: "Removing workspace" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(REFUSAL)).toBeVisible();

  // Force-delete: the documented way past a gate that says no. Hooks are skipped
  // entirely on this path, so the same refusing hook cannot block it again.
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();

  await expect(workspaceRow(ui, "alpha")).toBeHidden({ timeout: 120_000 });
  // The survivor is untouched — a force-delete takes one workspace, not the project.
  await expect(workspaceRow(ui, "beta")).toBeVisible();
  await expect
    .poll(() => existsSync(join(workspacesDir(), "alpha")), { timeout: 60_000 })
    .toBe(false);
});

test("Cancel on the loading panel stops a setup hook that never finishes", async () => {
  const ui = app().uiPage();

  // Committed, because a new worktree only has the hooks of the branch it is
  // created from.
  await writeHookScript("after-worktree-created", hangingScript());
  const git = simpleGit(repo.path);
  await git.add(".codehydra");
  await git.commit("Make the setup hook hang");

  // Settles only once the workspace has opened, which the hook is holding up.
  const creating = createWorkspace(app(), "gamma");

  await expect(ui.getByText("Running after-worktree-created", { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  // `<vscode-button>` can swallow a click on Windows (see `removeWorkspace`), so
  // click until the hook's row is gone — the only evidence the click landed.
  const cancel = ui.getByRole("button", { name: "Cancel", exact: true });
  for (let attempt = 1; ; attempt++) {
    await cancel.click();
    try {
      await expect(ui.getByText("Running after-worktree-created", { exact: true })).toBeHidden({
        timeout: 10_000,
      });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  // A canceled setup hook is a failed one: loud, but the workspace still opens.
  await creating;
  await expandSidebar(ui);
  await expect(ui.getByText("after-worktree-created was canceled")).toBeVisible();
});

test("Cancel on the deletion panel stops a gate that never finishes, and fails it closed", async () => {
  const ui = app().uiPage();

  // An uncommitted edit in the worktree is what runs: the gate is read from the
  // workspace being deleted, as it stands.
  const worktree = join(workspacesDir(), "gamma");
  await writeHookScript("before-worktree-deleted", hangingScript(), worktree);

  await expandSidebar(ui);
  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, "gamma") })
    .last();
  await row.getByRole("button", { name: "Remove workspace" }).click();
  const confirm = ui.getByRole("dialog", { name: "Remove Workspace" });
  await expect(confirm).toBeVisible();
  // Click until the dialog closes: `<vscode-button>` can swallow a click, and
  // with the dialog still up the sidebar below cannot be reached.
  const remove = confirm.getByRole("button", { name: "Remove", exact: true });
  for (let attempt = 1; ; attempt++) {
    await remove.click();
    try {
      await expect(confirm).toBeHidden({ timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  // The deletion switches away from `gamma`; selecting it brings its panel back.
  await expandSidebar(ui);
  await workspaceRow(ui, "gamma").click();
  const panel = ui.getByRole("region", { name: "Removing workspace" });
  await expect(panel).toBeVisible({ timeout: 60_000 });

  const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeVisible({ timeout: 60_000 });
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  for (let attempt = 1; ; attempt++) {
    await cancel.click();
    try {
      await expect(retry).toBeVisible({ timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  // Canceled is a hook failure, and the gate fails closed: the worktree stays.
  await expect(panel.getByText("before-worktree-deleted was canceled")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  expect(existsSync(worktree)).toBe(true);

  // Leave the project as the earlier tests did: Dismiss force-deletes, hooks skipped.
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(workspaceRow(ui, "gamma")).toBeHidden({ timeout: 120_000 });
});
