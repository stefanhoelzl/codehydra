/**
 * How the git type describes a workspace to core: its branch as the subtitle
 * (with the branch icon), and `{ branch?, base? }` as its opaque details.
 *
 * Both detail fields are absent rather than substituted when unknown: a
 * detached HEAD has no branch, and a worktree the user adopted by hand never
 * had a base. A plugin script that branches on them must never take a stand-in
 * for the real thing.
 */

import { z } from "zod/v4";
import type { WorkspaceDescription, WorkspaceDetails } from "../../intents/contract";
import type { Workspace } from "../../boundaries/platform/git-types";
import type { RegisteredWorkspace } from "../../utils/workspace-conversion";

/** Metadata key holding the branch a workspace was created from. */
export const BASE_METADATA_KEY = "base";

/** The details a git workspace carries. */
export type GitWorkspaceDetails = {
  /** The checked-out branch. Absent on a detached HEAD. */
  readonly branch?: string;
  /** The recorded base. Absent when none is recorded. */
  readonly base?: string;
};

const gitDetailsSchema = z.object({ branch: z.string().optional() });

/**
 * The branch in details git gave core earlier (null: none, a detached HEAD).
 * Parsed, not cast: the details came back through core, which holds them opaque.
 */
export function branchOf(details: WorkspaceDetails | undefined): string | null {
  const parsed = gitDetailsSchema.safeParse(details);
  return parsed.success ? (parsed.data.branch ?? null) : null;
}

/** The description of a worktree on `branch` (null: detached HEAD) with `metadata`. */
export function describeWorktree(
  branch: string | null,
  metadata: Readonly<Record<string, string>>
): WorkspaceDescription {
  const base = metadata[BASE_METADATA_KEY];
  const details: GitWorkspaceDetails = {
    ...(branch !== null && { branch }),
    ...(base !== undefined && { base }),
  };
  return {
    ...(branch !== null && { subtitle: branch, subtitleIcon: "branch" as const }),
    details,
  };
}

/** A git workspace as the registry holds it. */
export function registeredWorkspace(ws: Workspace): RegisteredWorkspace {
  return {
    name: ws.name,
    path: ws.path,
    metadata: ws.metadata,
    ...describeWorktree(ws.branch, ws.metadata),
  };
}
