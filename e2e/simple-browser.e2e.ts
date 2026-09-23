/**
 * Local files in Simple Browser, against the real bundle and Chromium.
 *
 * The fast tests cover the pieces: the bundle patch rewriting `file://` in
 * Simple Browser's script, and the interceptor answering the rewritten host from
 * disk. What only a real run proves is that they meet — that the patched script
 * is the one the webview actually loads (not a copy cached from before the
 * patch), and that Chromium lets the https webview frame the rewritten URL where
 * it refused `file:` outright and rendered a blank page.
 */
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { ch } from "./ch.ts";
import {
  appLogEntries,
  createWorkspace,
  openProject,
  useApp,
  waitForConnectionDetails,
  waitForWorkspaceFrame,
  workspacesDir,
} from "./fixtures";

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };
let site: string;

test.beforeAll(async () => {
  repo = await createTestGitRepo();

  // A page that needs every piece to work: a stylesheet and a module script
  // (served with the wrong type, neither applies) and a relative link.
  site = mkdtempSync(join(tmpdir(), "ch-local-site-"));
  writeFileSync(
    join(site, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css">' +
      '<script type="module" src="app.js"></script><h1 id="title">local page ü</h1>'
  );
  writeFileSync(join(site, "style.css"), "#title { color: rgb(255, 0, 0); }");
  writeFileSync(join(site, "app.js"), 'document.body.dataset.module = "ran";');
  mkdirSync(join(site, "docs"));
  writeFileSync(join(site, "docs", "notes.txt"), "notes");
});

test.afterAll(async () => {
  await repo?.cleanup();
  if (site) rmSync(site, { recursive: true, force: true });
});

/** The frame Simple Browser loaded the rewritten local-file URL into. */
async function localFrame() {
  return (await app().findTarget("file.codehydra.invalid")).frame;
}

test("renders a file:// page with its stylesheet and scripts", async () => {
  await waitForConnectionDetails();
  await openProject(app(), repo.path);
  await createWorkspace(app(), "local-page");
  await waitForWorkspaceFrame(app(), "local-page");
  const workspace = join(workspacesDir(), "local-page");
  await expect.poll(() => existsSync(workspace), { timeout: 60_000 }).toBe(true);
  // Editor commands go through the workspace's sidekick extension, which
  // connects some time after the frame shows; before that they fail.
  await expect
    .poll(
      () =>
        appLogEntries().some(
          (e) =>
            e.message === "Client connected" &&
            String(e.context?.["workspace"] ?? "").endsWith("local-page")
        ),
      { timeout: 120_000 }
    )
    .toBe(true);

  const run = ch(["ws", "browser", pathToFileURL(join(site, "index.html")).href], workspace);
  expect(run.status, run.stderr).toBe(0);

  await expect
    .poll(
      async () =>
        (await localFrame().catch(() => null))
          ?.evaluate(() => ({
            title: document.getElementById("title")?.textContent ?? null,
            color: getComputedStyle(document.getElementById("title")!).color,
            module: document.body.dataset.module ?? null,
          }))
          .catch(() => null) ?? null,
      { timeout: 60_000 }
    )
    .toEqual({ title: "local page ü", color: "rgb(255, 0, 0)", module: "ran" });
});

test("lists a directory without an index.html", async () => {
  const workspace = join(workspacesDir(), "local-page");
  // No trailing slash: the listing's relative links must still land inside it.
  const run = ch(["ws", "browser", pathToFileURL(join(site, "docs")).href], workspace);
  expect(run.status, run.stderr).toBe(0);

  await expect
    .poll(
      async () =>
        (await localFrame().catch(() => null))
          ?.evaluate(() =>
            [...document.querySelectorAll("a")].map((a) =>
              new URL(a.href).pathname.split("/").pop()
            )
          )
          .catch(() => null) ?? null,
      { timeout: 60_000 }
    )
    .toContain("notes.txt");

  const frame = await localFrame();
  await frame.click("text=notes.txt");
  // Mid-navigation the old document is gone and evaluate throws; poll past it.
  await expect
    .poll(() => frame.evaluate(() => document.body.innerText.trim()).catch(() => null))
    .toBe("notes");
});
