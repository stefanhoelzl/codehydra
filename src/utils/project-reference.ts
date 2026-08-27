/**
 * Reading a project reference that may be a name, a local path, or a git URL.
 *
 * One argument, because that is how someone thinks about it — "this project" —
 * rather than making them say which kind of thing it is. Lives in utils rather
 * than the api layer because the intents need it too, and intents must not
 * depend on the surfaces built on top of them.
 */

import { isAbsolute, resolve } from "node:path";
import { Path } from "./path/path";

/**
 * Whether a target names a remote repository rather than a local directory.
 *
 * Three shapes count, in the order someone is likely to paste them: a URL with a
 * scheme, the scp-style form git accepts, and the `org/repo` shorthand. The
 * shorthand is checked last and deliberately narrowly — it must be exactly two
 * segments of repository-ish characters — so an ordinary relative path like
 * `src/api` is not mistaken for a repository to clone.
 */
export function looksLikeGitUrl(target: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  if (/^[^/\s]+@[^/\s]+:/.test(target)) return true;
  if (target.startsWith(".") || isAbsolute(target)) return false;
  return /^[\w.-]+\/[\w.-]+$/.test(target) && !target.includes("..");
}

/**
 * Turn a local target into an absolute path.
 *
 * Relative targets are resolved against the caller's own directory, so `.` means
 * the repository they are standing in. Without one — an in-app caller, which has
 * no directory — a relative target cannot be resolved and is returned unchanged
 * for the open to reject with the value the caller actually gave.
 */
export function resolveLocalPath(target: string, cwd: string | null): string {
  if (isAbsolute(target)) return new Path(target).toString();
  if (cwd === null) return target;
  return new Path(resolve(cwd, target)).toString();
}

/**
 * Whether a reference names a location rather than an open project.
 *
 * Names are the ergonomic form — `ch project close ohi` beats pasting a path —
 * so anything that is not clearly a location is treated as one. Absolute is the
 * test rather than "contains a separator": a relative path is ambiguous with a
 * name, and a name is the far more likely intent.
 */
export function looksLikeProjectPath(reference: string): boolean {
  return reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference);
}

/** The shape project matching needs. */
export interface NamedProject {
  readonly name: string;
  readonly path: string;
}

/**
 * Match a reference against open projects by name.
 *
 * Returns nothing when the reference is a location or matches no open project —
 * both are cases the caller resolves differently, by opening it. An ambiguous
 * name is an error rather than a guess: acting on the wrong project is worse
 * than asking.
 */
export function matchOpenProject(
  projects: readonly NamedProject[],
  reference: string
): { readonly path: string } | { readonly error: string } | undefined {
  if (looksLikeProjectPath(reference) || looksLikeGitUrl(reference)) return undefined;

  const matches = projects.filter((project) => project.name === reference);
  if (matches.length === 1) return { path: new Path(matches[0]!.path).toString() };
  if (matches.length === 0) return undefined;
  return {
    error:
      `"${reference}" matches ${matches.length} open projects. ` +
      `Pass a path instead: ${matches.map((match) => match.path).join(", ")}`,
  };
}
