/**
 * Turning what a caller typed, or where it stands, into a workspace or project ref.
 *
 * Every input names a workspace or a project by ref (`utils/ref.ts`), whole or
 * short, and the field it is given in says which of the two it is:
 *
 * - a workspace: its full ref; `<project>::<name>`; or a bare name, looked up in
 *   the caller's own project first
 * - a project: its full ref; its name; the path of a checkout; or the origin of
 *   a managed clone — the short forms of the project part of a ref
 *
 * `ch` also knows the directory it was run in, which is not a reference: the
 * workspace containing it is the caller's own. That lookup has to happen without
 * treating "no workspace here" as a failure: a shell standing outside every
 * worktree is a normal caller, and the app-global commands are exactly what
 * someone runs there.
 */

import { Path } from "../utils/path/path";
import {
  asProjectRef,
  asWorkspaceRef,
  isRef,
  parseProjectRef,
  splitWorkspaceReference,
} from "../utils/ref";
import { normalizeGitUrl } from "../utils/url-utils";
import type { ProjectRef, WorkspaceRef } from "../intents/contract";

/** The shape this needs from a listed workspace. */
export interface WorkspaceLocation {
  readonly ref: WorkspaceRef;
  readonly name: string;
  readonly path: string;
}

/** The shape this needs from a listed project. */
export interface ProjectLocation {
  readonly ref: ProjectRef;
  readonly name: string;
  readonly path: string;
  readonly workspaces: readonly WorkspaceLocation[];
}

/** Whether a reference looks like an absolute path rather than a name. */
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
export function findWorkspaceContaining<W extends { readonly path: string }>(
  workspaces: readonly W[],
  directory: string
): W | null {
  const normalized = new Path(directory).toString();

  let best: { workspace: W; length: number } | null = null;
  for (const workspace of workspaces) {
    const root = new Path(workspace.path).toString();
    if (!isWithinWorkspace(normalized, root)) continue;
    if (best === null || root.length > best.length) best = { workspace, length: root.length };
  }
  return best?.workspace ?? null;
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
  readonly callerWorkspace?: WorkspaceRef | null;
  /** The directory the caller stands in, when it is a shell. */
  readonly cwd?: string | null;
  /** Look a name up in this project only (any project reference). */
  readonly project?: string | undefined;
}

/** The project the caller belongs to, or undefined when it stands in none. */
export function callerProject(
  projects: readonly ProjectLocation[],
  scope: LookupScope
): ProjectLocation | undefined {
  const caller = scope.callerWorkspace;
  if (caller !== null && caller !== undefined) {
    const project = projects.find((candidate) =>
      candidate.workspaces.some((workspace) => workspace.ref === caller)
    );
    if (project !== undefined) return project;
  }
  const cwd = scope.cwd;
  if (cwd === null || cwd === undefined) return undefined;
  const here = new Path(cwd).toString();
  return projects.find((project) => isWithinWorkspace(here, new Path(project.path).toString()));
}

/**
 * Resolve a workspace reference to its ref.
 *
 * A full ref is taken at its word — it may name a workspace that has not been
 * discovered yet. Otherwise the name is matched against the open workspaces:
 *
 * - with a project (`<project>::<name>`, or `scope.project`), in that project only;
 * - otherwise in the caller's project first, where a match wins outright;
 * - then in every other open project, where exactly one match wins and several
 *   resolve to nothing rather than guessing which was meant.
 *
 * A failure says which of the two it was: a name that matches nothing is
 * `not-found`, one that matches several is `usage` — the caller has to write
 * the reference differently (with a project, or as a full ref).
 */
export function resolveWorkspaceReference(
  projects: readonly ProjectLocation[],
  reference: string,
  scope: LookupScope = {}
): { readonly ref: WorkspaceRef } | LookupError {
  if (isRef(reference)) {
    const ref = asWorkspaceRef(reference);
    return ref !== null
      ? { ref }
      : { error: `Not a workspace ref: "${reference}"`, category: "usage" };
  }

  const split = splitWorkspaceReference(reference);
  const projectReference = split.project ?? scope.project;
  if (projectReference !== undefined) {
    const project = findProject(projects, projectReference);
    if ("error" in project) return project;
    const match = project.workspaces.find((workspace) => workspace.name === split.name);
    return match !== undefined
      ? { ref: match.ref }
      : {
          error: `No open workspace named "${split.name}" in project "${projectReference}"`,
          category: "not-found",
        };
  }

  if (looksLikePath(reference)) {
    return {
      error:
        `"${reference}" is a path; name a workspace by its name, ` +
        `<project>::<name>, or its full ref`,
      category: "usage",
    };
  }

  const home = callerProject(projects, scope);
  const own = home?.workspaces.find((workspace) => workspace.name === reference);
  if (own !== undefined) return { ref: own.ref };

  const matches = projects
    .filter((project) => project !== home)
    .flatMap((project) => project.workspaces.filter((workspace) => workspace.name === reference));
  if (matches.length === 1) return { ref: matches[0]!.ref };
  if (matches.length === 0) {
    return { error: `No open workspace named "${reference}"`, category: "not-found" };
  }
  return {
    category: "usage",
    error:
      `"${reference}" matches ${matches.length} open workspaces. ` +
      `Name the project with --project, or pass a full ref: ` +
      matches.map((match) => match.ref).join(", "),
  };
}

/**
 * Resolve a project reference to its ref.
 *
 * A full ref is taken at its word. A path, an origin or a name must match an
 * open project — a name exactly one. Opening a project from a location is
 * `project.open`'s job, not a lookup's.
 */
export function resolveProjectReference(
  projects: readonly ProjectLocation[],
  reference: string
): { readonly ref: ProjectRef } | LookupError {
  if (isRef(reference)) {
    const ref = asProjectRef(reference);
    return ref !== null
      ? { ref }
      : { error: `Not a project ref: "${reference}"`, category: "usage" };
  }
  const found = findProject(projects, reference);
  return "error" in found ? found : { ref: found.ref };
}

/** The open project a short project reference names. */
function findProject(
  projects: readonly ProjectLocation[],
  reference: string
): ProjectLocation | LookupError {
  if (isRef(reference)) {
    const match = projects.find((project) => project.ref === reference);
    return match ?? { error: `No open project ${reference}`, category: "not-found" };
  }
  if (looksLikePath(reference)) {
    const target = new Path(reference);
    const match = projects.find((project) => target.equals(new Path(project.path)));
    return match ?? { error: `No open project at "${reference}"`, category: "not-found" };
  }

  const byName = projects.filter((project) => project.name === reference);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    return {
      category: "usage",
      error:
        `"${reference}" matches ${byName.length} open projects. ` +
        `Pass its full ref instead: ${byName.map((match) => match.ref).join(", ")}`,
    };
  }

  // An origin (`github.com/org/repo`, or any URL git accepts) names a managed
  // clone, whose ref carries its normalized origin.
  const origin = normalizeGitUrl(reference);
  const byOrigin = projects.find((project) => {
    const parts = parseProjectRef(project.ref);
    return parts?.kind === "managed" && parts.project === origin;
  });
  return byOrigin ?? { error: `No open project named "${reference}"`, category: "not-found" };
}

/** The ref of a workspace found by its path (a caller's own folder), if one is open there. */
export function workspaceAtPath(
  projects: readonly ProjectLocation[],
  directory: string
): WorkspaceRef | null {
  return findWorkspaceContaining(allWorkspaces(projects), directory)?.ref ?? null;
}
