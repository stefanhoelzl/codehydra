/**
 * ListProjectsOperation - Returns all open projects with their workspaces.
 *
 * Read-only query with two hook points:
 * - "list-projects": project modules contribute project identity (id, name, path)
 * - "list-workspaces": workspace modules contribute workspaces per project
 *
 * Joins results by projectPath and converts internal types to IPC types
 * using existing toIpcWorkspaces().
 *
 * Contract schemas (item 2): zod is the single source of truth; the Intent, result,
 * and hook types are derived from the `schemas` bundle.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import type { Project } from "../shared/api/types";
import type { Path } from "../utils/path/path";
import type { Workspace as InternalWorkspace } from "../boundaries/platform/git-types";
import { projectIdSchema, projectSchema } from "./contract";
import { toIpcWorkspaces } from "../utils/workspace-conversion";
import { throwHookErrors } from "./lib/hook-helpers";

/** Re-exported for use by operation integration tests (avoids direct service import). */
export type { Workspace as InternalWorkspace } from "../boundaries/platform/git-types";

export const INTENT_LIST_PROJECTS = "project:list" as const;
export const LIST_PROJECTS_OPERATION_ID = "list-projects";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const listProjectsPayloadSchema = z.object({}).readonly();

export const listProjectsResultSchema = z.array(projectSchema);

export const listProjectsHookEntrySchema = z
  .object({
    projectId: projectIdSchema,
    name: z.string(),
    path: z.string(),
  })
  .readonly();

export const listProjectsHookResultSchema = z
  .object({
    projects: z.array(listProjectsHookEntrySchema).readonly().optional(),
  })
  .readonly();

/**
 * Local schema for the internal Workspace shape (from boundaries/git-types) — not in
 * contract.ts because it carries a `Path` instance (a class), not an IPC string.
 */
const internalWorkspaceSchema = z
  .object({
    name: z.string(),
    path: z.custom<Path>(),
    branch: z.string().nullable(),
    metadata: z.record(z.string(), z.string()).readonly(),
  })
  .readonly();

export const listWorkspacesHookEntrySchema = z
  .object({
    projectPath: z.string(),
    workspaces: z.array(internalWorkspaceSchema).readonly(),
    /**
     * Per-project default base branch, computed once at project:open and cached
     * by the contributing module. Carried here so the creation form can seed the
     * base field synchronously on first paint instead of awaiting a git round-trip.
     */
    defaultBaseBranch: z.string().optional(),
  })
  .readonly();

export const listWorkspacesHookResultSchema = z
  .object({
    entries: z.array(listWorkspacesHookEntrySchema).readonly().optional(),
  })
  .readonly();

const schemas = {
  type: INTENT_LIST_PROJECTS,
  payload: listProjectsPayloadSchema,
  result: listProjectsResultSchema,
  hooks: {
    "list-projects": { result: listProjectsHookResultSchema },
    "list-workspaces": { result: listWorkspacesHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ListProjectsIntent = IntentOf<typeof schemas>;
export type ListProjectsHookEntry = z.infer<typeof listProjectsHookEntrySchema>;
export type ListProjectsHookResult = z.infer<typeof listProjectsHookResultSchema>;
export type ListWorkspacesHookEntry = z.infer<typeof listWorkspacesHookEntrySchema>;
export type ListWorkspacesHookResult = z.infer<typeof listWorkspacesHookResultSchema>;

// =============================================================================
// Operation
// =============================================================================

export class ListProjectsOperation implements Operation<typeof schemas> {
  readonly id = LIST_PROJECTS_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<ListProjectsIntent>): Promise<Project[]> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Collect project identity from "list-projects" hook
    const projectsResult = await ctx.hooks.collect<ListProjectsHookResult>(
      "list-projects",
      hookCtx
    );
    throwHookErrors(projectsResult.errors, "Multiple errors listing projects");

    // Collect workspace data from "list-workspaces" hook
    const workspacesResult = await ctx.hooks.collect<ListWorkspacesHookResult>(
      "list-workspaces",
      hookCtx
    );
    throwHookErrors(workspacesResult.errors, "Multiple errors listing workspaces");

    // Build workspace + default-base lookups by projectPath
    const workspaceMap = new Map<string, InternalWorkspace[]>();
    const defaultBaseMap = new Map<string, string>();
    for (const result of workspacesResult.results) {
      if (result.entries) {
        for (const entry of result.entries) {
          const existing = workspaceMap.get(entry.projectPath) ?? [];
          existing.push(...entry.workspaces);
          workspaceMap.set(entry.projectPath, existing);
          if (entry.defaultBaseBranch !== undefined) {
            defaultBaseMap.set(entry.projectPath, entry.defaultBaseBranch);
          }
        }
      }
    }

    // Join projects with their workspaces
    const projects: Project[] = [];
    for (const result of projectsResult.results) {
      if (result.projects) {
        for (const entry of result.projects) {
          const internalWorkspaces = workspaceMap.get(entry.path) ?? [];
          const defaultBaseBranch = defaultBaseMap.get(entry.path);
          projects.push({
            id: entry.projectId,
            name: entry.name,
            path: entry.path,
            workspaces: toIpcWorkspaces(internalWorkspaces, entry.projectId),
            ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
          });
        }
      }
    }

    return projects;
  }
}
