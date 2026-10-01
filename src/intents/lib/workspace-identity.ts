/**
 * Shared preamble helpers for the workspace-lifecycle operations
 * (delete / hibernate / wake). Each begins by resolving a workspace ref to its
 * full identity via two nested dispatches, and hibernate/wake share the same
 * "emit a {workspaceRef, error} failure event, then rethrow" catch block.
 */

import type { DispatchFn } from "./operation";
import type {
  ProjectId,
  ProjectPath,
  ProjectRef,
  WorkspaceName,
  WorkspacePath,
  WorkspaceRef,
} from "../contract";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "../resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "../resolve-project";
import { getErrorMessage } from "../../shared/error-utils";

/** A workspace's full identity, resolved from its ref. */
export interface ResolvedWorkspaceIdentity {
  readonly workspaceRef: WorkspaceRef;
  readonly workspacePath: WorkspacePath;
  readonly projectRef: ProjectRef;
  readonly projectPath: ProjectPath;
  readonly workspaceName: WorkspaceName;
  readonly projectId: ProjectId;
  readonly active: boolean;
  /** Current branch name, or null for detached HEAD. */
  readonly branch: string | null;
}

/**
 * Resolve a workspace ref to its full identity: dispatch workspace:resolve
 * (→ path, project, workspaceName, active, branch) then project:resolve
 * (projectRef → projectId).
 */
export async function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspaceRef: WorkspaceRef
): Promise<ResolvedWorkspaceIdentity> {
  const resolved = await dispatch<ResolveWorkspaceIntent>({
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspaceRef },
  });

  const { projectId } = await dispatch<ResolveProjectIntent>({
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectRef: resolved.projectRef },
  });

  return {
    workspaceRef: resolved.workspaceRef,
    workspacePath: resolved.workspacePath,
    projectRef: resolved.projectRef,
    projectPath: resolved.projectPath,
    workspaceName: resolved.workspaceName,
    projectId,
    active: resolved.active,
    branch: resolved.branch,
  };
}

/**
 * Build the `{workspaceRef, error}` payload the hibernate/wake failure events carry.
 *
 * Returns the payload rather than emitting it: `ctx.emit` is now typed to the events its own
 * operation declares, so a shared helper cannot emit on the operation's behalf without either
 * a cast or a type parameter that defeats the check. The caller emits, and the event type it
 * names is validated against its own bundle.
 */
export function workspaceFailurePayload(
  workspaceRef: WorkspaceRef,
  error: unknown
): { readonly workspaceRef: WorkspaceRef; readonly error: string } {
  return { workspaceRef, error: getErrorMessage(error) };
}
