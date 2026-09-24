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
import { TARGET_FIELD_NAMES } from "../entries/target";

export interface CliMapping extends InputShaping {
  /** Subcommand path, e.g. `["ws", "delete"]` for `ch ws delete`. */
  readonly path: readonly string[];
  /** Positional arguments, in order, mapped onto input fields. */
  readonly positionals?: readonly string[];
  /**
   * Callable but left out of `ch --help`: plumbing for a built-in, not a
   * command anyone should type. `lock hold` exists for `ch lock run`, and
   * typed by hand it would release the moment `ch` exits.
   */
  readonly hidden?: boolean;
  /**
   * The result is a document: printed as-is rather than as JSON when stdout is
   * not a TTY, since the reader that is never a TTY — an agent — is the one it
   * is for. `--format json` still forces JSON.
   */
  readonly text?: boolean;
  /**
   * A string field that reads standard input when its value is `-`, so text
   * that is long or awkward to quote can be piped in (`… | ch ws agent message -`).
   */
  readonly stdin?: string;
}

/**
 * For an entry that can act on another workspace: its own `workspace` /
 * `project` fields are dropped, because the CLI's global `--workspace` and
 * `--project` name the target for the whole connection — one spelling for
 * every command, and a name resolved the same way everywhere.
 */
const TARGETED = { omit: TARGET_FIELD_NAMES } as const;

export const CLI_MAP: Readonly<Record<OperationName, CliMapping | null>> = {
  "workspace.status": { ...TARGETED, path: ["ws", "status"] },
  "workspace.hibernate": { ...TARGETED, path: ["ws", "hibernate"] },
  "workspace.wake": { ...TARGETED, path: ["ws", "wake"] },
  "workspace.create": { path: ["ws", "create"], positionals: ["name", "base"] },
  "workspace.delete": { ...TARGETED, path: ["ws", "delete"] },
  "workspace.switch": { path: ["ws", "switch"], positionals: ["workspace"] },
  "workspace.title": { ...TARGETED, path: ["ws", "title"], positionals: ["title"] },
  "workspace.tag.list": { ...TARGETED, path: ["ws", "tag", "ls"] },
  "workspace.tag.set": { ...TARGETED, path: ["ws", "tag", "set"], positionals: ["name"] },
  "workspace.tag.remove": { ...TARGETED, path: ["ws", "tag", "rm"], positionals: ["name"] },

  "metadata.get": { ...TARGETED, path: ["ws", "metadata", "get"] },
  "metadata.set": { ...TARGETED, path: ["ws", "metadata", "set"], positionals: ["key", "value"] },

  "agent.session": { ...TARGETED, path: ["ws", "agent", "session"] },
  "agent.restart": { ...TARGETED, path: ["ws", "agent", "restart"] },
  "agent.open": { ...TARGETED, path: ["ws", "agent", "open"] },
  "agent.close": { ...TARGETED, path: ["ws", "agent", "close"] },
  "agent.message": {
    ...TARGETED,
    path: ["ws", "agent", "message"],
    positionals: ["text"],
    stdin: "text",
  },
  // Nests under the status command: `ch ws status` reads it, `ch ws status set`
  // reports it. Resolution is longest-path so the two never collide.
  "agent.status.set": { ...TARGETED, path: ["ws", "status", "set"], positionals: ["status"] },
  // Only the sidekick can witness the terminal event this reports.
  "agent.lifecycle": null,

  "vscode.command": { ...TARGETED, path: ["ws", "vscode-command"], positionals: ["command"] },
  // Split into the three forms below, which is the whole point of having them.
  "vscode.message": null,
  "vscode.notify": { ...TARGETED, path: ["ws", "notify"], positionals: ["message"] },
  "vscode.status-bar": { ...TARGETED, path: ["ws", "status-bar"], positionals: ["message"] },
  "vscode.ask": { ...TARGETED, path: ["ws", "ask"], positionals: ["message"] },
  "vscode.browser": { ...TARGETED, path: ["ws", "browser"], positionals: ["url"] },
  "vscode.diff": { ...TARGETED, path: ["ws", "diff"], positionals: ["left", "right"] },
  "vscode.goto": { ...TARGETED, path: ["ws", "goto"], positionals: ["location"] },
  "vscode.preview": { ...TARGETED, path: ["ws", "preview"], positionals: ["path"] },
  "system.open": { path: ["ws", "open"], positionals: ["path"] },
  "notification.show": { ...TARGETED, path: ["notification", "show"], positionals: ["title"] },
  "notification.close": { path: ["notification", "close"], positionals: ["id"] },

  "project.list": { path: ["project", "list"] },
  "project.open": { path: ["project", "open"], positionals: ["target"] },
  "project.close": { path: ["project", "close"], positionals: ["project"] },
  "lock.take": { path: ["lock", "take"], positionals: ["name", "reason"] },
  "lock.release": { path: ["lock", "release"], positionals: ["name"] },
  "lock.list": { path: ["lock", "ls"] },
  "lock.hold": { path: ["lock", "hold"], positionals: ["name", "reason"], hidden: true },
  "config.get": { path: ["config", "get"], positionals: ["key"] },
  "config.list": { path: ["config", "list"] },
  "config.set": { path: ["config", "set"], positionals: ["key", "value"] },
  "config.reset": { path: ["config", "reset"], positionals: ["key"] },
  log: { path: ["log"], positionals: ["level", "message"] },
  "report.issue": { path: ["report-issue"], positionals: ["description"] },
  guide: { path: ["guide"], positionals: ["section"], text: true },
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
