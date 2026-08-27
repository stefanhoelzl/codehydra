/**
 * The CLI's view of the operation vocabulary.
 *
 * Exhaustive: a new operation fails to compile until this file says what it is
 * called on the command line. Paths are chosen for the command line rather than
 * derived from operation names — `ws` reads better than `workspace` in something
 * typed all day, and nesting differs from the domain's grouping.
 */

import type { OperationName } from "../names";
import type { InputShaping } from "../registry";

export interface CliMapping extends InputShaping {
  /** Subcommand path, e.g. `["ws", "delete"]` for `ch ws delete`. */
  readonly path: readonly string[];
  /** Positional arguments, in order, mapped onto input fields. */
  readonly positionals?: readonly string[];
}

export const CLI_MAP: Readonly<Record<OperationName, CliMapping | null>> = {
  "workspace.status": { path: ["ws", "status"] },
  "workspace.hibernate": { path: ["ws", "hibernate"] },
  "workspace.wake": { path: ["ws", "wake"] },
  "workspace.create": { path: ["ws", "create"], positionals: ["name", "base"] },
  "workspace.delete": { path: ["ws", "delete"] },
  "workspace.switch": { path: ["ws", "switch"], positionals: ["workspace"] },
  "workspace.title": { path: ["ws", "title"], positionals: ["title"] },
  "workspace.tag.list": { path: ["ws", "tag", "ls"] },
  "workspace.tag.set": { path: ["ws", "tag", "set"], positionals: ["name"] },
  "workspace.tag.remove": { path: ["ws", "tag", "rm"], positionals: ["name"] },

  "metadata.get": { path: ["ws", "metadata", "get"] },
  "metadata.set": { path: ["ws", "metadata", "set"], positionals: ["key", "value"] },

  "agent.session": { path: ["ws", "agent", "session"] },
  "agent.restart": { path: ["ws", "agent", "restart"] },
  "agent.open": { path: ["ws", "agent", "open"] },
  "agent.close": { path: ["ws", "agent", "close"] },
  // Nests under the status command: `ch ws status` reads it, `ch ws status set`
  // reports it. Resolution is longest-path so the two never collide.
  "agent.status.set": { path: ["ws", "status", "set"], positionals: ["status"] },
  // Only the sidekick can witness the terminal event this reports.
  "agent.lifecycle": null,

  "vscode.command": { path: ["ws", "vscode-command"], positionals: ["command"] },
  // Split into the three forms below, which is the whole point of having them.
  "vscode.message": null,
  "vscode.notify": { path: ["ws", "notify"], positionals: ["message"] },
  "vscode.status-bar": { path: ["ws", "status-bar"], positionals: ["message"] },
  "vscode.ask": { path: ["ws", "ask"], positionals: ["message"] },
  "vscode.browser": { path: ["ws", "browser"], positionals: ["url"] },
  "vscode.diff": { path: ["ws", "diff"], positionals: ["left", "right"] },
  "vscode.goto": { path: ["ws", "goto"], positionals: ["location"] },
  "vscode.preview": { path: ["ws", "preview"], positionals: ["path"] },
  "system.open": { path: ["ws", "open"], positionals: ["path"] },

  "project.list": { path: ["project", "list"] },
  "project.open": { path: ["project", "open"], positionals: ["target"] },
  "project.close": { path: ["project", "close"], positionals: ["project"] },
  log: { path: ["log"], positionals: ["level", "message"] },
  "report.issue": { path: ["report-issue"], positionals: ["description"] },
};

/** Anything carrying a subcommand path can be resolved against argv. */
export interface HasPath {
  readonly path: readonly string[];
}

/**
 * Resolve an argv prefix to whichever candidate owns it, longest path first.
 *
 * Longest-first matters because paths nest: `ws status` and `ws status set` both
 * exist, and a shortest-first match would route `ch ws status set busy` to the
 * read command with a stray argument.
 *
 * Generic over the candidate so the `ch` binary can resolve against the
 * descriptors the running app sent it, using this same rule.
 */
export function resolvePath<T extends HasPath>(
  candidates: readonly T[],
  argv: readonly string[]
): { readonly match: T; readonly rest: readonly string[] } | undefined {
  const longest = candidates.reduce((max, c) => Math.max(max, c.path.length), 0);

  for (let depth = Math.min(argv.length, longest); depth > 0; depth--) {
    const prefix = argv.slice(0, depth).join(" ");
    const match = candidates.find((c) => c.path.join(" ") === prefix);
    if (match) return { match, rest: argv.slice(depth) };
  }
  return undefined;
}

/** Resolve against the static map. Used by tests and anything in-process. */
export function resolveCliPath(
  argv: readonly string[]
): { name: OperationName; mapping: CliMapping; rest: readonly string[] } | undefined {
  const candidates = (Object.entries(CLI_MAP) as [OperationName, CliMapping | null][])
    .filter(([, mapping]) => mapping !== null)
    .map(([name, mapping]) => ({ name, mapping: mapping!, path: mapping!.path }));

  const resolved = resolvePath(candidates, argv);
  if (!resolved) return undefined;
  return { name: resolved.match.name, mapping: resolved.match.mapping, rest: resolved.rest };
}
