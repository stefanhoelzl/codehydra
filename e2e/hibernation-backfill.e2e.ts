/**
 * A workspace hibernated before CodeHydra recorded the time (no
 * `hibernated-at`) gets one when its project opens, so its row shows an age.
 *
 * Hibernation has no affordance a spec can drive (Alt+X then H, which CDP
 * input cannot reach), so the spec writes what an older version left behind —
 * the `hibernated` flag without a time — while the app is stopped (it holds
 * metadata in memory while it runs), then relaunches.
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { projectAgent } from "./env";
import { POLL_INTERVALS, createWorkspace, launchApp, openProject, useApp } from "./fixtures";

const TIMEOUT = 180_000;

const app = useApp();

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

type MetadataFile = Record<"internal" | "protected" | "public", Record<string, string>>;

/** `codehydra.json` in the git directory of the worktree on branch `name`. */
function metadataFileOf(name: string): string {
  const worktrees = join(repo.path, ".git", "worktrees");
  for (const id of existsSync(worktrees) ? readdirSync(worktrees) : []) {
    const head = readFileSync(join(worktrees, id, "HEAD"), "utf-8").trim();
    if (head === `ref: refs/heads/${name}`) return join(worktrees, id, "codehydra.json");
  }
  throw new Error(`no worktree on branch ${name}`);
}

function readMetadata(name: string): MetadataFile {
  return JSON.parse(readFileSync(metadataFileOf(name), "utf-8")) as MetadataFile;
}

test("a workspace hibernated without a recorded time gets one, and its row an age", async () => {
  test.setTimeout(TIMEOUT * 2);
  await openProject(app(), repo.path);
  await createWorkspace(app(), "legacy");

  await app().stop();
  const metadata = readMetadata("legacy");
  metadata.protected.hibernated = "true";
  delete metadata.protected["hibernated-at"];
  writeFileSync(metadataFileOf("legacy"), JSON.stringify(metadata));
  const before = Date.now();

  await launchApp(app(), { agent: projectAgent(test.info().project.name) });
  const ui = app().uiPage();

  // The row reads as hibernated with an age (it folds behind its project's
  // count, so look past the fold).
  await ui
    .getByRole("button", {
      name: /^legacy in .* - Hibernated .+ \(.+\) - click to wake$/,
      includeHidden: true,
    })
    .waitFor({ state: "attached", timeout: TIMEOUT });

  // ...and the time is on disk: no screenshot was left, so it is the open.
  await expect
    .poll(() => Date.parse(readMetadata("legacy").protected["hibernated-at"] ?? ""), {
      intervals: POLL_INTERVALS,
      timeout: TIMEOUT,
    })
    .toBeGreaterThanOrEqual(before);
});
