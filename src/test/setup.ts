/// <reference types="@testing-library/jest-dom" />
import "@testing-library/jest-dom/vitest";

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll } from "vitest";

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
