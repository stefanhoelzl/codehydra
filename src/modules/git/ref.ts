/**
 * How the git project type names its projects in a ref (`src/utils/ref.ts`).
 *
 * A project with a remote URL on record (a managed clone) is named by its
 * normalized origin, any other project by its checkout path (`Path`-normalized,
 * so lowercased on Windows). Neither changes when CodeHydra moves a clone or the
 * workspaces root.
 */

import type { ProjectRef } from "../../intents/contract";
import { Path } from "../../utils/path/path";
import { makeProjectRef, parseProjectRef } from "../../utils/ref";
import { normalizeGitUrl } from "../../utils/url-utils";

/** The project type name git projects are stored and referred to under. */
export const GIT_PROJECT_TYPE = "git";

/** A git project's identifier: its normalized origin when cloned, else its normalized path. */
export function gitProjectIdentifier(path: string, remoteUrl?: string): string {
  return remoteUrl !== undefined ? normalizeGitUrl(remoteUrl) : new Path(path).toString();
}

/** The ref of the git project at `path`, cloned from `remoteUrl` when it was. */
export function gitProjectRef(path: string, remoteUrl?: string): ProjectRef {
  return makeProjectRef(GIT_PROJECT_TYPE, gitProjectIdentifier(path, remoteUrl));
}

/**
 * Whether a project belongs to the git type. Every git hook that serves an
 * existing project checks it first: the hook points are shared by every
 * project type, and git acts only on its own projects.
 */
export function isGitProject(ref: ProjectRef): boolean {
  return parseProjectRef(ref)?.type === GIT_PROJECT_TYPE;
}
