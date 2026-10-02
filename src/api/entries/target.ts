/**
 * The workspace an operation acts on, when a caller may name another one.
 *
 * Every entry that can act on a workspace other than the caller's own takes the
 * same two optional fields — `workspace` (a workspace ref, whole or short) and
 * `project` (to look a bare name up in) — and resolves them here, so a reference
 * means the same thing on every surface: an MCP tool's arguments, the CLI's
 * `--workspace` / `--project` flags, an extension's request.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { WorkspaceRef } from "../../intents/contract";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { ListProjectsIntent } from "../../intents/list-projects";
import { parseWorkspaceRef } from "../../utils/ref";
import { resolveWorkspaceReference, type ProjectLocation } from "../workspace-lookup";

/** The input fields that name a target workspace. */
export const targetFields = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Workspace to act on: its name (looked up in your own project first), " +
        "<project>::<name>, or its full ref (ch::…). Omit to target the current workspace."
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project to look the workspace name up in: its name, path, origin or full ref. " +
        "Needs workspace."
    ),
};

/** The shape of {@link targetFields} after parsing. */
export interface TargetInput {
  readonly workspace?: string | undefined;
  readonly project?: string | undefined;
}

/**
 * Turn a workspace reference into its ref, the way `--workspace` does.
 *
 * A name is looked up relative to the caller — its own project first — and an
 * ambiguity or a miss is the caller's to fix, reported with the category that
 * says which.
 */
export function createReferenceResolver(
  dispatcher: Dispatcher
): (ctx: OperationContext, reference: string, project?: string) => Promise<WorkspaceRef> {
  return async (ctx, reference, project) => {
    const projects = await dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {} as Record<string, never>,
    });
    const resolved = resolveWorkspaceReference(
      (projects ?? []) as readonly ProjectLocation[],
      reference,
      { callerWorkspace: ctx.workspaceRef, cwd: ctx.cwd, project }
    );
    if ("error" in resolved) throw new ApiError(resolved.category, resolved.error);
    return resolved.ref;
  };
}

/**
 * Resolve an operation's target: the workspace the input names, else the
 * caller's own. Reported to the caller's connection (`ctx.onTarget`), which
 * then shows that workspace's progress while the call runs.
 */
export function createTargetResolver(
  dispatcher: Dispatcher
): (ctx: OperationContext, input: TargetInput) => Promise<WorkspaceRef> {
  const resolveReference = createReferenceResolver(dispatcher);
  const resolve = async (ctx: OperationContext, input: TargetInput): Promise<WorkspaceRef> => {
    if (input.workspace !== undefined) {
      return resolveReference(ctx, input.workspace, input.project);
    }
    if (input.project !== undefined) {
      throw new ApiError("usage", "project only says where to look a workspace name up: name one.");
    }
    if (ctx.workspaceRef === null) {
      throw new ApiError("no-workspace", "No workspace to act on.");
    }
    return ctx.workspaceRef;
  };
  return async (ctx, input) => {
    const target = await resolve(ctx, input);
    ctx.onTarget?.(target);
    return target;
  };
}

/**
 * The name of a workspace, for showing to a person: the name its ref carries,
 * else the raw string (unlike `workspaceNameOf` in utils/ref.ts, never throws).
 */
export function workspaceDisplayName(workspaceRef: WorkspaceRef): string {
  return parseWorkspaceRef(workspaceRef)?.name ?? workspaceRef;
}
