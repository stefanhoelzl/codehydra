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

/**
 * Resolve a workspace reference to its path.
 *
 * A path is taken at its word — it may name a workspace that has not been
 * discovered yet. A name is matched against the open workspaces, and an
 * ambiguous name (the same workspace name in two projects) resolves to nothing
 * rather than guessing which was meant.
 */
export function resolveWorkspaceReference(
  projects: readonly ProjectLocation[],
  reference: string
): { readonly path: string } | { readonly error: string } {
  if (looksLikePath(reference)) return { path: new Path(reference).toString() };

  const matches = allWorkspaces(projects).filter((workspace) => workspace.name === reference);
  if (matches.length === 1) return { path: new Path(matches[0]!.path).toString() };
  if (matches.length === 0) return { error: `No open workspace named "${reference}"` };
  return {
    error:
      `"${reference}" matches ${matches.length} open workspaces. ` +
      `Pass a path instead: ${matches.map((match) => match.path).join(", ")}`,
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
): { readonly path: string } | { readonly error: string } {
  if (looksLikePath(reference)) return { path: new Path(reference).toString() };

  const matches = projects.filter((project) => project.name === reference);
  if (matches.length === 1) return { path: new Path(matches[0]!.path).toString() };
  if (matches.length === 0) return { error: `No open project named "${reference}"` };
  return {
    error:
      `"${reference}" matches ${matches.length} open projects. ` +
      `Pass a path instead: ${matches.map((match) => match.path).join(", ")}`,
  };
}
