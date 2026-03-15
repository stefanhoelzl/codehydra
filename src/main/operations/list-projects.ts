/**
 * ListProjectsOperation - Returns all open projects with their workspaces.
 *
 * Read-only query with two hook points:
 * - "list-projects": project modules contribute project identity (id, name, path)
 * - "list-workspaces": workspace modules contribute workspaces per project
 *
 * Joins results by projectPath and converts internal types to IPC types
 * using existing toIpcWorkspaces().
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Project, ProjectId } from "../../shared/api/types";
import type { Workspace as InternalWorkspace } from "../../services/git/types";
import { toIpcWorkspaces } from "../api/workspace-conversion";

/** Re-exported for use by operation integration tests (avoids direct service import). */
export type { Workspace as InternalWorkspace } from "../../services/git/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface ListProjectsIntent extends Intent<Project[]> {
  readonly type: "project:list";
  readonly payload: Record<string, never>;
}

export const INTENT_LIST_PROJECTS = "project:list" as const;

// =============================================================================
// Hook Result Types
// =============================================================================

export interface ListProjectsHookEntry {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly path: string;
}

export interface ListProjectsHookResult {
  readonly projects?: readonly ListProjectsHookEntry[];
}

export interface ListWorkspacesHookEntry {
  readonly projectPath: string;
  readonly workspaces: readonly InternalWorkspace[];
}

export interface ListWorkspacesHookResult {
  readonly entries?: readonly ListWorkspacesHookEntry[];
}

// =============================================================================
// Operation
// =============================================================================

export const LIST_PROJECTS_OPERATION_ID = "list-projects";

export class ListProjectsOperation implements Operation<ListProjectsIntent, Project[]> {
  readonly id = LIST_PROJECTS_OPERATION_ID;

  async execute(ctx: OperationContext<ListProjectsIntent>): Promise<Project[]> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Collect project identity from "list-projects" hook
    const projectsResult = await ctx.hooks.collect<ListProjectsHookResult>(
      "list-projects",
      hookCtx
    );
    if (projectsResult.errors.length > 0) {
      if (projectsResult.errors.length === 1) {
        throw projectsResult.errors[0]!;
      }
      throw new AggregateError(projectsResult.errors, "Multiple errors listing projects");
    }

    // Collect workspace data from "list-workspaces" hook
    const workspacesResult = await ctx.hooks.collect<ListWorkspacesHookResult>(
      "list-workspaces",
      hookCtx
    );
    if (workspacesResult.errors.length > 0) {
      if (workspacesResult.errors.length === 1) {
        throw workspacesResult.errors[0]!;
      }
      throw new AggregateError(workspacesResult.errors, "Multiple errors listing workspaces");
    }

    // Build workspace lookup by projectPath
    const workspaceMap = new Map<string, InternalWorkspace[]>();
    for (const result of workspacesResult.results) {
      if (result.entries) {
        for (const entry of result.entries) {
          const existing = workspaceMap.get(entry.projectPath) ?? [];
          existing.push(...entry.workspaces);
          workspaceMap.set(entry.projectPath, existing);
        }
      }
    }

    // Join projects with their workspaces
    const projects: Project[] = [];
    for (const result of projectsResult.results) {
      if (result.projects) {
        for (const entry of result.projects) {
          const internalWorkspaces = workspaceMap.get(entry.path) ?? [];
          projects.push({
            id: entry.projectId,
            name: entry.name,
            path: entry.path,
            workspaces: toIpcWorkspaces(internalWorkspaces, entry.projectId),
          });
        }
      }
    }

    return projects;
  }
}
