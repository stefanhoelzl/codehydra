/**
 * The exit code a wrapper reports for a child it ran.
 *
 * A shell reports a child killed by a signal as 128 + the signal number (130
 * for SIGINT, 143 for SIGTERM), and `ch-bg` — an `exec` — does the same. `ch bg`
 * and `ch lock run` are drop-in wrappers, so they must too: a script checking
 * for 130 after Ctrl-C would otherwise see a generic failure.
 */

import { constants as osConstants } from "node:os";

export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
  return 1;
}
