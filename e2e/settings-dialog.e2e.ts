/**
 * The settings dialog takes the keyboard when it opens: Escape cancels it and
 * typing searches it, even though the workspace held focus a moment before.
 *
 * Unfixed, the form-layout dialog placed no focus at all, so the keyboard
 * stayed in the workspace behind it (its terminal) and Escape went there —
 * the dialog only reacted once clicked into. Opened from the sidebar gear: the
 * Alt+X chord is out of CDP input's reach.
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

test("the settings dialog takes the keyboard: type to search, Escape clears, Escape cancels", async () => {
  await openProject(app(), repo.path);
  await createWorkspace(app(), "keys");

  // The workspace holds the keyboard, as when working in its terminal.
  const { frame } = await app().findTarget("workspace");
  await frame.locator("body").click();

  const ui = app().uiPage();
  await expandSidebar(ui);
  await ui.getByRole("button", { name: "Settings" }).click();
  const saveRestart = ui.getByRole("button", { name: "Save & Restart" });
  await expect(saveRestart).toBeVisible();

  // Typing reveals the search box and filters: the sidebar group stays, the
  // telemetry setting goes.
  await ui.keyboard.type("sidebar");
  const search = ui.getByRole("textbox", { name: "Search" });
  await expect(search).toHaveValue("sidebar");
  await expect(ui.getByText("telemetry", { exact: true })).toBeHidden();
  await expect(ui.getByText("sidebar", { exact: true })).toBeVisible();

  // First Escape clears the search, the dialog stays.
  await ui.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(ui.getByText("telemetry", { exact: true })).toBeVisible();
  await expect(saveRestart).toBeVisible();

  // Second Escape cancels.
  await ui.keyboard.press("Escape");
  await expect(saveRestart).toBeHidden();
});
