/**
 * WorkspaceRegistryModule - The core workspace registry: every workspace of
 * every open project, whatever the project's type.
 *
 * Holds, per workspace, its name, path, branch and metadata, under its
 * project's ref. It computes nothing about a workspace itself: the project's
 * type module tells it what exists — `openProject` and `track` when it
 * discovers or creates workspaces, `untrack` when one is gone — and the
 * registry answers every question that is the same for every type:
 *
 * - resolve-workspace → resolve:         ref or path → the workspace's identity
 * - switch-workspace  → find-candidates: every workspace, hibernated ones flagged
 * - list-projects     → list-workspaces: each open project's workspaces
 * - close-project     → resolve:         the closing project's workspaces
 * - close-project     → close:           forget the project and its workspaces
 * - open-workspace    → create:          refuse a name the project already has
 *
 * A type module's fresh "create" handler requires `WORKSPACE_NAME_FREE_CAPABILITY`,
 * so a taken name fails before anything is created.
 */

import type { IntentModule } from "../intents/lib/module";
import { ANY_VALUE, type HookOutput } from "../intents/lib/operation";
import type { ProjectPath, ProjectRef, WorkspacePath, WorkspaceRef } from "../intents/contract";
import { workspaceNameSchema, workspacePathSchema } from "../intents/contract";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  type FindCandidatesHookResult,
  type WorkspaceCandidate,
} from "../intents/switch-workspace";
import {
  LIST_PROJECTS_OPERATION_ID,
  type ListWorkspacesHookEntry,
  type ListWorkspacesHookResult,
} from "../intents/list-projects";
import { CLOSE_PROJECT_OPERATION_ID, type CloseResolveHookResult } from "../intents/close-project";
import { OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import { HIBERNATED_METADATA_KEY } from "../intents/hibernate-workspace";
import { EVENT_METADATA_CHANGED } from "../intents/set-metadata";
import { defineEvents, defineHooks } from "../intents/declarations";
import { WorkspaceError } from "../shared/errors/service-errors";
import { makeWorkspaceRef, parseWorkspaceRef, type WorkspaceRefParts } from "../utils/ref";
import { toDiscoveredWorkspaces } from "../utils/workspace-conversion";
import { Path } from "../utils/path/path";
import type { Workspace } from "../boundaries/platform/git-types";

/**
 * Capability the registry's open-workspace "create" handler provides once it
 * has checked a fresh workspace's name is free in its project. A type module's
 * "create" handler requires it, so it never creates a workspace under a taken name.
 */
export const WORKSPACE_NAME_FREE_CAPABILITY = "workspace-name-free";

/** A workspace as the registry holds it. */
export type RegisteredWorkspace = Workspace;

/** A project the registry knows: its ref and the path it is open at. */
export interface RegistryProject {
  readonly ref: ProjectRef;
  readonly path: ProjectPath;
}

/** Why a workspace leaves the registry. */
export type UntrackReason =
  /** Its runtime is torn down (its project closes); the workspace itself stays. */
  | "closed"
  /** The workspace itself is gone. */
  | "deleted";

/** What a project type's module tells the registry, and may ask it. */
export interface WorkspaceRegistry {
  /** Know a project, with or without workspaces. Idempotent. */
  openProject(project: RegistryProject): void;
  /** A known project's workspaces, in the order they were tracked; undefined for an unknown project. */
  workspacesOf(projectRef: ProjectRef): readonly RegisteredWorkspace[] | undefined;
  /** Hold a workspace, knowing its project too. A workspace already held at its path stays as it is. */
  track(project: RegistryProject, workspace: RegisteredWorkspace): void;
  /** Stop holding a workspace. */
  untrack(workspacePath: Path, reason: UntrackReason): void;
}

export interface WorkspaceRegistryModule extends IntentModule, WorkspaceRegistry {}

interface ProjectEntry {
  readonly path: ProjectPath;
  /** By `Path.toString()` of the workspace path, in tracking order. */
  readonly workspaces: Map<string, RegisteredWorkspace>;
}

/**
 * True when `candidate` is the workspace at `workspaceRoot`, or lies inside it.
 *
 * The separator check is what stops `/repo/wt/feature` claiming a sibling
 * called `/repo/wt/feature-2`, which a bare `startsWith` would.
 */
function isWithin(candidate: string, workspaceRoot: string): boolean {
  return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}/`);
}

export function createWorkspaceRegistryModule(): WorkspaceRegistryModule {
  const projects = new Map<ProjectRef, ProjectEntry>();

  const workspacePathOf = (ws: RegisteredWorkspace): WorkspacePath =>
    workspacePathSchema.parse(ws.path.toString());

  function openProject(project: RegistryProject): ProjectEntry {
    let entry = projects.get(project.ref);
    if (entry === undefined) {
      entry = { path: project.path, workspaces: new Map() };
      projects.set(project.ref, entry);
    }
    return entry;
  }

  /** The resolve-hook answer for `ws` of the project `projectRef`. */
  function identityOf(
    projectRef: ProjectRef,
    project: ProjectEntry,
    ws: RegisteredWorkspace
  ): ResolveHookResult {
    return {
      workspaceRef: makeWorkspaceRef(projectRef, ws.name),
      workspacePath: workspacePathOf(ws),
      projectRef,
      projectPath: project.path,
      // The stored name, NOT the basename of ws.path: Path lowercases on
      // Windows, so a path-derived name breaks the renderer's case-sensitive
      // name matching for uppercase workspace names.
      workspaceName: workspaceNameSchema.parse(ws.name),
      branch: ws.branch,
      metadata: ws.metadata,
    };
  }

  /** A workspace's identity, from its (parsed) ref. */
  function identifyByRef(wanted: WorkspaceRefParts): ResolveHookResult | undefined {
    const project = projects.get(wanted.projectRef);
    if (project === undefined) return undefined;
    for (const ws of project.workspaces.values()) {
      if (ws.name === wanted.name) return identityOf(wanted.projectRef, project, ws);
    }
    return undefined;
  }

  /**
   * A workspace's identity, from a path inside it.
   *
   * A path matches the deepest workspace containing it rather than requiring the
   * workspace root exactly, so a caller that only knows its working directory —
   * the `ch` CLI, run from anywhere inside a worktree — resolves the same way a
   * caller holding the root does. An exact match is the longest possible one, so
   * it still wins; nesting resolves to the innermost workspace.
   */
  function identifyByPath(workspacePath: WorkspacePath): ResolveHookResult | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    let best:
      | { ref: ProjectRef; project: ProjectEntry; ws: RegisteredWorkspace; rootLength: number }
      | undefined;
    for (const [ref, project] of projects) {
      for (const [root, ws] of project.workspaces) {
        if (!isWithin(normalizedPath, root)) continue;
        if (best !== undefined && root.length <= best.rootLength) continue;
        best = { ref, project, ws, rootLength: root.length };
      }
    }
    return best === undefined ? undefined : identityOf(best.ref, best.project, best.ws);
  }

  /** A workspace's identity, from its ref or from a path inside it; a valid ref wins. */
  function identify(by: {
    readonly workspaceRef?: WorkspaceRef | undefined;
    readonly workspacePath?: WorkspacePath | undefined;
  }): ResolveHookResult | undefined {
    const wanted = by.workspaceRef !== undefined ? parseWorkspaceRef(by.workspaceRef) : null;
    if (wanted !== null) return identifyByRef(wanted);
    if (by.workspacePath !== undefined) return identifyByPath(by.workspacePath);
    return undefined;
  }

  /** The held workspace at `workspacePath`, with the project holding it. */
  function find(
    workspacePath: Path
  ): { project: ProjectEntry; ws: RegisteredWorkspace } | undefined {
    const key = workspacePath.toString();
    for (const project of projects.values()) {
      const ws = project.workspaces.get(key);
      if (ws !== undefined) return { project, ws };
    }
    return undefined;
  }

  return {
    name: "workspace-registry",

    openProject(project) {
      openProject(project);
    },

    workspacesOf(projectRef) {
      const project = projects.get(projectRef);
      return project === undefined ? undefined : [...project.workspaces.values()];
    },

    track(project, workspace) {
      const entry = openProject(project);
      const key = workspace.path.toString();
      if (!entry.workspaces.has(key)) entry.workspaces.set(key, workspace);
    },

    untrack(workspacePath) {
      find(workspacePath)?.project.workspaces.delete(workspacePath.toString());
    },

    hooks: defineHooks({
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx): Promise<HookOutput<ResolveHookResult>> => {
            return { result: identify(ctx.intent.payload) ?? {} };
          },
        },
      },

      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<HookOutput<FindCandidatesHookResult>> => {
            const candidates: WorkspaceCandidate[] = [];
            for (const [projectRef, project] of projects) {
              const projectName = new Path(project.path).basename;
              for (const ws of project.workspaces.values()) {
                const hibernated = ws.metadata[HIBERNATED_METADATA_KEY] === "true";
                candidates.push({
                  projectRef,
                  projectName,
                  workspaceRef: makeWorkspaceRef(projectRef, ws.name),
                  workspaceName: ws.name,
                  ...(hibernated && { hibernated: true }),
                });
              }
            }
            return { result: { candidates } };
          },
        },
      },

      [LIST_PROJECTS_OPERATION_ID]: {
        "list-workspaces": {
          handler: async (): Promise<HookOutput<ListWorkspacesHookResult>> => {
            const entries: ListWorkspacesHookEntry[] = [];
            for (const project of projects.values()) {
              entries.push({
                projectPath: project.path,
                workspaces: toDiscoveredWorkspaces([...project.workspaces.values()]),
              });
            }
            return { result: { entries } };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve: the project's workspaces. The operation tears each down, upgrades
        // to full deletion on a confirmed removeAll, and the confirm dialog shows the count.
        resolve: {
          handler: async (ctx): Promise<HookOutput<CloseResolveHookResult>> => {
            const project = projects.get(ctx.projectRef);
            const list: { workspaceRef: WorkspaceRef; workspacePath: WorkspacePath }[] = [];
            for (const ws of project?.workspaces.values() ?? []) {
              list.push({
                workspaceRef: makeWorkspaceRef(ctx.projectRef, ws.name),
                workspacePath: workspacePathOf(ws),
              });
            }
            return { result: { workspaces: list } };
          },
        },
        close: {
          handler: async (ctx): Promise<HookOutput<Record<string, never>>> => {
            projects.delete(ctx.projectRef);
            return { result: {} };
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        // create: a name is taken for good once a workspace has it, even after that
        // workspace switches to another branch: the name is its identity. Compared
        // like the creation dialog does, ignoring case.
        create: {
          handler: async (ctx) => {
            const { fresh, workspaceName, projectRef } = ctx;
            if (fresh) {
              const requested = workspaceName.toLowerCase();
              const project = projects.get(projectRef);
              const taken = [...(project?.workspaces.values() ?? [])].some(
                (ws) => ws.name.toLowerCase() === requested
              );
              if (taken) {
                throw new WorkspaceError(`Workspace '${workspaceName}' already exists`);
              }
            }
            return { provides: { [WORKSPACE_NAME_FREE_CAPABILITY]: true } };
          },
        },
      },
    }),

    events: defineEvents({
      [EVENT_METADATA_CHANGED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef, key, value } = event.payload;
          const wanted = parseWorkspaceRef(workspaceRef);
          if (wanted === null) return;
          const project = projects.get(wanted.projectRef);
          if (project === undefined) return;
          for (const [pathKey, ws] of project.workspaces) {
            if (ws.name !== wanted.name) continue;
            const metadata =
              value !== null
                ? { ...ws.metadata, [key]: value }
                : Object.fromEntries(Object.entries(ws.metadata).filter(([k]) => k !== key));
            // Replacing an existing key keeps its position in the map.
            project.workspaces.set(pathKey, { ...ws, metadata });
            return;
          }
        },
      },
    }),
  };
}

/** Requirement a type module's fresh "create" handler declares (see WORKSPACE_NAME_FREE_CAPABILITY). */
export const REQUIRES_FREE_NAME = { [WORKSPACE_NAME_FREE_CAPABILITY]: ANY_VALUE } as const;
