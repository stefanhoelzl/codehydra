/**
 * Create, switch, delete — the intent dispatcher end-to-end against real git.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import {
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

  await createWorkspace(ui, "alpha");
  await createWorkspace(ui, "beta");

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
