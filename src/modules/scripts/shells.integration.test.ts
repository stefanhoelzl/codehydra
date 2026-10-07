// @vitest-environment node
/**
 * Which program runs each shell, on each platform.
 *
 * The Windows cases run everywhere: the resolver takes its platform and
 * environment as data, and the filesystem mock stands in for the disk, so the
 * Git Bash search is exercised on the Linux CI runner too. Paths are POSIX-style
 * for that reason; the logic under test is where it looks, not the separators.
 */

import { describe, it, expect } from "vitest";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { Path } from "../../utils/path/path";
import { createShellResolver, ShellUnavailableError, type ShellResolverDeps } from "./shells";

function resolver(
  entries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>,
  options: Partial<Omit<ShellResolverDeps, "fileSystem">> = {}
): ReturnType<typeof createShellResolver> {
  return createShellResolver({
    fileSystem: createFileSystemMock({ entries }),
    platform: "win32",
    env: {},
    bashOverride: () => null,
    ...options,
  });
}

const SCRIPT = new Path("/tmp/run/abc.sh");

describe("bash on Windows", () => {
  it("uses the Git Bash next to git on PATH", async () => {
    const shells = resolver(
      { "/git/cmd/git.exe": file(""), "/git/bin/bash.exe": file("") },
      { env: { Path: "/other;/git/cmd" } }
    );

    const bash = await shells.resolve("bash");

    const invocation = bash.invocation(SCRIPT);
    expect(new Path(invocation.command).equals(new Path("/git/bin/bash.exe"))).toBe(true);
    expect(invocation.args).toEqual([
      "--noprofile",
      "--norc",
      "-eo",
      "pipefail",
      SCRIPT.toString(),
    ]);
    expect(bash.extension).toBe(".sh");
  });

  it("falls back to the usual install locations when git is not on PATH", async () => {
    const shells = resolver(
      { "/local/Programs/Git/bin/bash.exe": file("") },
      { env: { LOCALAPPDATA: "/local", PATH: "/nothing" } }
    );

    const bash = await shells.resolve("bash");

    expect(
      new Path(bash.invocation(SCRIPT).command).equals(new Path("/local/Programs/Git/bin/bash.exe"))
    ).toBe(true);
  });

  it("never settles for WSL's bash, and says what to do instead", async () => {
    const shells = resolver(
      { "/windows/system32/bash.exe": file("") },
      { env: { PATH: "/windows/system32" } }
    );

    const error = await shells.resolve("bash").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShellUnavailableError);
    expect((error as Error).message).toMatch(/Git for Windows/);
    expect((error as Error).message).toMatch(/paths\.bash/);
  });

  it("uses paths.bash over any search", async () => {
    const shells = resolver(
      { "/custom/bash.exe": file(""), "/git/cmd/git.exe": file(""), "/git/bin/bash.exe": file("") },
      { env: { PATH: "/git/cmd" }, bashOverride: () => "/custom/bash.exe" }
    );

    const bash = await shells.resolve("bash");

    expect(new Path(bash.invocation(SCRIPT).command).equals(new Path("/custom/bash.exe"))).toBe(
      true
    );
  });

  it("reports a paths.bash that does not exist rather than searching past it", async () => {
    const shells = resolver(
      { "/git/cmd/git.exe": file(""), "/git/bin/bash.exe": file("") },
      { env: { PATH: "/git/cmd" }, bashOverride: () => "/gone/bash.exe" }
    );

    await expect(shells.resolve("bash")).rejects.toThrow(/paths\.bash points at/);
  });

  it("finds a Git Bash installed after a failed lookup", async () => {
    const fileSystem = createFileSystemMock({ entries: { "/pf": directory() } });
    const shells = createShellResolver({
      fileSystem,
      platform: "win32",
      env: { ProgramFiles: "/pf" },
      bashOverride: () => null,
    });
    await expect(shells.resolve("bash")).rejects.toBeInstanceOf(ShellUnavailableError);

    await fileSystem.mkdir(new Path("/pf/Git/bin"));
    await fileSystem.writeFile(new Path("/pf/Git/bin/bash.exe"), "");

    await expect(shells.resolve("bash")).resolves.toMatchObject({ name: "bash" });
  });
});

describe("bash elsewhere", () => {
  it("runs the bash on PATH", async () => {
    const bash = await resolver({}, { platform: "linux" }).resolve("bash");

    expect(bash.invocation(SCRIPT).command).toBe("bash");
  });
});

describe("powershell", () => {
  it("prefers pwsh on PATH", async () => {
    const shells = resolver({ "/ps7/pwsh.exe": file("") }, { env: { PATH: "/ps7" } });

    const ps = await shells.resolve("powershell");

    expect(new Path(ps.invocation(SCRIPT).command).equals(new Path("/ps7/pwsh.exe"))).toBe(true);
    expect(ps.invocation(SCRIPT).args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT.toNative(),
    ]);
    expect(ps.extension).toBe(".ps1");
  });

  it("falls back to Windows PowerShell on Windows", async () => {
    const ps = await resolver({}, { env: { PATH: "/nothing" } }).resolve("powershell");

    expect(ps.invocation(SCRIPT).command).toBe("powershell.exe");
  });

  it("is unavailable off Windows without pwsh", async () => {
    await expect(resolver({}, { platform: "linux" }).resolve("powershell")).rejects.toThrow(/pwsh/);
  });
});

describe("cmd", () => {
  it("runs through the verbatim cmd /c form, with echo off", async () => {
    const cmd = await resolver({}).resolve("cmd");

    const invocation = cmd.invocation(new Path("/tmp/run dir/abc.cmd"));
    expect(invocation.shell).toBe(true);
    expect(invocation.command).toBe(`"${new Path("/tmp/run dir/abc.cmd").toNative()}"`);
    expect(cmd.prelude).toMatch(/^@echo off/);
  });

  it("only exists on Windows", async () => {
    await expect(resolver({}, { platform: "darwin" }).resolve("cmd")).rejects.toThrow(
      /platform: windows/
    );
  });
});
