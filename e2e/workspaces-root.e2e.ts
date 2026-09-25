/**
 * Moving the workspaces root (`paths.workspaces`, e.g. onto a Windows Dev Drive).
 *
 * A full migration between two regular folders, against the packaged binary and
 * real git: a workspace created under the default root survives the move in
 * place, the next one is created under the new root, and the start after that
 * asks nothing.
 */
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import {
  createWorkspace,
  launchApp,
  openProject,
  useApp,
  workspaceRow,
  workspacesDir,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
/** The new root: a fresh, empty folder outside the data root. */
let newRoot: string;

/** The agent project this spec is running under, for a relaunch. */
function currentAgent(): Agent {
  return test.info().project.name as Agent;
}

function rootFlag(): string[] {
  return [`--paths.workspaces=${newRoot}`];
}

test.beforeAll(async () => {
  repo = await createTestGitRepo();
  // mkdtemp creates it; the migration needs it empty, which it is.
  newRoot = mkdtempSync(join(tmpdir(), "ch-e2e-root-"));
});

test.afterAll(async () => {
  await repo?.cleanup();
  if (newRoot) rmSync(newRoot, { recursive: true, force: true });
});

test("migrating keeps existing workspaces in place and creates new ones in the new folder", async () => {
  // --- Under the default root ---
  await openProject(app(), repo.path);
  await createWorkspace(app(), "alpha");
  const oldAlpha = join(workspacesDir(), "alpha");
  expect(existsSync(oldAlpha)).toBe(true);

  // --- Next start with the setting changed: the choice on the starting screen ---
  await app().stop();
  await launchApp(app(), { agent: currentAgent(), extraArgs: rootFlag() });
  const ui = app().uiPage();
  await expect(ui.getByText("The workspaces folder changed")).toBeVisible({ timeout: 60_000 });
  const migrate = ui.getByRole("button", { name: "Migrate" });
  await expect(migrate).not.toHaveAttribute("disabled", /.*/);
  await migrate.click();

  // The existing workspace is still there, where it was.
  await expect(workspaceRow(ui, "alpha")).toBeVisible({ timeout: 120_000 });
  expect(existsSync(oldAlpha)).toBe(true);

  // A new one goes to the new root.
  await createWorkspace(app(), "beta");
  const projects = join(newRoot, "projects");
  await expect.poll(() => existsSync(projects), { timeout: 60_000 }).toBe(true);
  const [projectDir] = readdirSync(projects);
  expect(existsSync(join(projects, projectDir!, "workspaces", "beta"))).toBe(true);

  // --- The start after that asks nothing and lists both ---
  await app().stop();
  await launchApp(app(), { agent: currentAgent(), extraArgs: rootFlag() });
  const restarted = app().uiPage();
  await expect(workspaceRow(restarted, "alpha")).toBeVisible({ timeout: 120_000 });
  await expect(workspaceRow(restarted, "beta")).toBeVisible();
  await expect(restarted.getByText("The workspaces folder changed")).toHaveCount(0);
});
