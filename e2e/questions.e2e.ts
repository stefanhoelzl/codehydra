/**
 * `ch ws ask|select|input|pick-file` and `ch ws notify`, against the real editor
 * and the real sidebar.
 *
 * The fast tests cover every hop with stand-ins: the registry entries, the API
 * server's socket round trip, and the sidekick's handlers over a VS Code fake.
 * What only a real run proves is that the fake is right about VS Code — that the
 * modal shows the buttons and VS Code's own Cancel, that the quick pick and the
 * input box answer what the user picked or typed, that a cancelled one really
 * closes, that the file dialog of the embedded editor browses the workspace's
 * machine and answers its path — and that a toast holds nobody up.
 */
import { expect, test, type Frame } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { chAsync, json } from "./ch.ts";
import {
  appLogEntries,
  createWorkspace,
  expandSidebar,
  openProject,
  useApp,
  waitForConnectionDetails,
  waitForWorkspaceFrame,
  workspacesDir,
  POLL_INTERVALS,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
let workspace: string;

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

/** The workspace's VS Code frame. */
async function editor(): Promise<Frame> {
  return (await app().findTarget("workspace")).frame;
}

/** Run `ch` in the workspace, as a shell standing in it would. */
function chHere(args: readonly string[]) {
  return chAsync(args, workspace);
}

/** The visible quick input (quick pick, input box, simple file dialog). */
async function quickInput() {
  const widget = (await editor()).locator(".quick-input-widget");
  await expect(widget).toBeVisible({ timeout: 30_000 });
  return widget;
}

test.describe.configure({ mode: "serial" });

test("sets up a workspace whose editor is connected", async () => {
  await waitForConnectionDetails();
  await openProject(app(), repo.path);
  await createWorkspace(app(), "questions");
  await waitForWorkspaceFrame(app(), "questions");
  workspace = join(workspacesDir(), "questions");
  // Editor messages go through the workspace's sidekick extension, which
  // connects some time after the frame shows; before that they fail.
  await expect
    .poll(
      () =>
        appLogEntries().some(
          (e) => e.message === "Client connected" && e.scope?.["ws"] === "questions"
        ),
      { intervals: POLL_INTERVALS, timeout: 120_000 }
    )
    .toBe(true);
});

test("notify shows a toast and returns at once", async () => {
  const run = await chHere(["ws", "notify", "Toast from ch", "--level", "warning"]);

  expect(json(run)).toBeNull();
  await expect(
    (await editor()).locator(".notification-toast", { hasText: "Toast from ch" })
  ).toBeVisible({ timeout: 30_000 });
});

test("ask shows a dialog and answers the clicked button", async () => {
  const answer = chHere(["ws", "ask", "Deploy now?", "--options", "Deploy", "--options", "Skip"]);

  const dialog = (await editor()).locator(".monaco-dialog-box");
  await expect(dialog).toContainText("Deploy now?", { timeout: 30_000 });
  // VS Code adds Cancel by itself.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await dialog.getByRole("button", { name: "Skip" }).click();

  expect(json(await answer)).toEqual({ answer: "Skip" });
  await expect(dialog).toHaveCount(0);
});

test("ask answers null when cancelled", async () => {
  const answer = chHere(["ws", "ask", "Really?", "--options", "Yes"]);

  const dialog = (await editor()).locator(".monaco-dialog-box");
  await expect(dialog).toContainText("Really?", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();

  expect(json(await answer)).toEqual({ answer: null });
});

test("ask --sidebar puts the question on a card and answers the click", async () => {
  await expandSidebar(app().uiPage());
  const answer = chHere([
    "ws",
    "ask",
    "Ship it?",
    "--options",
    "Ship",
    "--options",
    "Hold",
    "--detail",
    "main is green",
    "--sidebar",
  ]);

  const card = app()
    .uiPage()
    .getByRole("status", { name: /^Ship it\?/ });
  await expect(card).toContainText("main is green", { timeout: 30_000 });
  await card.locator("vscode-button", { hasText: "Ship" }).click();

  expect(json(await answer)).toEqual({ answer: "Ship" });
  await expect(card).toHaveCount(0);
});

test("select answers the entry picked from the list", async () => {
  const answer = chHere([
    "ws",
    "select",
    "Which branch?",
    "--options",
    "main",
    "--options",
    '{"label":"develop","description":"nightly"}',
  ]);

  const widget = await quickInput();
  await expect(widget).toContainText("nightly");
  await (await editor()).locator(".quick-input-box input").fill("devel");
  await app().key("Enter");

  expect(json(await answer)).toEqual({ answer: "develop" });
  await expect(widget).toBeHidden();
});

test("select --many answers every ticked entry, the picked ones ticked in advance", async () => {
  const answer = chHere([
    "ws",
    "select",
    "Suites",
    "--options",
    '{"label":"unit","picked":true}',
    "--options",
    "e2e",
    "--options",
    '{"label":"lint","picked":true}',
    "--many",
  ]);

  await quickInput();
  await app().key("Enter");

  expect(json(await answer)).toEqual({ answer: ["unit", "lint"] });
});

test("select gives up at its timeout and closes the list", async () => {
  const answer = chHere(["ws", "select", "Too slow", "--options", "a", "--timeout", "2"]);

  const widget = await quickInput();
  expect(json(await answer)).toEqual({ answer: null });
  await expect(widget).toBeHidden({ timeout: 10_000 });
});

test("input answers the typed text, starting from its value", async () => {
  const answer = chHere(["ws", "input", "Release name", "--value", "v1."]);

  await quickInput();
  const box = (await editor()).locator(".quick-input-box input");
  await expect(box).toHaveValue("v1.");
  await box.fill("v1.2.0");
  await app().key("Enter");

  expect(json(await answer)).toEqual({ answer: "v1.2.0" });
});

test("input answers null on Escape", async () => {
  const answer = chHere(["ws", "input", "Never mind"]);

  await quickInput();
  await app().key("Escape");

  expect(json(await answer)).toEqual({ answer: null });
});

test("pick-file browses the workspace and answers the chosen path", async () => {
  const docs = join(workspace, "docs");
  mkdirSync(docs, { recursive: true });
  const target = join(docs, "notes.txt");
  writeFileSync(target, "notes");

  const answer = chHere(["ws", "pick-file", "Pick the notes", "--start", "docs"]);

  // The embedded editor's own dialog: a path box over the workspace's machine.
  await quickInput();
  const box = (await editor()).locator(".quick-input-box input");
  await box.fill(target);
  await app().key("Enter");

  const { answer: picked } = json(await answer) as { answer: string };
  // VS Code reports a Windows drive letter in lower case: the same path.
  expect(picked.replace(/^[a-z]:/, (drive) => drive.toUpperCase())).toBe(target);
});
