/**
 * One-time move of a data root to a new location: Windows releases kept their data
 * in `%APPDATA%` (the roaming profile) and now keep it in `%LOCALAPPDATA%`.
 *
 * Runs synchronously at bootstrap, before the logger and `Config.load()` open
 * anything in the data root, so it uses `node:fs` directly (a documented exception,
 * like `Config.load()`: FileSystemBoundary is async-only).
 *
 * Everything moves except source code: `remotes/` and every
 * `projects/<id>/workspaces/` stay where they are, and state.json is told so
 * (`paths.workspaces-current`), because moving a worktree costs its agent
 * conversations, its editor state and its git links. The workspaces-root module
 * then migrates them the way it does for a changed `paths.workspaces` setting.
 *
 * All or nothing: when an entry cannot be moved — typically because an older
 * CodeHydra still runs from the old folder and holds its files open — the
 * entries already moved go back and the old folder stays in use for this run.
 * The next start tries again.
 */

import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { getErrorMessage } from "../../shared/error-utils";

/** Must match the workspaces-root module's `CURRENT_ROOT_STATE_KEY`. */
export const WORKSPACES_CURRENT_STATE_KEY = "paths.workspaces-current";

export type RelocationFs = Pick<
  typeof nodeFs,
  | "existsSync"
  | "readdirSync"
  | "renameSync"
  | "mkdirSync"
  | "cpSync"
  | "rmSync"
  | "rmdirSync"
  | "readFileSync"
  | "writeFileSync"
>;

export type DataRootRelocation =
  | { readonly status: "nothing" }
  | {
      readonly status: "moved";
      readonly from: string;
      readonly to: string;
      /** Whether worktrees or clones stayed behind (the workspaces root now names `from`). */
      readonly sourceCodeKept: boolean;
      /** Things that went wrong after the move committed. */
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly from: string;
      readonly to: string;
      readonly error: string;
    };

interface Move {
  readonly from: string;
  readonly to: string;
}

/**
 * Move the data under `from` to `to`. Does nothing when `from` does not exist or
 * `to` already holds a state.json (the move already happened).
 */
export function relocateDataRoot(
  from: string,
  to: string,
  fs: RelocationFs = nodeFs
): DataRootRelocation {
  if (!fs.existsSync(from) || fs.existsSync(join(to, "state.json"))) {
    return { status: "nothing" };
  }

  const warnings: string[] = [];
  const moves = planMoves(from, to, fs, warnings);
  if (moves.length === 0) return { status: "nothing" };

  const renamed: Move[] = [];
  const copied: Move[] = [];
  const sourceCodeKept = holdsSourceCode(from, fs);
  try {
    for (const move of moves) {
      fs.mkdirSync(dirname(move.to), { recursive: true });
      if (transfer(move, fs) === "renamed") {
        renamed.push(move);
      } else {
        copied.push(move);
      }
    }
    // Inside the transaction: without it the moved state would read "workspaces
    // under the data root" and every existing workspace would silently vanish.
    if (sourceCodeKept) pinWorkspacesRoot(join(to, "state.json"), from, fs);
  } catch (error) {
    for (const move of [...renamed].reverse()) {
      attempt(() => fs.renameSync(move.to, move.from));
    }
    for (const move of copied) {
      attempt(() => fs.rmSync(move.to, { recursive: true, force: true }));
    }
    return { status: "failed", from, to, error: getErrorMessage(error) };
  }

  for (const move of copied) {
    try {
      fs.rmSync(move.from, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Could not delete ${move.from} after copying it: ${getErrorMessage(error)}`);
    }
  }
  pruneEmpty(from, fs);
  return { status: "moved", from, to, sourceCodeKept, warnings };
}

/**
 * What moves, `electron/` first: an older instance still running holds files
 * there open, so the move fails before anything else has been touched.
 */
function planMoves(from: string, to: string, fs: RelocationFs, warnings: string[]): Move[] {
  const moves: Move[] = [];
  const add = (source: string, target: string): void => {
    if (fs.existsSync(target)) {
      warnings.push(`Kept ${source}: ${target} already exists`);
      return;
    }
    moves.push({ from: source, to: target });
  };

  const entries = fs
    .readdirSync(from, { withFileTypes: true })
    .sort((a, b) => Number(b.name === "electron") - Number(a.name === "electron"));
  for (const entry of entries) {
    if (entry.name === "remotes") continue;
    if (entry.name === "projects" && entry.isDirectory()) {
      for (const project of fs.readdirSync(join(from, "projects"), { withFileTypes: true })) {
        const projectDir = join(from, "projects", project.name);
        if (!project.isDirectory()) {
          add(projectDir, join(to, "projects", project.name));
          continue;
        }
        for (const item of fs.readdirSync(projectDir)) {
          if (item === "workspaces") continue;
          add(join(projectDir, item), join(to, "projects", project.name, item));
        }
      }
      continue;
    }
    add(join(from, entry.name), join(to, entry.name));
  }
  return moves;
}

/** Rename, or copy when the folders are on different volumes (a redirected profile). */
function transfer(move: Move, fs: RelocationFs): "renamed" | "copied" {
  try {
    fs.renameSync(move.from, move.to);
    return "renamed";
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
  }
  try {
    fs.cpSync(move.from, move.to, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    attempt(() => fs.rmSync(move.to, { recursive: true, force: true }));
    throw error;
  }
  return "copied";
}

function holdsSourceCode(from: string, fs: RelocationFs): boolean {
  if (fs.existsSync(join(from, "remotes"))) return true;
  const projects = join(from, "projects");
  if (!fs.existsSync(projects)) return false;
  return fs
    .readdirSync(projects, { withFileTypes: true })
    .some(
      (project) =>
        project.isDirectory() && fs.existsSync(join(projects, project.name, "workspaces"))
    );
}

/**
 * Record `from` as the workspaces root in use, unless state.json already names one
 * (the user had moved workspaces elsewhere). An unreadable file starts fresh, as
 * the state service would.
 */
function pinWorkspacesRoot(statePath: string, from: string, fs: RelocationFs): void {
  let state: Record<string, unknown> = {};
  if (fs.existsSync(statePath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        state = parsed as Record<string, unknown>;
      }
    } catch {
      // invalid JSON: start fresh
    }
  }
  const current = state[WORKSPACES_CURRENT_STATE_KEY];
  if (current !== undefined && current !== null) return;
  state[WORKSPACES_CURRENT_STATE_KEY] = from;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Remove directories the move emptied: project dirs, `projects/`, the old root itself. */
function pruneEmpty(from: string, fs: RelocationFs): void {
  const projects = join(from, "projects");
  if (fs.existsSync(projects)) {
    for (const project of fs.readdirSync(projects)) {
      attempt(() => fs.rmdirSync(join(projects, project)));
    }
    attempt(() => fs.rmdirSync(projects));
  }
  attempt(() => fs.rmdirSync(from));
}

/** Best effort: rmdirSync fails on a non-empty directory, which is the point. */
function attempt(run: () => void): void {
  try {
    run();
  } catch {
    // best effort
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
