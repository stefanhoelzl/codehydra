/**
 * Global setup for the boundary test project.
 *
 * Compiles the fake claude binary once per run, outside any test worker. On
 * Windows this invokes @yao-pkg/pkg to bundle a real claude.exe; on a cold
 * pkg cache that first downloads a base Node binary from GitHub, which blew
 * vitest's 10s hookTimeout when it ran in beforeAll under CI contention (the
 * dominant Windows flake). globalSetup is awaited by the vitest main process
 * with no hook timeout, so a slow download can delay the run but never fail
 * it. Tests read the directory via inject("fakeClaudeBinDir").
 */

import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { createTempDir } from "../utils/testing/test-utils";
import { createFakeClaudeBinary } from "../modules/agent-module/claude/fake-claude-binary";

declare module "vitest" {
  export interface ProvidedContext {
    fakeClaudeBinDir: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const tempDir = await createTempDir();
  const fakeBinDir = await createFakeClaudeBinary(join(tempDir.path, "bin"));
  project.provide("fakeClaudeBinDir", fakeBinDir);
  return () => tempDir.cleanup();
}
