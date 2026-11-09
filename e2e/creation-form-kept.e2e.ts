/**
 * A New workspace form with the user's input in it keeps the view.
 *
 * A workspace an agent creates in the background lands on its own when nothing
 * is active, and an agent's `ch ws switch` moves the view. Either, arriving
 * while the user is filling in the New workspace form, used to pull the form
 * (and the caret) out from under them. Now only the user's own switch leaves an
 * edited form; the agent's switch reports `switched: false` with a reason.
 */
import { expect, test } from "@playwright/test";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { chAsync, json } from "./ch";
import {
  baseBranchField,
  nameField,
  openProject,
  useApp,
  waitForWorkspaceFrame,
  workspaceRow,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

test("an agent's workspace does not take the view from a form being filled in", async () => {
  const ui = app().uiPage();
  await openProject(app(), repo.path);
  const panel = ui.getByRole("region", { name: "New workspace" });
  await expect(baseBranchField(ui)).not.toHaveValue("", { timeout: 60_000 });

  // Half-way through filling in the form.
  const field = nameField(ui);
  await field.fill("half-typed");
  await expect(field).toHaveValue("half-typed");

  // An agent creates a workspace meanwhile: nothing else is active, so it
  // would land on its own once ready.
  const created = await chAsync(["ws", "create", "agent-made", "--project", repo.path]);
  expect(created.status, `ch ws create failed: ${created.stderr}`).toBe(0);
  await expect(workspaceRow(ui, "agent-made")).toBeVisible({ timeout: 180_000 });

  // And then asks to switch to it.
  expect(json(await chAsync(["ws", "switch", "agent-made"]))).toEqual({
    switched: false,
    reason: expect.stringContaining("New workspace form"),
  });

  await expect(panel).toBeVisible();
  await expect(field).toHaveValue("half-typed");

  // Reset clears the form; from then on the agent's switch goes through.
  await panel.getByRole("button", { name: "Reset" }).click();
  await expect(nameField(ui)).toHaveValue("");
  expect(json(await chAsync(["ws", "switch", "agent-made"]))).toEqual({ switched: true });
  await waitForWorkspaceFrame(app(), "agent-made");
});
