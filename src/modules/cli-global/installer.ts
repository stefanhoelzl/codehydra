/**
 * Making `ch` a command every shell finds — and taking it away again.
 *
 * `ch` itself lives in `<dataRoot>/bin`, beside CodeHydra's own `code` and
 * `ch-bg`. Putting that folder on PATH would make CodeHydra's `code` shadow the
 * user's VS Code, so what is installed is a small forwarding script that runs
 * `<dataRoot>/bin/ch` and exposes nothing else:
 *
 * - Windows: `ch.cmd` (cmd, PowerShell) and `ch` (Git Bash) in
 *   `<dataRoot>/cli-global`, and that folder appended to the user's PATH —
 *   per-user, no admin rights. Only shells started afterwards see it.
 * - Linux: `~/.local/bin/ch`, the per-user folder most distributions already
 *   have on PATH. Not on PATH → still installed, and the caller is told.
 * - macOS: `/usr/local/bin/ch`, which is on PATH by default. When that folder
 *   is not writable by the user, the system's administrator prompt is shown
 *   (only when the user asked for the change, never at startup).
 *
 * A forwarding script rather than a symlink: the `ch` wrapper finds `ch.cjs`
 * next to itself, which a symlink would point at the link's folder instead.
 *
 * Every installed file carries MARKER, and only a file carrying it is ever
 * replaced or removed, so a `ch` the user put there is left alone.
 */

import { dirname } from "node:path";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import { Path } from "../../utils/path/path";
import { errorCode, isEnoent } from "../../shared/error-utils";

/** Found in every file this installer writes, and nowhere else. */
export const MARKER = "Installed by CodeHydra (setting cli.install-global)";

export interface InstallerDeps {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  /** `<dataRoot>/bin`, where the real `ch` lives. */
  readonly binDir: Path;
  /** `<dataRoot>/cli-global`, the Windows PATH folder. */
  readonly windowsDir: Path;
  /** The PATH the app runs with, to tell whether the Linux folder is on it. */
  readonly pathEnv: string;
  readonly fileSystem: FileSystemBoundary;
  readonly processRunner: ProcessRunner;
}

export interface InstallOptions {
  /**
   * Whether the user is there to answer the administrator prompt (macOS).
   * At startup the install only repairs what it can do without one.
   */
  readonly interactive: boolean;
}

export interface InstallResult {
  /** Where the command was installed. */
  readonly location: string;
  /** Something the user has to do for it to work (the folder is not on PATH). */
  readonly hint?: string;
}

/** Raised for a failure worth showing the user as it is. */
export class CliInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInstallError";
  }
}

/** Quote a value for a POSIX shell: single quotes, embedded ones closed and escaped. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value inside a PowerShell single-quoted string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shScript(target: string): string {
  return `#!/bin/sh\n# ${MARKER}\nexec ${shQuote(target)} "$@"\n`;
}

function cmdScript(target: string): string {
  return `@echo off\r\nrem ${MARKER}\r\n"${target}" %*\r\n`;
}

/**
 * PowerShell that adds `dir` to, or removes it from, the user's PATH.
 *
 * Read and written raw (`DoNotExpandEnvironmentNames`, same value kind) so
 * entries like `%USERPROFILE%\bin` survive; the dummy variable is the
 * supported way to have Windows tell running programs (Explorer) that the
 * environment changed, so shells started from them see the new PATH.
 */
