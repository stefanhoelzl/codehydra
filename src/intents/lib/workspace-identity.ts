/**
 * Shared preamble helpers for the workspace-lifecycle operations
 * (delete / hibernate / wake). Each begins by resolving a workspace path to its
 * full identity via two nested dispatches, and hibernate/wake share the same
 * "emit a {workspacePath, error} failure event, then rethrow" catch block.
 */

import type { DispatchFn } from "./operation";
import type { ProjectId, WorkspaceName, ProjectPath, WorkspacePath } from "../contract";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "../resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "../resolve-project";
import { getErrorMessage } from "../../shared/error-utils";

/** A workspace's full identity, resolved from its path. */
export interface ResolvedWorkspaceIdentity {
  readonly projectPath: ProjectPath;
  readonly workspaceName: WorkspaceName;
  readonly projectId: ProjectId;
  readonly active: boolean;
  /** Current branch name, or null for detached HEAD. */
  readonly branch: string | null;
}

/**
 * Resolve a workspace path to its full identity: dispatch workspace:resolve
 * (→ projectPath, workspaceName, active, branch) then project:resolve
 * (projectPath → projectId).
 */
export async function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspacePath: WorkspacePath
): Promise<ResolvedWorkspaceIdentity> {
  const { projectPath, workspaceName, active, branch } = await dispatch<ResolveWorkspaceIntent>({
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspacePath },
  });

  const { projectId } = await dispatch<ResolveProjectIntent>({
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectPath },
  });

  return { projectPath, workspaceName, projectId, active, branch };
}

/**
 * Build the `{workspacePath, error}` payload the hibernate/wake failure events carry.
 *
 * Returns the payload rather than emitting it: `ctx.emit` is now typed to the events its own
 * operation declares, so a shared helper cannot emit on the operation's behalf without either
 * a cast or a type parameter that defeats the check. The caller emits, and the event type it
 * names is validated against its own bundle.
 */
export function workspaceFailurePayload(
  workspacePath: WorkspacePath,
  error: unknown
): { readonly workspacePath: WorkspacePath; readonly error: string } {
  return { workspacePath, error: getErrorMessage(error) };
}
