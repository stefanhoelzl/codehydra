// @vitest-environment node
/**
 * Boundary tests for the hook runner: real files, a real shell, real exit codes.
 *
 * These exist for the half the behavioural mocks cannot reach. Hooks are handed
 * to the platform shell as a quoted path, and worktree paths routinely contain
 * spaces — so whether a hook runs at all comes down to quoting that only a real
 * `sh`/`cmd` can settle. The same goes for the exec bit: the mock has no notion
 * of one, while on POSIX it is exactly what decides whether the file is a hook.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { ExecaProcessRunner } from "../../boundaries/platform/process";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { Path } from "../../utils/path/path";
import { z } from "zod/v4";
import { findHook, runHook, HookFailedError, type HookRunnerDeps } from "./runner";
import { HOOKS_DIR, HOOKS_ROOT } from "./hook-map";

const isWindows = process.platform === "win32";

/** A directory with a space in its name — the ordinary case, not an edge case. */
let worktree: string;
let sinkLines: Array<{ entry: string; line: string }>;
let deps: HookRunnerDeps;

const outputSchema = z.object({ ok: z.boolean().optional() }).strict();

/** A hook that prints a valid result, in each platform's native form. */
const OK_POSIX = ["#!/bin/sh", `echo '{"ok":true}'`, ""].join("\n");
const OK_WINDOWS = ["@echo off", 'echo {"ok":true}', ""].join("\r\n");

beforeEach(async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "ch-hooks-"));
  worktree = nodePath.join(root, "my workspace");
  await fs.mkdir(nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR), { recursive: true });
  sinkLines = [];
  deps = {
    fileSystem: new DefaultFileSystemBoundary(SILENT_LOGGER),
    processRunner: new ExecaProcessRunner(SILENT_LOGGER),
    logger: SILENT_LOGGER,
    binDir: new Path("/data/bin"),
    sink: { write: (_ws, entry, line) => sinkLines.push({ entry, line }) },
  };
});

afterEach(async () => {
  await fs.rm(nodePath.dirname(worktree), { recursive: true, force: true });
});

/** Write a hook and make it executable, in whatever the platform runs natively. */
async function writeHook(name: string, posix: string, windows: string): Promise<string> {
  const entry = isWindows ? `${name}.cmd` : name;
  const file = nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR, entry);
  await fs.writeFile(file, isWindows ? windows : posix);
  if (!isWindows) await fs.chmod(file, 0o755);
  return entry;
}

async function run(entry: string, input: unknown = {}): Promise<z.infer<typeof outputSchema>> {
  const wt = new Path(worktree);
  const found = await findHook(deps, wt, HOOKS_DIR, entry);
  if (!found) throw new Error(`hook ${entry} was not found`);
  return runHook(deps, found, wt, input, outputSchema);
}

describe("running a real hook", () => {
  it("runs a hook whose path contains spaces", async () => {
    const entry = await writeHook(
      "echoes",
      "#!/bin/sh\necho '{\"ok\":true}'\n",
      '@echo off\r\necho {"ok":true}\r\n'
    );
    await expect(run(entry)).resolves.toEqual({ ok: true });
  });

  it("hands the input to the hook on stdin", async () => {
    const entry = await writeHook(
      "reads-stdin",
      "#!/bin/sh\ncat >&2\necho '{}'\n",
      "@echo off\r\nmore 1>&2\r\necho {}\r\n"
    );
    await run(entry, { workspaceName: "feature-x" });
    expect(sinkLines.map((line) => line.line).join("")).toContain('"workspaceName":"feature-x"');
  });

  it("runs the hook with the worktree as its working directory", async () => {
    const entry = await writeHook(
      "pwd",
      "#!/bin/sh\npwd >&2\necho '{}'\n",
      "@echo off\r\ncd 1>&2\r\necho {}\r\n"
    );
    await run(entry);
    // Realpath, because macOS hands out /var -> /private/var symlinks for temp.
    const reported = sinkLines.at(-1)!.line.trim();
    expect(await fs.realpath(reported)).toBe(await fs.realpath(worktree));
  });

  it("sends stderr to the sink and keeps it out of the result", async () => {
    const entry = await writeHook(
      "chatty",
      '#!/bin/sh\necho "working" >&2\necho \'{"ok":true}\'\n',
      '@echo off\r\necho working 1>&2\r\necho {"ok":true}\r\n'
    );
    await expect(run(entry)).resolves.toEqual({ ok: true });
    expect(sinkLines.map((line) => line.line)).toContain("working");
  });

  it("treats no output as an empty result", async () => {
    const entry = await writeHook("silent", "#!/bin/sh\nexit 0\n", "@echo off\r\nexit /b 0\r\n");
    await expect(run(entry)).resolves.toEqual({});
  });
});

describe("failures", () => {
  it("reports a non-zero exit with the last thing the hook said", async () => {
    const entry = await writeHook(
      "refuses",
      '#!/bin/sh\necho "lock held" >&2\nexit 3\n',
      "@echo off\r\necho lock held 1>&2\r\nexit /b 3\r\n"
    );
    await expect(run(entry)).rejects.toThrow(/exit 3.*lock held/s);
  });

  it("rejects output that is not JSON, pointing at stderr instead", async () => {
    const entry = await writeHook(
      "prints-prose",
      '#!/bin/sh\necho "all done"\n',
      "@echo off\r\necho all done\r\n"
    );
    await expect(run(entry)).rejects.toThrow(/not JSON.*stderr/s);
  });

  it("rejects JSON that does not match the contract", async () => {
    const entry = await writeHook(
      "wrong-shape",
      "#!/bin/sh\necho '{\"nope\":1}'\n",
      '@echo off\r\necho {"nope":1}\r\n'
    );
    await expect(run(entry)).rejects.toThrow(HookFailedError);
  });
});

describe("what counts as a hook", () => {
  it("finds nothing when the repository has no hooks directory", async () => {
    await fs.rm(nodePath.join(worktree, HOOKS_ROOT), { recursive: true, force: true });
    await expect(
      findHook(deps, new Path(worktree), HOOKS_DIR, "anything")
    ).resolves.toBeUndefined();
  });

  it("finds a hook that carries an extension", async () => {
    // `.py` is how most people would write one, and on Windows `.cmd` is the
    // only way a hook can run at all.
    const entry = await writeHook("extended", OK_POSIX, OK_WINDOWS);
    if (!isWindows) {
      await fs.rename(
        nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR, entry),
        nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR, `${entry}.sh`)
      );
    }
    await expect(run("extended")).resolves.toEqual({ ok: true });
  });

  it("ignores a directory sitting where a hook file should be", async () => {
    await fs.mkdir(nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR, "not-a-hook"));
    await expect(
      findHook(deps, new Path(worktree), HOOKS_DIR, "not-a-hook")
    ).resolves.toBeUndefined();
  });

  it.skipIf(isWindows)("fails loudly when the file is not executable", async () => {
    const file = nodePath.join(worktree, HOOKS_ROOT, HOOKS_DIR, "no-exec-bit");
    await fs.writeFile(file, "#!/bin/sh\necho '{}'\n");
    await fs.chmod(file, 0o644);

    // git skips a non-executable hook in silence, which is its most-reported
    // footgun. The shell's 126 is what lets this say so instead.
    await expect(run("no-exec-bit")).rejects.toThrow(/not executable/);
  });
});
