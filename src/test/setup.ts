/// <reference types="@testing-library/jest-dom" />
import "@testing-library/jest-dom/vitest";

import { mkdtemp, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll } from "vitest";
import { FIXTURE_ROOT } from "../shared/test-fixtures";

// Redirect Bun's temp files to a per-suite directory to prevent orphaned
// .so/.hm files accumulating in /tmp (OpenCode's Zig runtime extracts
// shared libraries to BUN_TMPDIR on every launch and never cleans them up).
let bunTmpDir: string | undefined;
const originalBunTmpDir = process.env.BUN_TMPDIR;

beforeAll(async () => {
  bunTmpDir = await mkdtemp(join(tmpdir(), "codehydra-bun-tmp-"));
  process.env.BUN_TMPDIR = bunTmpDir;
});

afterAll(async () => {
  if (originalBunTmpDir !== undefined) {
    process.env.BUN_TMPDIR = originalBunTmpDir;
  } else {
    delete process.env.BUN_TMPDIR;
  }
  if (bunTmpDir) {
    await rm(bunTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

// `testPath()` fixtures name a real directory but deliberately never create it:
// everything using them runs against the in-memory filesystem mock. So anything
// appearing under the fixture root means a test escaped its mock and wrote to
// disk — the way state-module did through Config's `node:fs` rewrite branch,
// which swallows its own errors and so stayed invisible until the directory
// happened to exist.
//
// A tripwire rather than a beforeEach that cleans up: cleanup would keep the
// escape hidden, and a shared root cannot be cleaned safely while sibling
// workers are still running. A test that genuinely needs a directory on disk
// should use `createTempDir()` (src/utils/testing/test-utils.ts), which makes
// its own and removes it again.
afterAll(async () => {
  const leaked = await readdir(FIXTURE_ROOT.toNative()).catch(() => null);
  if (leaked === null) return;
  await rm(FIXTURE_ROOT.toNative(), { recursive: true, force: true });
  throw new Error(
    `A test wrote to the fixture root (${FIXTURE_ROOT.toNative()}): ${leaked.join(", ")}. ` +
      "testPath() names paths for the filesystem mock; use createTempDir() for real I/O."
  );
});
