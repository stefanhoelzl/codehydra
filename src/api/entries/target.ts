/**
 * The workspace an operation acts on, when a caller may name another one.
 *
 * Every entry that can act on a workspace other than the caller's own takes the
 * same two optional fields — `workspace` (a name or an absolute path) and
 * `project` (to look the name up in) — and resolves them here, so a name means
 * the same thing on every surface. The CLI hides both: its global `--workspace`
 * / `--project` flags name the target for the whole connection instead.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { workspacePathSchema, type WorkspacePath } from "../../intents/contract";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { ListProjectsIntent } from "../../intents/list-projects";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import type { ResolveWorkspaceIntent } from "../../intents/resolve-workspace";
import { Path } from "../../utils/path/path";
import { resolveWorkspaceReference, type ProjectLocation } from "../workspace-lookup";

/** The input fields that name a target workspace. */
export const targetFields = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Workspace to act on: a name (looked up in your own project first) or an absolute " +
        "path. Omit to target the current workspace."
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe("Project to look the workspace name up in: a name or a path. Needs workspace."),
};

/** The shape of {@link targetFields} after parsing. */
export interface TargetInput {
  readonly workspace?: string | undefined;
  readonly project?: string | undefined;
}

/** The CLI hides these: its global flags name the target instead. */
export const TARGET_FIELD_NAMES = ["workspace", "project"] as const;

/**
 * Turn a workspace reference into a path, the way `--workspace` does.
 *
 * A name is looked up relative to the caller — its own project first — and an
 * ambiguity or a miss is the caller's to fix, reported with the category that
 * says which.
 */
export function createReferenceResolver(
  dispatcher: Dispatcher
): (ctx: OperationContext, reference: string, project?: string) => Promise<WorkspacePath> {
  return async (ctx, reference, project) => {
    const projects = await dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {} as Record<string, never>,
    });
    const resolved = resolveWorkspaceReference(
      (projects ?? []) as readonly ProjectLocation[],
      reference,
      { callerWorkspace: ctx.callerWorkspacePath, cwd: ctx.cwd, project }
    );
    if ("error" in resolved) throw new ApiError(resolved.category, resolved.error);
    return workspacePathSchema.parse(resolved.path);
  };
}

/**
 * Resolve an operation's target: the workspace the input names, else the one
 * the call is scoped to.
 */
export function createTargetResolver(
  dispatcher: Dispatcher
): (ctx: OperationContext, input: TargetInput) => Promise<WorkspacePath> {
  const resolveReference = createReferenceResolver(dispatcher);
  return async (ctx, input) => {
    if (input.workspace !== undefined) {
      return resolveReference(ctx, input.workspace, input.project);
    }
    if (input.project !== undefined) {
      throw new ApiError("usage", "project only says where to look a workspace name up: name one.");
    }
    if (ctx.workspacePath === null) {
      throw new ApiError("no-workspace", "No workspace to act on.");
    }
    return ctx.workspacePath;
  };
}

/**
 * The name of the workspace at a path, for showing to a person.
 *
 * Looked up, never derived from the path: a workspace is named after its branch,
 * so `feature/x` lives in `feature%x`, and an adopted worktree's directory can be
 * called anything. A path no open workspace owns any more falls back to its
 * directory name — it only labels something, so it must not fail the call.
 */
export function createWorkspaceNamer(
  dispatcher: Dispatcher
): (workspacePath: WorkspacePath) => Promise<string> {
  return async (workspacePath) => {
    try {
      const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
      });
      return resolved.workspaceName;
    } catch {
      return new Path(workspacePath).basename;
    }
  };
}
