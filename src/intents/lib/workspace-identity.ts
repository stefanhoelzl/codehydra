/**
 * How an operation turns the workspace ref it was handed into the workspace.
 *
 * Every operation that acts on a workspace resolves it here, never by
 * dispatching workspace:resolve / project:resolve by hand: the two dispatches,
 * their order and what is carried from one to the other are written once. An
 * operation that needs the project too (every one that emits a workspace event,
 * whose payload carries the project's id) asks for it; one that only needs the
 * workspace's path, state or metadata passes `{ withProject: false }` and skips
 * the second dispatch.
 */

import type { DispatchFn } from "./operation";
import type {
  ProjectId,
  WorkspaceIdentityPayload,
  WorkspaceName,
  WorkspaceRef,
  WorkspaceRefIdentity,
} from "../contract";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
  type ResolveWorkspaceResult,
} from "../resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "../resolve-project";
import { projectRefOf, workspaceNameOf } from "../../utils/ref";
import { getErrorMessage } from "../../shared/error-utils";

/** A workspace resolved from its ref: what workspace:resolve answers. */
export type ResolvedWorkspace = ResolveWorkspaceResult;

/** A workspace resolved from its ref, together with its project's id and name. */
export interface ResolvedWorkspaceIdentity extends ResolvedWorkspace {
  readonly projectId: ProjectId;
  readonly projectName: string;
}

/** Options for {@link resolveWorkspaceIdentity}. */
export interface ResolveWorkspaceIdentityOptions {
  /**
   * Also dispatch project:resolve for the project's id and name. Default `true`;
   * `false` for an operation that needs only the workspace itself.
   */
  readonly withProject?: boolean;
}

/**
 * Resolve a workspace ref: dispatch workspace:resolve (→ path, project, name,
 * branch, metadata, active, closing) and, unless `withProject` is false,
 * project:resolve (→ the project's id and name).
 *
 * Throws what the resolve throws for a ref no open workspace has.
 */
export function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspaceRef: WorkspaceRef
): Promise<ResolvedWorkspaceIdentity>;
export function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspaceRef: WorkspaceRef,
  options: { readonly withProject: true }
): Promise<ResolvedWorkspaceIdentity>;
export function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspaceRef: WorkspaceRef,
  options: { readonly withProject: false }
): Promise<ResolvedWorkspace>;
export async function resolveWorkspaceIdentity(
  dispatch: DispatchFn,
  workspaceRef: WorkspaceRef,
  options?: ResolveWorkspaceIdentityOptions
): Promise<ResolvedWorkspace | ResolvedWorkspaceIdentity> {
  const resolved = await dispatch<ResolveWorkspaceIntent>({
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspaceRef },
  });
  if (options?.withProject === false) return resolved;

  const { projectId, projectName } = await dispatch<ResolveProjectIntent>({
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectRef: resolved.projectRef },
  });
  return { ...resolved, projectId, projectName };
}

/**
 * The identity every workspace event payload carries (`workspaceIdentityPayloadSchema`),
 * picked from a resolved workspace.
 */
export function workspaceIdentityPayload(
  identity: Pick<
    ResolvedWorkspaceIdentity,
    "projectId" | "projectRef" | "workspaceName" | "workspaceRef"
  >
): WorkspaceIdentityPayload {
  return {
    projectId: identity.projectId,
    projectRef: identity.projectRef,
    workspaceName: identity.workspaceName,
    workspaceRef: identity.workspaceRef,
  };
}

/**
 * The part of a workspace's identity its ref names by itself
 * (`workspaceRefIdentitySchema`): the ref, its project's ref and its name.
 *
 * For failure events, which may report a ref that never resolved — so no project
 * id is known — and must still name the workspace the way every other workspace
 * event does.
 */
export function workspaceRefIdentity(workspaceRef: WorkspaceRef): WorkspaceRefIdentity {
  return {
    projectRef: projectRefOf(workspaceRef),
    workspaceName: workspaceNameOf(workspaceRef) as WorkspaceName,
    workspaceRef,
  };
}

/**
 * Build the payload the hibernate/wake failure events carry: the ref's identity
 * and the error message.
 *
 * Returns the payload rather than emitting it: `ctx.emit` is typed to the events its own
 * operation declares, so a shared helper cannot emit on the operation's behalf without either
 * a cast or a type parameter that defeats the check. The caller emits, and the event type it
 * names is validated against its own bundle.
 */
export function workspaceFailurePayload(
  workspaceRef: WorkspaceRef,
  error: unknown
): WorkspaceRefIdentity & { readonly error: string } {
  return { ...workspaceRefIdentity(workspaceRef), error: getErrorMessage(error) };
}
