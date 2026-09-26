/**
 * Which program runs a plugin script, per shell and platform.
 *
 * A plugin names its shell (`bash`, `powershell`, `cmd`) rather than relying on
 * a shebang, so one script means the same thing on every machine. The script
 * body is written to a temp file and run the way GitHub Actions runs a `run:`
 * step for that shell, so the flags are the ones people already expect:
 *
 * - `bash`: `bash --noprofile --norc -eo pipefail <file>`. On Windows that is
 *   Git Bash — `paths.bash` when set, else the one next to `git.exe` on PATH,
 *   else the usual install locations (the probe list VS Code's terminal
 *   profiles use). Never WSL's `System32\bash.exe`: it runs in a Linux VM that
 *   sees none of our paths or environment, so a script would half-work there.
 * - `powershell`: `pwsh` when it is on PATH (PowerShell 7, on any OS), else
 *   Windows PowerShell 5.1 on Windows, with `-NoProfile -NonInteractive
 *   -ExecutionPolicy Bypass -File <file>`.
 * - `cmd`: `cmd /d /s /c <file>`, Windows only.
 *
 * A shell that cannot be found is an error for the plugin that asked for it,
 * never a silent fallback to another shell.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { Path } from "../../utils/path/path";

// =============================================================================
// Types
// =============================================================================

export const SHELL_NAMES = ["bash", "powershell", "cmd"] as const;

export type ShellName = (typeof SHELL_NAMES)[number];

/** How to start one script file. */
export interface ShellInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Run `command` as a shell command line (cmd only). cmd.exe re-parses its
   * command line itself, so a script path has to reach it through the process
   * runner's verbatim `cmd /d /s /c` form rather than as an escaped argument.
   */
  readonly shell?: boolean;
}

/** A shell found on this machine. */
export interface ResolvedShell {
  readonly name: ShellName;
  /** Extension the script file needs for this shell to run it. */
  readonly extension: string;
  /** Prepended to the script body (cmd echoes every line to stdout otherwise). */
  readonly prelude: string;
  invocation(script: Path): ShellInvocation;
}

/** The shell a plugin asked for is not available here. */
export class ShellUnavailableError extends Error {
  constructor(
    readonly shell: ShellName,
    message: string
  ) {
    super(message);
    this.name = "ShellUnavailableError";
  }
}

export interface ShellResolverDeps {
  readonly fileSystem: Pick<FileSystemBoundary, "realpath">;
  readonly platform: NodeJS.Platform;
  /** The environment to search: PATH, and the Windows install roots. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `paths.bash`: an explicit bash, read at each resolution so an edit applies live. */
  readonly bashOverride: () => string | null;
}

export interface ShellResolver {
  /** Find a shell, or throw `ShellUnavailableError` saying what to install or set. */
  resolve(shell: ShellName): Promise<ResolvedShell>;
}

// =============================================================================
// Invocations
// =============================================================================

function bashShell(program: string, platform: NodeJS.Platform): ResolvedShell {
  return {
    name: "bash",
    extension: ".sh",
    prelude: "",
    invocation: (script) => ({
      command: program,
      // Forward slashes: MSYS bash reads `C:/x/y.sh` as a Windows path, while
      // backslashes are escape characters to it.
      args: [
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        platform === "win32" ? script.toString() : script.toNative(),
      ],
    }),
  };
}

function powershellShell(program: string): ResolvedShell {
  return {
    name: "powershell",
    extension: ".ps1",
    prelude: "",
    invocation: (script) => ({
      command: program,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script.toNative(),
      ],
    }),
  };
}

const CMD_SHELL: ResolvedShell = {
  name: "cmd",
  extension: ".cmd",
  // Without it cmd prints every command it runs to stdout, which is the result
  // channel. `@` keeps the line itself quiet too.
  prelude: "@echo off\r\n",
  invocation: (script) => ({
    // A temp path from us: quoted for spaces, and it never contains a `"`.
    command: `"${script.toNative()}"`,
    args: [],
    shell: true,
  }),
};

// =============================================================================
// Search
// =============================================================================

function envValue(env: ShellResolverDeps["env"], name: string): string | undefined {
  // Windows env names are case-insensitive (`Path`, `PATH`), and so is our lookup.
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === "" ? undefined : value;
}

/**
 * Where Git for Windows is usually installed, in the order VS Code probes them.
 * Each is a Git root: `bin\bash.exe` under it is the login-shell wrapper that
 * sets up MSYS's own PATH, which the bare `usr\bin\bash.exe` does not.
 */
