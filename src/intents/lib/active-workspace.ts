/**
 * The one way to ask which workspace is on screen: dispatch `ui:get-active-workspace`.
 * Operations and modules call these instead of building the intent themselves.
 */

import type { WorkspaceLocator, WorkspaceRef } from "../contract";
import {
  INTENT_GET_ACTIVE_WORKSPACE,
  type GetActiveWorkspaceIntent,
  type GetActiveWorkspaceResult,
} from "../get-active-workspace";

/**
 * Anything that can dispatch the lookup: an operation's `ctx.dispatch`, or a module's
 * `(intent) => dispatcher.dispatch(intent)`.
 */
export type ActiveWorkspaceDispatch = (
  intent: GetActiveWorkspaceIntent
) => PromiseLike<GetActiveWorkspaceResult>;

/** The workspace currently on screen, or null when none is. Rejects when the lookup fails. */
export async function activeWorkspace(
  dispatch: ActiveWorkspaceDispatch
): Promise<WorkspaceLocator | null> {
  return await dispatch({ type: INTENT_GET_ACTIVE_WORKSPACE, payload: {} });
}

/** The ref of the workspace currently on screen, or null. Rejects when the lookup fails. */
export async function activeWorkspaceRef(
  dispatch: ActiveWorkspaceDispatch
): Promise<WorkspaceRef | null> {
  return (await activeWorkspace(dispatch))?.ref ?? null;
}
