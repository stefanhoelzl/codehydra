/**
 * Shared preamble helpers for the workspace-lifecycle operations
 * (delete / hibernate / wake). Each begins by resolving a workspace path to its
 * full identity via two nested dispatches, and hibernate/wake share the same
 * "emit a {workspacePath, error} failure event, then rethrow" catch block.
 */

import type { DispatchFn } from "./operation";
import type { DomainEvent } from "./types";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "../resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "../resolve-project";
import { getErrorMessage } from "../../shared/error-utils";

/** A workspace's full identity, resolved from its path. */
export interface ResolvedWorkspaceIdentity {
  readonly projectPath: string;
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
  workspacePath: string
): Promise<ResolvedWorkspaceIdentity> {
  const { projectPath, workspaceName, active, branch } = await dispatch({
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspacePath },
  } as ResolveWorkspaceIntent);

  const { projectId } = await dispatch({
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectPath },
  } as ResolveProjectIntent);

  return { projectPath, workspaceName, projectId, active, branch };
}

/**
 * Emit a `{workspacePath, error}` failure domain event. Used by the
 * hibernate/wake `catch` blocks before rethrowing.
 */
export function emitWorkspaceFailure(
  emit: (event: DomainEvent) => void,
  type: string,
  workspacePath: string,
  error: unknown
): void {
  emit({ type, payload: { workspacePath, error: getErrorMessage(error) } });
}
