// @vitest-environment node
/**
 * Boundary tests for `ch bg` in the compiled `ch` bundle (dist/bin/ch.cjs),
 * which `pnpm build:wrappers` builds before tests run.
 *
 * `ch bg` is a drop-in wrapper, so what matters is that a caller cannot tell it
 * is there: the child's exit code, and a signal death reported as a shell does.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { createTempDir } from "../utils/testing/test-utils";
import {
  assertCompiledScript,
  executeScript,
} from "../modules/agent-module/wrapper-boundary-test-utils";

const COMPILED_SCRIPT_PATH = resolve(__dirname, "../../dist/bin/ch.cjs");

describe("ch bg", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    await assertCompiledScript(COMPILED_SCRIPT_PATH);
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it("exits with the command's exit code", async () => {
    const result = await executeScript(COMPILED_SCRIPT_PATH, {}, tempDir.path, [
      "bg",
      process.execPath,
      "-e",
      "process.exit(42)",
    ]);

    expect(result.status).toBe(42);
  });

  // Windows has no POSIX signal deaths to report.
  it.skipIf(process.platform === "win32")(
    "exits with 128 + the signal number when a signal kills the command",
    async () => {
      const result = await executeScript(COMPILED_SCRIPT_PATH, {}, tempDir.path, [
        "bg",
        process.execPath,
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ]);

      expect(result.status).toBe(128 + osConstants.signals.SIGTERM);
    }
  );
});
