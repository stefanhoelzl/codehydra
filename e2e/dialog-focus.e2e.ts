/**
 * A workspace starting up behind a dialog must not take the keyboard from it.
 *
 * The workbench focuses its editor as it finishes starting (`restoreParts`),
 * and a focus call inside a frame takes the page's focus from wherever it is.
 * Unguarded, the caret left a dialog's text field mid-typing and the rest of
 * the keystrokes went to the workspace (it showed up as a truncated path in
 * workspaces-root.e2e.ts). The focus gate patched into the workbench refuses
 * that call while a dialog owns the keyboard (bundle-patches.ts, FOCUS_GATE).
 *
 * The typing is slowed down on purpose so it spans the workbench's startup:
 * at full speed it usually finishes first, and the spec would prove nothing.
 */
import { expect, test } from "@playwright/test";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { createWorkspace, expandSidebar, openProject, useApp } from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

test("typing into a dialog keeps the keyboard while a workspace starts behind it", async () => {
  await openProject(app(), repo.path);
  await createWorkspace(app(), "behind");

  // Straight away, while the new workspace's workbench is still starting.
  const ui = app().uiPage();
  await expandSidebar(ui);
  await ui.getByRole("button", { name: "Settings" }).click();
  await ui.getByRole("button", { name: "Change…" }).click();
  const field = ui.getByRole("textbox", { name: "Empty = the app data folder" });
  await field.click();

  const text = "/a/path/typed/while/the/workspace/starts";
  await ui.keyboard.type(text, { delay: 100 });

  await expect(field).toHaveValue(text);

  await ui.getByRole("button", { name: "Cancel" }).last().click();
  await ui.getByRole("button", { name: "Cancel" }).last().click();
});
