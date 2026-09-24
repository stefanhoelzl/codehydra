/**
 * Matching a directory to the workspace that contains it.
 *
 * `ch` knows the directory it was run in, not which worktree that is. Turning
 * one into the other has to happen without treating "no workspace here" as a
 * failure: a shell standing outside every worktree is a normal caller, and the
 * app-global commands are exactly what someone runs there.
 */

import { Path } from "../utils/path/path";

/** The shape this needs from a listed workspace. */
export interface WorkspaceLocation {
  readonly name: string;
  readonly path: string;
}

/** The shape this needs from a listed project. */
export interface ProjectLocation {
  readonly name: string;
  readonly path: string;
  readonly workspaces: readonly WorkspaceLocation[];
}

/**
 * Whether a reference looks like a path rather than a name.
 *
 * Names are the ergonomic form — `ch ws delete test-0` beats pasting a worktree
 * path — so anything that is not clearly a path is treated as one. Absolute is
 * the test rather than "contains a separator": a relative path is ambiguous with
 * a name, and a name is the far more likely intent.
 */
export function looksLikePath(reference: string): boolean {
  return reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference);
}

/**
 * True when `candidate` is the workspace at `root`, or lies inside it.
 *
 * The separator check is what stops `/repo/wt/feature` claiming a sibling named
 * `/repo/wt/feature-2`, which a bare `startsWith` would.
 */
export function isWithinWorkspace(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * The deepest workspace containing `directory`, or null when none does.
 *
 * Deepest rather than first so nested workspaces resolve to the inner one, and
 * so an exact match — the longest possible — always wins.
 */
export function findWorkspaceContaining(
  workspaces: readonly { readonly path: string }[],
  directory: string
): string | null {
  const normalized = new Path(directory).toString();

  let best: string | null = null;
  for (const workspace of workspaces) {
    const root = new Path(workspace.path).toString();
    if (!isWithinWorkspace(normalized, root)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/** Every workspace across every open project. */
export function allWorkspaces(projects: readonly ProjectLocation[]): readonly WorkspaceLocation[] {
  return projects.flatMap((project) => project.workspaces);
}

/** A lookup failure, and which kind: nothing matched, or several did. */
export interface LookupError {
  readonly error: string;
  readonly category: "not-found" | "usage";
}

/**
 * Where a workspace name is looked up from.
 *
 * A name is most likely meant in the caller's own project, so that project is
 * searched first. The caller's project is its workspace's, or — for a shell
 * standing in a project's own checkout rather than in a workspace — that one.
 */
export interface LookupScope {
  /** The caller's own workspace, when it has one. */
  readonly callerWorkspace?: string | null;
  /** The directory the caller stands in, when it is a shell. */
  readonly cwd?: string | null;
  /** Look a name up in this project only (a project name or path). */
  readonly project?: string | undefined;
}

/** The project the caller belongs to, or undefined when it stands in none. */
export function callerProject(
  projects: readonly ProjectLocation[],
  scope: LookupScope
): ProjectLocation | undefined {
  const caller = scope.callerWorkspace;
  if (caller !== null && caller !== undefined) {
    const own = new Path(caller);
    const project = projects.find((candidate) =>
      candidate.workspaces.some((workspace) => own.equals(new Path(workspace.path)))
    );
    if (project !== undefined) return project;
  }
  const cwd = scope.cwd;
  if (cwd === null || cwd === undefined) return undefined;
  const here = new Path(cwd).toString();
  return projects.find((project) => isWithinWorkspace(here, new Path(project.path).toString()));
}

/**
 * Resolve a workspace reference to its path.
 *
 * A path is taken at its word — it may name a workspace that has not been
 * discovered yet. A name is matched against the open workspaces:
 *
 * - with `scope.project`, in that project only;
 * - otherwise in the caller's project first, where a match wins outright;
 * - then in every other open project, where exactly one match wins and several
 *   resolve to nothing rather than guessing which was meant.
 *
 * A failure says which of the two it was: a name that matches nothing is
 * `not-found`, one that matches several is `usage` — the caller has to write
 * the reference differently (with a project, or as a path).
 */
export function resolveWorkspaceReference(
  projects: readonly ProjectLocation[],
  reference: string,
  scope: LookupScope = {}
): { readonly path: string } | LookupError {
  if (scope.project !== undefined) {
    const project = resolveProjectReference(projects, scope.project);
    if ("error" in project) return project;
    if (looksLikePath(reference)) return { path: new Path(reference).toString() };
    const owner = new Path(project.path);
    const match = projects
      .find((candidate) => owner.equals(new Path(candidate.path)))
      ?.workspaces.find((workspace) => workspace.name === reference);
    return match !== undefined
      ? { path: new Path(match.path).toString() }
      : {
          error: `No open workspace named "${reference}" in project "${scope.project}"`,
          category: "not-found",
        };
  }

  if (looksLikePath(reference)) return { path: new Path(reference).toString() };

  const home = callerProject(projects, scope);
  const own = home?.workspaces.find((workspace) => workspace.name === reference);
  if (own !== undefined) return { path: new Path(own.path).toString() };

  const matches = projects
    .filter((project) => project !== home)
    .flatMap((project) => project.workspaces.filter((workspace) => workspace.name === reference));
  if (matches.length === 1) return { path: new Path(matches[0]!.path).toString() };
  if (matches.length === 0) {
    return { error: `No open workspace named "${reference}"`, category: "not-found" };
  }
  return {
    category: "usage",
    error:
      `"${reference}" matches ${matches.length} open workspaces. ` +
      `Name the project with --project, or pass a path: ` +
      matches.map((match) => match.path).join(", "),
  };
}

/**
 * Resolve a project reference to its path, by path or by name.
 *
 * Same rules as workspaces: an exact path wins, a name must be unambiguous.
 */
export function resolveProjectReference(
  projects: readonly ProjectLocation[],
  reference: string
): { readonly path: string } | LookupError {
  if (looksLikePath(reference)) return { path: new Path(reference).toString() };

  const matches = projects.filter((project) => project.name === reference);
  if (matches.length === 1) return { path: new Path(matches[0]!.path).toString() };
  if (matches.length === 0) {
    return { error: `No open project named "${reference}"`, category: "not-found" };
  }
  return {
    category: "usage",
    error:
      `"${reference}" matches ${matches.length} open projects. ` +
      `Pass a path instead: ${matches.map((match) => match.path).join(", ")}`,
  };
}
