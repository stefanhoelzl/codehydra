/**
 * A repository whose worktrees CodeHydra did not create.
 *
 * The reported bug: an agent running inside a workspace creates git worktrees of
 * the same repo as scratch space (Claude's `isolation: "worktree"` does exactly
 * this), and every one of them came back as a workspace tab on the next start.
 * Discovery had no notion of ownership — any non-main worktree became a tab.
 *
 * This is the end-to-end statement of the fix, against the packaged binary and
 * real git: a stray worktree never becomes a tab, and the only way one does is
 * the user ticking it in the picker shown while adding the project.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import { launchApp, nameField, useApp, workspaceRow, workspacesDir } from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
/** Holds the stray worktrees, outside both the repo and CodeHydra's data dir. */
let strayDir: string;

/** The agent project this spec is running under, for a relaunch. */
function currentAgent(): Agent {
  return test.info().project.name as Agent;
}

/** Run git in the fixture repo, failing loudly — a bad fixture must not read as a pass. */
function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo.path, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

test.beforeAll(async () => {
  repo = await createTestGitRepo();
  strayDir = mkdtempSync(join(tmpdir(), "ch-stray-"));

  // What an agent leaves behind: a worktree on a detached HEAD.
  git("worktree", "add", "--detach", join(strayDir, "agent-scratch"));
  // What a user makes by hand: a worktree on a branch, in a directory they named.
  git("worktree", "add", "-b", "feature/login", join(strayDir, "repo-login"));
});

test.afterAll(async () => {
  await repo?.cleanup();
  if (strayDir) rmSync(strayDir, { recursive: true, force: true });
});

test("stray worktrees stay out of the sidebar unless adopted in the picker", async () => {
  const ui = app().uiPage();

  await app().mockDialog([repo.path]);
  await ui.getByRole("button", { name: "Open project folder" }).click();

  // --- The picker offers what CodeHydra would otherwise have opened blindly ---
  await expect(ui.getByText("Open existing worktrees?")).toBeVisible({ timeout: 60_000 });

  // One row per worktree, each a single checkbox labelled with the name the
  // workspace would take plus where it lives. `vscode-checkbox` reflects its
  // label into aria-label, and row order follows git's worktree list, so rows are
  // located by that label rather than by index.
  const adoptable = ui.locator('vscode-checkbox[aria-label^="repo-login"]');
  const detached = ui.locator('vscode-checkbox[aria-label^="agent-scratch"]');

  await expect(adoptable).toHaveAttribute("aria-label", /repo-login .*repo-login$/);
  await expect(adoptable).not.toHaveAttribute("disabled", "");
  // The agent's detached worktree is listed but cannot be adopted: the marker is
  // stored per branch, and it has none.
  await expect(detached).toHaveAttribute("aria-label", /detached HEAD, cannot be adopted$/);
  await expect(detached).toHaveAttribute("disabled", "");

  // --- Continue without ticking anything ---
  await ui.getByRole("button", { name: "Continue" }).click();
  await expect(nameField(ui)).toBeEnabled({ timeout: 60_000 });

  // Neither stray worktree became a tab, and CodeHydra created no worktree of its
  // own for them: its workspaces dir stays empty.
  await expect(workspaceRow(ui, "repo-login")).toHaveCount(0);
  await expect(workspaceRow(ui, "agent-scratch")).toHaveCount(0);
  await expect(workspaceRow(ui, "feature/login")).toHaveCount(0);
  expect(existsSync(join(workspacesDir(), "repo-login"))).toBe(false);

  // The stray worktrees are untouched on disk — CodeHydra ignored them, it did not
  // clean them up.
  expect(existsSync(join(strayDir, "repo-login"))).toBe(true);
  expect(existsSync(join(strayDir, "agent-scratch"))).toBe(true);

  // --- And they stay out across a restart, which is where the bug was reported ---
  // The picker only runs when the user adds a project; a restart re-opens the saved
  // one, and discovery alone has to hold the line.
  await app().stop();
  await launchApp(app(), { agent: currentAgent() });

  const restarted = app().uiPage();
  await expect(restarted.getByRole("button", { name: "New workspace" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(restarted.getByText("Open existing worktrees?")).toHaveCount(0);
  await expect(workspaceRow(restarted, "repo-login")).toHaveCount(0);
  await expect(workspaceRow(restarted, "agent-scratch")).toHaveCount(0);
});
