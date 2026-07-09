/**
 * Open a real git repo as a project, create a workspace, and see VSCodium load in it.
 *
 * This is the "does the product work" spec: it exercises worktree creation, the IDE
 * server boot, the agent server start, and the iframe wiring — against a packaged
 * binary, on the platform it ships to.
 *
 * One test, because the creation panel's project selection does not survive a test
 * boundary: opening and creating are one user gesture, not two.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import {
  baseBranchField,
  createWorkspace,
  openProject,
  projectNamePattern,
  useApp,
  waitForWorkspaceFrame,
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

test("open a folder, create a workspace, and VSCodium loads in its worktree", async () => {
  const ui = app().uiPage();
  await openProject(app(), repo.path);

  // --- The project is registered ---
  const projectName = repo.path.split(/[/\\]/).pop()!;
  await expect(ui.getByRole("navigation", { name: "Projects" })).toContainText(
    projectNamePattern(projectName)
  );
  // The base branch is discovered from the repo, not typed by the user.
  await expect(baseBranchField(ui)).toHaveValue("main");

  // --- The workspace is created ---
  await createWorkspace(ui, "solo");
  await expect(workspaceRow(ui, "solo")).toBeVisible();

  // The worktree exists on disk, alongside the .code-workspace file the IDE opens.
  // Poll: the sidebar row can render before git has finished writing the worktree.
  const dir = workspacesDir();
  await expect.poll(() => existsSync(join(dir, "solo")), { timeout: 60_000 }).toBe(true);
  await expect
    .poll(() => existsSync(join(dir, "solo.code-workspace")), { timeout: 60_000 })
    .toBe(true);

  // --- The IDE actually mounted ---
  // The iframe attaches after the sidebar row renders.
  await waitForWorkspaceFrame(app(), "solo");
  const { frame, isWorkspaceFrame } = await app().findTarget("workspace");
  expect(isWorkspaceFrame).toBe(true);
  expect(frame.url()).toContain("127.0.0.1");
  expect(frame.url()).toContain("solo.code-workspace");

  // VSCodium finished loading inside the iframe — not just an empty frame.
  await expect(frame.locator(".monaco-workbench")).toBeVisible({ timeout: 120_000 });
});
