/**
 * The app launches, renders, and quits cleanly.
 *
 * Cheapest test in the suite and the highest value per second: it catches
 * packaging breakage — a bad ASAR, missing extraResources, a broken main entry —
 * before any other spec gets a chance to be confusing about it.
 */
import { expect, test } from "@playwright/test";
import { expectNoNativeDialogs, useApp } from "./fixtures";

const app = useApp();

test("the window renders the sidebar and the new-workspace panel", async () => {
  const ui = app().uiPage();

  await expect(ui.getByRole("navigation", { name: "Projects" })).toBeVisible();
  await expect(ui.getByRole("heading", { name: "PROJECTS" })).toBeVisible();
  await expect(ui.getByRole("button", { name: "New workspace" })).toBeVisible();

  // With no project open, the panel offers the two ways to get one.
  await expect(ui.getByRole("button", { name: "Open project folder" })).toBeVisible();
  await expect(ui.getByRole("button", { name: "Clone from Git" })).toBeVisible();
});

test("no agent wizard on a configured install", async () => {
  const ui = app().uiPage();
  await expect(ui.getByRole("dialog", { name: "Choose Agent" })).toBeHidden();
});

test("the app raised no native dialogs", async () => {
  await expectNoNativeDialogs(app());
});

test("the renderer logged no errors", async () => {
  const errors = app()
    .consoleMessages({ level: "error" })
    // Chromium/VSCodium chatter we do not own.
    .filter((m) => !/Autofill|devtools|Electron Security Warning/i.test(m.text));

  expect(errors.map((e) => e.text)).toEqual([]);
});
