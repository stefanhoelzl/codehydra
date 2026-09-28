// @vitest-environment node
/**
 * Boundary tests for the script runner: real shells, real files, real exit codes.
 *
 * The behavioural mocks cannot say whether a script body actually reaches its
 * shell intact — quoting, the temp file's extension, `-eo pipefail`, cmd's echo,
 * a cwd with a space in it — so these run the real thing. bash runs on every
 * platform (Git Bash on Windows, which CI's runners have); cmd only on Windows;
 * PowerShell wherever `pwsh` is installed, or Windows PowerShell on Windows.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { ExecaProcessRunner } from "../../boundaries/platform/process";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { Path } from "../../utils/path/path";
import { createShellResolver, type ShellName } from "./shells";
import { createScriptRunner, type ScriptRequest, type ScriptRunner } from "./script-runner";
import { convertLegacySources } from "./legacy-sources";

const isWindows = process.platform === "win32";

function hasPwsh(): boolean {
  try {
    execFileSync(isWindows ? "pwsh.exe" : "pwsh", ["-NoProfile", "-Command", "exit 0"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return isWindows; // Windows PowerShell is the fallback there.
  }
}

let root: string;
/** A cwd with a space in its name — the ordinary case, not an edge case. */
let cwd: string;
let runner: ScriptRunner;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(nodePath.join(os.tmpdir(), "ch-scripts-")));
  cwd = nodePath.join(root, "my workspace");
  await fs.mkdir(cwd, { recursive: true });
  const fileSystem = new DefaultFileSystemBoundary(SILENT_LOGGER);
  runner = createScriptRunner({
    fileSystem,
    processRunner: new ExecaProcessRunner(SILENT_LOGGER),
    shells: createShellResolver({
      fileSystem,
      platform: process.platform,
      env: process.env,
      bashOverride: () => null,
    }),
    logger: SILENT_LOGGER,
    tempDir: new Path(root, "temp"),
    binDir: new Path(root, "bin"),
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function request(
  shell: ShellName,
  script: string,
  extra: Partial<ScriptRequest> = {}
): ScriptRequest {
  return {
    plugin: "local:test",
    entry: "entry",
    shell,
    script,
    cwd: new Path(cwd),
    input: { hello: "world" },
    logDir: new Path(root, "logs"),
    ...extra,
  };
}

describe("bash", () => {
  it("runs the body with the JSON on stdin and captures stdout", async () => {
    const run = await runner.run(request("bash", 'read -r line; echo "got $line"'));

    expect(run.result.status).toBe("exited");
    expect(run.result.exitCode).toBe(0);
    expect(run.result.stdout.trim()).toBe('got {"hello":"world"}');
  });

  it("stops at the first failing command (-e) and in a pipeline (pipefail)", async () => {
    const run = await runner.run(request("bash", "false | cat\necho unreachable"));

    expect(run.result.exitCode).not.toBe(0);
    expect(run.result.stdout).not.toContain("unreachable");
  });

  it("runs in the cwd and sees the plugin and workspace dirs and ch's bin dir", async () => {
    const run = await runner.run(
      request(
        "bash",
        'pwd -W 2>/dev/null || pwd\necho "$CH_PLUGIN_DIR"\necho "$CH_WORKSPACE_DIR"\necho "$PATH"',
        {
          pluginDir: new Path(root, "plugin"),
          workspaceDir: new Path(cwd),
        }
      )
    );

    const [pwd, pluginDir, workspaceDir, path] = run.result.stdout.trim().split(/\r?\n/);
    expect(new Path(pwd!).equals(new Path(cwd))).toBe(true);
    expect(new Path(pluginDir!).equals(new Path(root, "plugin"))).toBe(true);
    expect(new Path(workspaceDir!).equals(new Path(cwd))).toBe(true);
    expect(path!.toLowerCase()).toContain("bin");
  });

  it("writes the run's log with the caller's verdict and removes its temp file", async () => {
    const run = await runner.run(request("bash", "echo oops >&2; exit 3"));
    const logPath = await run.finish({ outcome: "failed", reason: "exit 3" });

    expect(run.result.exitCode).toBe(3);
    expect(logPath).toBeDefined();
    const text = await fs.readFile(logPath!.toNative(), "utf-8");
    expect(text).toContain("outcome:  failed — exit 3");
    expect(text).toContain("--- stderr ---\noops");
    expect(await fs.readdir(nodePath.join(root, "temp"))).toEqual([]);
  });

  it("kills a script that is canceled, keeping what it printed", async () => {
    const controller = new AbortController();
    const pending = runner.run(
      request("bash", "echo started; sleep 30", { signal: controller.signal })
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();

    const run = await pending;

    expect(run.result.status).toBe("canceled");
    expect(run.result.exitCode).toBeNull();
  }, 15_000);

  it("kills a script that outlives its timeout", async () => {
    const run = await runner.run(request("bash", "sleep 30", { timeoutMs: 300 }));

    expect(run.result.status).toBe("timed-out");
  }, 15_000);
});

describe.runIf(isWindows)("cmd", () => {
  it("runs a batch body without echoing its commands to stdout", async () => {
    const run = await runner.run(request("cmd", 'echo {"ok":true}'));

    expect(run.result.exitCode).toBe(0);
    expect(run.result.stdout.trim()).toBe('{"ok":true}');
  });

  it("runs a migrated auto-workspace source as the old cmd /c did", async () => {
    // cmd.exe runs the left side of a pipe in a second cmd.exe that parses it
    // again; the migrated source must still see its `^` escapes, and a `%`
    // that a command line kept.
    const converted = convertLegacySources(
      "name: src\ncmd: echo a^(b^),c%20 ^& echo x\ntemplate:\n  name: x",
      "win32",
      process.env
    );
    const pluginDir = nodePath.join(root, "plugin");
    await fs.mkdir(nodePath.join(pluginDir, "sources"), { recursive: true });
    for (const [file, text] of Object.entries(converted.sources)) {
      await fs.writeFile(nodePath.join(pluginDir, "sources", file), text);
    }
    // Stands in for `ch plugin render`: a batch file too, printing what it is piped.
    await fs.mkdir(nodePath.join(root, "bin"), { recursive: true });
    await fs.writeFile(nodePath.join(root, "bin", "ch.cmd"), "@findstr .\r\n");
    const script = (parse(converted.manifest) as { automations: Record<string, string> })
      .automations["src"]!;

    const run = await runner.run(request("cmd", script, { pluginDir: new Path(pluginDir) }));

    expect(run.result.exitCode).toBe(0);
    expect(run.result.stdout.split(/\r?\n/).map((line) => line.trim())).toEqual([
      "a(b),c%20",
      "x",
      "",
    ]);
  });
});

describe.runIf(hasPwsh())("powershell", () => {
  it("runs the body and reads stdin", async () => {
    const run = await runner.run(
      request("powershell", '$line = [Console]::In.ReadToEnd(); Write-Output "got $line"')
    );

    expect(run.result.exitCode).toBe(0);
    expect(run.result.stdout.trim()).toBe('got {"hello":"world"}');
  });
});
