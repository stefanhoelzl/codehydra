/**
 * At start, a project's workspaces are listed before they are open.
 *
 * Opening every workspace takes a while (git and an agent start each, one
 * after another), so the startup screen only waits for each project to list
 * its workspaces. A local plugin's `before-workspace-opened` hook holds one
 * workspace's open until the spec lets it go, which makes "still opening"
 * observable instead of a race.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import type { Agent } from "./env";
import {
  HOME_ROOT,
  createWorkspace,
  launchApp,
  openProject,
  useApp,
  waitForWorkspaceFrame,
  workspaceRow,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
let releaseDir: string;

test.beforeAll(async () => {
  repo = await createTestGitRepo();
  releaseDir = mkdtempSync(join(tmpdir(), "ch-e2e-release-"));
});

test.afterAll(async () => {
  await repo?.cleanup();
  if (releaseDir) rmSync(releaseDir, { recursive: true, force: true });
});

/** The row of a workspace that is listed but still opening. */
function loadingRow(ui: Page, name: string): Locator {
  return ui.getByRole("button", { name: new RegExp(`^${name} in .* - Loading$`) });
}

test("a restart lists every workspace at once and lands on the topmost while the rest open", async () => {
  test.setTimeout(600_000);
  await openProject(app(), repo.path);
  await createWorkspace(app(), "alpha");
  await createWorkspace(app(), "beta");

  // Hold beta's next open until the release file exists. Git Bash on Windows
  // reads `C:/x/y`.
  const release = join(releaseDir, "go").replace(/\\/g, "/");
  const script = [
    "input=$(cat)",
    `case "$input" in *'"workspaceName":"beta"'*)`,
    `  while [ ! -f "${release}" ]; do sleep 0.2; done ;;`,
    "esac",
    "echo '{}'",
  ].join("\n");
  const plugins = join(HOME_ROOT, "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "hold-beta.yaml"),
    `hooks:\n  before-workspace-opened: ${JSON.stringify(script)}\n`
  );

  await app().stop();
  await launchApp(app(), { agent: test.info().project.name as Agent });
  const ui = app().uiPage();

  // The startup screen is gone and alpha — the topmost row — is usable while
  // beta is still listed as opening.
  await loadingRow(ui, "beta").waitFor({ timeout: 180_000 });
  await waitForWorkspaceFrame(app(), "alpha", 180_000);
  await expect(loadingRow(ui, "beta")).toBeVisible();

  writeFileSync(join(releaseDir, "go"), "");
  await loadingRow(ui, "beta").waitFor({ state: "hidden", timeout: 180_000 });
  await expect(workspaceRow(ui, "beta")).toBeVisible();
});
