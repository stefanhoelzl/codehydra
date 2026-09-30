/**
 * Moving the workspaces root (`paths.workspaces`, e.g. onto a Windows Dev Drive).
 *
 * The Change dialog behind the settings row, then a full migration between two
 * regular folders, against the packaged binary and real git: a workspace created
 * under the default root survives the move in place, the next one is created
 * under the new root, and the start after that asks nothing.
 *
 * "Migrate and restart" relaunches the app, which a spec cannot follow, so the
 * spec cancels there and writes the request the button writes, then restarts.
 */
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import {
  createWorkspace,
  DATA_ROOT,
  expandSidebar,
  launchApp,
  openProject,
  useApp,
  workspaceRow,
  workspacesDir,
  POLL_INTERVALS,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
/** The new root: a fresh, empty folder outside the data root. */
let newRoot: string;

/** The agent project this spec is running under, for a relaunch. */
function currentAgent(): Agent {
  return test.info().project.name as Agent;
}

/** Record a requested move, as "Migrate and restart" does before it relaunches. */
function requestMigration(to: string): void {
  const statePath = join(DATA_ROOT, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  state["paths.workspaces-pending"] = to;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
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

  // --- The Change dialog, from the settings row, up to the confirmation ---
  const ui = app().uiPage();
  await expandSidebar(ui);
  await ui.getByRole("button", { name: "Settings" }).click();
  await ui.getByRole("button", { name: "Change…" }).click();
  await expect(ui.getByText("Move the workspaces folder")).toBeVisible();
  await ui.getByRole("textbox", { name: "Empty = the app data folder" }).click();
  await ui.keyboard.type(newRoot);
  await ui.getByRole("button", { name: "Migrate…" }).click();
  await expect(ui.getByText("Migrate and restart?")).toBeVisible({ timeout: 30_000 });
  await expect(ui.getByRole("button", { name: "Migrate and restart" })).toBeVisible();
  // Topmost first: the confirmation, then the settings dialog.
  await ui.getByRole("button", { name: "Cancel" }).last().click();
  await ui.getByRole("button", { name: "Cancel" }).last().click();

  // --- The next start runs the request on the starting screen, without asking ---
  await app().stop();
  requestMigration(newRoot);
  await launchApp(app(), { agent: currentAgent() });
  const migrated = app().uiPage();

  // The existing workspace is still there, where it was.
  await workspaceRow(migrated, "alpha").waitFor({ timeout: 120_000 });
  expect(existsSync(oldAlpha)).toBe(true);

  // A new one goes to the new root.
  await createWorkspace(app(), "beta");
  const projects = join(newRoot, "projects");
  await expect
    .poll(() => existsSync(projects), { intervals: POLL_INTERVALS, timeout: 60_000 })
    .toBe(true);
  const [projectDir] = readdirSync(projects);
  expect(existsSync(join(projects, projectDir!, "workspaces", "beta"))).toBe(true);

  // --- The start after that asks nothing and lists both ---
  await app().stop();
  const state = JSON.parse(readFileSync(join(DATA_ROOT, "state.json"), "utf-8")) as Record<
    string,
    unknown
  >;
  expect(state["paths.workspaces-pending"] ?? null).toBeNull();
  await launchApp(app(), { agent: currentAgent() });
  const restarted = app().uiPage();
  await workspaceRow(restarted, "alpha").waitFor({ timeout: 120_000 });
  await expect(workspaceRow(restarted, "beta")).toBeVisible();
  await expect(restarted.getByText("Moving the workspaces folder")).toHaveCount(0);
});