function pathScript(dir: string, add: boolean): string {
  return [
    `$dir = ${psQuote(dir)}`,
    `$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')`,
    `$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`,
    `$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }`,
    `$parts = @($raw -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\\') -ne $dir.TrimEnd('\\') })`,
    add ? `$parts += $dir` : ``,
    `$new = $parts -join ';'`,
    `if ($new -cne $raw) {`,
    `  if ($new -eq '') { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $new, $kind) }`,
    `  [Environment]::SetEnvironmentVariable('CODEHYDRA_PATH_REFRESH', '1', 'User')`,
    `  [Environment]::SetEnvironmentVariable('CODEHYDRA_PATH_REFRESH', $null, 'User')`,
    `}`,
    `$key.Close()`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export class GlobalCliInstaller {
  constructor(private readonly deps: InstallerDeps) {}

  /** Install (or repair) the global command. Safe to run when it is already there. */
  async install(options: InstallOptions): Promise<InstallResult> {
    switch (this.deps.platform) {
      case "win32":
        return this.installWindows();
      case "darwin":
        return this.installUnix(new Path("/usr/local/bin/ch"), options);
      default:
        return this.installUnix(this.linuxTarget(), options);
    }
  }

  /** Remove the global command, if it is the one this installer wrote. */
  async uninstall(options: InstallOptions): Promise<void> {
    switch (this.deps.platform) {
      case "win32":
        return this.uninstallWindows();
      case "darwin":
        return this.uninstallUnix(new Path("/usr/local/bin/ch"), options);
      default:
        return this.uninstallUnix(this.linuxTarget(), options);
    }
  }

  private linuxTarget(): Path {
    return new Path(this.deps.homeDir, ".local", "bin", "ch");
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  private async installWindows(): Promise<InstallResult> {
    const { fileSystem, windowsDir, binDir } = this.deps;
    await fileSystem.mkdir(windowsDir);
    await this.writeIfChanged(
      new Path(windowsDir, "ch.cmd"),
      cmdScript(new Path(binDir, "ch.cmd").toNative())
    );
    // Git Bash finds `ch` by this name; its path in the form it understands.
    await this.writeIfChanged(
      new Path(windowsDir, "ch"),
      shScript(new Path(binDir, "ch").toString())
    );
    await this.runPowerShell(pathScript(windowsDir.toNative(), true));
    return { location: windowsDir.toNative() };
  }

  private async uninstallWindows(): Promise<void> {
    const { fileSystem, windowsDir } = this.deps;
    await this.runPowerShell(pathScript(windowsDir.toNative(), false));
    // The folder is ours alone; nothing in it is the user's.
    await fileSystem.rm(windowsDir, { recursive: true, force: true });
  }

  private async runPowerShell(script: string): Promise<void> {
    const result = await this.deps.processRunner
      .run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ])
      .wait();
    if (result.exitCode !== 0) {
      throw new CliInstallError(
        `Could not update your PATH (PowerShell exited with ${String(result.exitCode)}): ${result.stderr.trim()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // macOS / Linux
  // ---------------------------------------------------------------------------

  private async installUnix(target: Path, options: InstallOptions): Promise<InstallResult> {
    const content = shScript(new Path(this.deps.binDir, "ch").toString());
    const current = await this.readOrNull(target);
    if (current !== null && !current.includes(MARKER)) {
      throw new CliInstallError(
        `${target.toString()} already exists and was not installed by CodeHydra; remove it first.`
      );
    }

    if (current !== content) {
      try {
        await this.deps.fileSystem.mkdir(new Path(dirname(target.toString())));
        await this.deps.fileSystem.writeFile(target, content);
        await this.deps.fileSystem.makeExecutable(target);
      } catch (error) {
        if (!this.needsAdmin(error, options)) throw error;
        await this.asAdmin(
          `mkdir -p ${shQuote(dirname(target.toString()))} && ` +
            `printf '%s' ${shQuote(content)} > ${shQuote(target.toString())} && ` +
            `chmod 755 ${shQuote(target.toString())}`
        );
      }
    }

    const folder = dirname(target.toString());
    const onPath = this.deps.pathEnv
      .split(":")
      .some((entry) => entry.replace(/\/+$/, "") === folder);
    return onPath
      ? { location: target.toString() }
      : {
          location: target.toString(),
          hint: `${folder} is not on your PATH. Add it in your shell's startup file (e.g. export PATH="${folder}:$PATH" in ~/.profile).`,
        };
  }

  private async uninstallUnix(target: Path, options: InstallOptions): Promise<void> {
    const current = await this.readOrNull(target);
    if (current === null || !current.includes(MARKER)) return;
    try {
      await this.deps.fileSystem.unlink(target);
    } catch (error) {
      if (!this.needsAdmin(error, options)) throw error;
      await this.asAdmin(`rm -f ${shQuote(target.toString())}`);
    }
  }

  /** Only macOS escalates, and only with the user there to answer. */
  private needsAdmin(error: unknown, options: InstallOptions): boolean {
    const code = errorCode(error);
    return (
      this.deps.platform === "darwin" &&
      options.interactive &&
      (code === "EACCES" || code === "EPERM")
    );
  }

  /** Run a shell command through the macOS administrator prompt. */
  private async asAdmin(command: string): Promise<void> {
    const appleScript = `do shell script ${JSON.stringify(command)} with administrator privileges`;
    const result = await this.deps.processRunner.run("osascript", ["-e", appleScript]).wait();
    if (result.exitCode !== 0) {
      throw new CliInstallError(
        "Administrator access was not granted, so /usr/local/bin could not be changed."
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  private async readOrNull(path: Path): Promise<string | null> {
    try {
      return await this.deps.fileSystem.readFile(path);
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private async writeIfChanged(path: Path, content: string): Promise<void> {
    if ((await this.readOrNull(path)) === content) return;
    await this.deps.fileSystem.writeFile(path, content);
    await this.deps.fileSystem.makeExecutable(path);
  }
}
