// @vitest-environment node
/**
 * Integration tests for the global `ch` installer, against the behavioral
 * filesystem and process mocks: what ends up on disk, and what it asks the OS
 * to do (PowerShell for the Windows PATH, the macOS administrator prompt).
 */

import { describe, it, expect } from "vitest";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { FileSystemError } from "../../shared/errors/service-errors";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { Path } from "../../utils/path/path";
import { CliInstallError, GlobalCliInstaller, MARKER } from "./installer";

const HOME = "/home/me";
const BIN = "/data/bin";
const WIN_DIR = "/data/cli-global";
const LINUX_TARGET = "/home/me/.local/bin/ch";
const MAC_TARGET = "/usr/local/bin/ch";

function setup(options: {
  platform: NodeJS.Platform;
  pathEnv?: string;
  entries?: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>;
  exitCode?: number;
  /** Make every write fail as a folder the user may not write to would. */
  readOnly?: boolean;
}) {
  const fileSystem = createFileSystemMock({
    entries: { [BIN]: directory(), ...(options.entries ?? {}) },
  });
  const processRunner = createMockProcessRunner({
    defaultResult: { exitCode: options.exitCode ?? 0 },
  });
  const denied = async (): Promise<never> => {
    throw new FileSystemError("EACCES", MAC_TARGET, "Permission denied");
  };
  const fs: FileSystemBoundary = options.readOnly
    ? { ...fileSystem, writeFile: denied, unlink: denied }
    : fileSystem;
  const installer = new GlobalCliInstaller({
    platform: options.platform,
    homeDir: HOME,
    binDir: new Path(BIN),
    windowsDir: new Path(WIN_DIR),
    pathEnv: options.pathEnv ?? "/usr/bin",
    fileSystem: fs,
    processRunner,
  });
  return { installer, fileSystem, processRunner };
}

/** The `-Command` script of a PowerShell run. */
function powerShellScript(runner: ReturnType<typeof createMockProcessRunner>, index = 0): string {
  const spawned = runner.$.spawned(index).$;
  expect(spawned.command).toBe("powershell.exe");
  return spawned.args[spawned.args.length - 1] ?? "";
}

describe("GlobalCliInstaller", () => {
  describe("Linux", () => {
    it("installs a forwarding script in ~/.local/bin", async () => {
      const { installer, fileSystem } = setup({
        platform: "linux",
        pathEnv: "/usr/bin:/home/me/.local/bin",
      });

      const result = await installer.install({ interactive: true });

      expect(result).toEqual({ location: LINUX_TARGET });
      expect(fileSystem).toHaveFileContaining(LINUX_TARGET, MARKER);
      expect(fileSystem).toHaveFileContaining(LINUX_TARGET, `exec '${BIN}/ch' "$@"`);
    });

    it("tells the user when ~/.local/bin is not on PATH", async () => {
      const { installer } = setup({ platform: "linux", pathEnv: "/usr/bin" });

      const result = await installer.install({ interactive: true });

      expect(result.hint).toContain("/home/me/.local/bin is not on your PATH");
    });

    it("leaves a ch it did not install alone", async () => {
      const { installer, fileSystem } = setup({
        platform: "linux",
        entries: { "/home/me/.local/bin": directory(), [LINUX_TARGET]: file("#!/bin/sh\nmine\n") },
      });

      await expect(installer.install({ interactive: true })).rejects.toBeInstanceOf(
        CliInstallError
      );
      await installer.uninstall({ interactive: true });

      expect(fileSystem).toHaveFile(LINUX_TARGET, "#!/bin/sh\nmine\n");
    });

    it("uninstalls what it installed", async () => {
      const { installer, fileSystem } = setup({ platform: "linux" });
      await installer.install({ interactive: true });

      await installer.uninstall({ interactive: true });

      expect(fileSystem.$.entries.has(new Path(LINUX_TARGET).toString())).toBe(false);
    });
  });

  describe("Windows", () => {
    it("writes ch.cmd and ch into its own folder and adds that folder to the user's PATH", async () => {
      const { installer, fileSystem, processRunner } = setup({ platform: "win32" });

      await installer.install({ interactive: true });

      expect(fileSystem).toHaveFileContaining(`${WIN_DIR}/ch.cmd`, MARKER);
      expect(fileSystem).toHaveFileContaining(`${WIN_DIR}/ch.cmd`, 'ch.cmd" %*');
      expect(fileSystem).toHaveFileContaining(`${WIN_DIR}/ch`, MARKER);
      // Only ch: the folder with CodeHydra's `code` is never put on PATH.
      expect(fileSystem.$.entries.has(new Path(`${WIN_DIR}/code.cmd`).toString())).toBe(false);
      const script = powerShellScript(processRunner);
      expect(script).toContain(`$dir = '${new Path(WIN_DIR).toNative()}'`);
      expect(script).toContain("$parts += $dir");
      expect(script).toContain("DoNotExpandEnvironmentNames");
    });

    it("removes the folder from PATH and deletes it on uninstall", async () => {
      const { installer, fileSystem, processRunner } = setup({ platform: "win32" });
      await installer.install({ interactive: true });

      await installer.uninstall({ interactive: true });

      const script = powerShellScript(processRunner, 1);
      expect(script).not.toContain("$parts += $dir");
      expect(fileSystem.$.entries.has(new Path(WIN_DIR).toString())).toBe(false);
    });

    it("fails when the PATH cannot be updated", async () => {
      const { installer } = setup({ platform: "win32", exitCode: 1 });

      await expect(installer.install({ interactive: true })).rejects.toBeInstanceOf(
        CliInstallError
      );
    });
  });

  describe("macOS", () => {
    it("installs into /usr/local/bin directly when it may", async () => {
      const { installer, fileSystem, processRunner } = setup({ platform: "darwin" });

      await installer.install({ interactive: true });

      expect(fileSystem).toHaveFileContaining(MAC_TARGET, MARKER);
      expect(processRunner.$.spawnedCount).toBe(0);
    });

    it("asks for administrator access when /usr/local/bin is not writable", async () => {
      const { installer, processRunner } = setup({ platform: "darwin", readOnly: true });

      await installer.install({ interactive: true });

      const spawned = processRunner.$.spawned(0).$;
      expect(spawned.command).toBe("osascript");
      expect(spawned.args.join(" ")).toContain("with administrator privileges");
    });

    it("never shows the administrator prompt without the user there (startup)", async () => {
      const { installer, processRunner } = setup({ platform: "darwin", readOnly: true });

      await expect(installer.install({ interactive: false })).rejects.toThrow();
      expect(processRunner.$.spawnedCount).toBe(0);
    });

    it("reports a declined administrator prompt", async () => {
      const { installer } = setup({ platform: "darwin", readOnly: true, exitCode: 1 });

      await expect(installer.install({ interactive: true })).rejects.toBeInstanceOf(
        CliInstallError
      );
    });
  });
});