function gitInstallRoots(env: ShellResolverDeps["env"]): string[] {
  const roots: string[] = [];
  for (const variable of ["ProgramW6432", "ProgramFiles", "ProgramFiles(X86)"]) {
    const base = envValue(env, variable);
    if (base !== undefined) roots.push(`${base}\\Git`);
  }
  const localAppData = envValue(env, "LocalAppData");
  if (localAppData !== undefined) roots.push(`${localAppData}\\Programs\\Git`);
  const userProfile = envValue(env, "UserProfile");
  if (userProfile !== undefined) {
    roots.push(`${userProfile}\\scoop\\apps\\git\\current`);
    roots.push(`${userProfile}\\scoop\\apps\\git-with-openssh\\current`);
  }
  return roots;
}

/** WSL's launcher. It answers to `bash`, and it is never what a plugin means. */
function isWslBash(path: Path): boolean {
  return /[\\/]system32[\\/]bash\.exe$/i.test(path.toNative());
}

// =============================================================================
// Resolver
// =============================================================================

export function createShellResolver(deps: ShellResolverDeps): ShellResolver {
  const isWindows = deps.platform === "win32";
  const pathDelimiter = isWindows ? ";" : ":";

  async function exists(path: Path): Promise<boolean> {
    try {
      await deps.fileSystem.realpath(path);
      return true;
    } catch {
      return false;
    }
  }

  /** The first `name` in a PATH directory, as the OS would pick it. */
  async function findOnPath(name: string): Promise<Path | undefined> {
    const dirs = (envValue(deps.env, "PATH") ?? "").split(pathDelimiter).filter((d) => d !== "");
    for (const dir of dirs) {
      let candidate: Path;
      try {
        candidate = new Path(dir.replace(/^"(.*)"$/, "$1"), name);
      } catch {
        continue; // A relative PATH entry: the OS resolves it against a cwd we do not share.
      }
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }

  async function findGitBash(): Promise<Path | undefined> {
    const roots: Path[] = [];
    // git on PATH is `<root>\cmd\git.exe` (the default install) or
    // `<root>\bin\git.exe`; either way its root holds the bash we want.
    const git = await findOnPath("git.exe");
    if (git !== undefined) roots.push(git.dirname.dirname);
    for (const root of gitInstallRoots(deps.env)) {
      try {
        roots.push(new Path(root));
      } catch {
        // An install-root variable that is not an absolute path names nothing.
      }
    }

    for (const root of roots) {
      const bash = new Path(root, "bin", "bash.exe");
      if (!isWslBash(bash) && (await exists(bash))) return bash;
    }
    return undefined;
  }

  async function resolveBash(): Promise<ResolvedShell> {
    const override = deps.bashOverride();
    if (override !== null && override !== "") {
      let path: Path;
      try {
        path = new Path(override);
      } catch {
        throw new ShellUnavailableError(
          "bash",
          `paths.bash must be an absolute path, got ${override}.`
        );
      }
      if (!(await exists(path))) {
        throw new ShellUnavailableError(
          "bash",
          `paths.bash points at ${path.toNative()}, which does not exist.`
        );
      }
      return bashShell(path.toNative(), deps.platform);
    }

    if (!isWindows) return bashShell("bash", deps.platform);

    const gitBash = await findGitBash();
    if (gitBash === undefined) {
      throw new ShellUnavailableError(
        "bash",
        "No Git Bash found. Install Git for Windows (https://git-scm.com/download/win), " +
          "or set paths.bash to a bash.exe. WSL's bash is not supported."
      );
    }
    return bashShell(gitBash.toNative(), deps.platform);
  }

  async function resolvePowershell(): Promise<ResolvedShell> {
    const pwsh = await findOnPath(isWindows ? "pwsh.exe" : "pwsh");
    if (pwsh !== undefined) return powershellShell(pwsh.toNative());
    if (isWindows) return powershellShell("powershell.exe");
    throw new ShellUnavailableError(
      "powershell",
      "PowerShell (pwsh) is not on PATH. Install PowerShell 7, or mark this part of the " +
        "plugin `platform: windows`."
    );
  }

  return {
    async resolve(shell: ShellName): Promise<ResolvedShell> {
      switch (shell) {
        case "bash":
          return resolveBash();
        case "powershell":
          return resolvePowershell();
        case "cmd":
          if (!isWindows) {
            throw new ShellUnavailableError(
              "cmd",
              "cmd only exists on Windows. Mark this part of the plugin `platform: windows`."
            );
          }
          return CMD_SHELL;
      }
    },
  };
}
