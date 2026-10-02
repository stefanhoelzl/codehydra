/**
 * Quoting for running a Windows `.cmd` shim (what npm installs) through cmd.exe.
 *
 * Pure and dependency-free: the app (runAgentBinary) and the agent launchers
 * bundled into `ch.cjs` (`ch claude`, `ch opencode`) share it.
 *
 * Node refuses to spawn a `.cmd` directly, so it has to go through
 * `shell: true`. Node then joins the file and args with single spaces and
 * wraps the whole line in ONE outer pair of quotes (`cmd /d /s /c "<line>"`),
 * which `/s` strips again — it does not quote the parts individually. Any part
 * containing a space (an install path under `C:\Users\Jane Doe`, a prompt
 * "hello world") is therefore re-split by cmd.exe unless it is quoted here,
 * every part, not only the executable.
 */

/**
 * Quote one part of a cmd.exe command line: wrap it in double quotes and
 * double any embedded quote, so cmd.exe keeps it one token and the shim's
 * program reads the quote back as a literal.
 */
export function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * The command line that runs `executable` (a `.cmd` shim) with `args` under
 * `shell: true`: every part quoted, joined by spaces. Pass it as the command,
 * with no separate args.
 */
export function cmdCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteForCmd).join(" ");
}

/** Whether `executable` is a `.cmd` shim, which only a shell can run on Windows. */
export function needsCmdShell(executable: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && executable.toLowerCase().endsWith(".cmd");
}
