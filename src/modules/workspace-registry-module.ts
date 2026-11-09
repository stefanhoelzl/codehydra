/**
 * WorkspaceRegistryModule - The core workspace registry: every workspace of
 * every open project, whatever the project's type, and its metadata.
 *
 * Holds, per workspace, its name, path and branch under its project's ref, and
 * owns the metadata store (`WorkspaceMetadataStore`): memory-authoritative, one
 * file per workspace, one write queue per workspace. It computes nothing about
 * a workspace itself: the project's type module tells it what exists —
 * `openProject` and `track` when it discovers a workspace, `trackCreated` when
 * it creates one, `untrack` when one is gone — and the registry answers every
 * question that is the same for every type:
 *
 * - resolve-workspace → resolve:         ref or path → the workspace's identity
 * - switch-workspace  → find-candidates: every workspace, hibernated ones flagged
 * - list-projects     → list-workspaces: each open project's workspaces
 * - close-project     → resolve:         the closing project's workspaces
 * - close-project     → close:           forget the project and its workspaces
 * - open-workspace    → create:          refuse a name the project already has
 * - open-workspace    → finalize:        the metadata as it stands once opened
 *
 * Where a workspace's metadata file lives is its type's call (a locator handed
 * to `track`). A type that names none gets `<project record dir>/
 * workspace-metadata/<name>.json`, next to the project's record in the project
 * store; the registry reads that file on `track` and deletes it with the
 * workspace.
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
import { OPEN_WORKSPACE_OPERATION_ID, type FinalizeHookResult } from "../intents/open-workspace";
import { HIBERNATED_METADATA_KEY } from "../intents/hibernate-workspace";
import { defineHooks } from "../intents/declarations";
import { getErrorMessage, WorkspaceError } from "../shared/errors/service-errors";
import { isValidMetadataKey } from "../shared/api/types";
import { makeWorkspaceRef, parseWorkspaceRef, type WorkspaceRefParts } from "../utils/ref";
import { toDiscoveredWorkspaces } from "../utils/workspace-conversion";
import { Path } from "../utils/path/path";
import type { Workspace } from "../boundaries/platform/git-types";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logger } from "../boundaries/platform/logging";
import { sanitizeWorkspaceName } from "../boundaries/platform/paths";
import {
  readMetadataFile,
  WorkspaceMetadataStore,
  type Metadata,
  type MetadataLocator,
} from "../boundaries/platform/workspace-metadata-store";

/**
 * Capability the registry's open-workspace "create" handler provides once it
 * has checked a fresh workspace's name is free in its project. A type module's
 * "create" handler requires it, so it never creates a workspace under a taken name.
 */
export const WORKSPACE_NAME_FREE_CAPABILITY = "workspace-name-free";

/** Requirement a type module's fresh "create" handler declares (see WORKSPACE_NAME_FREE_CAPABILITY). */
export const REQUIRES_FREE_NAME = { [WORKSPACE_NAME_FREE_CAPABILITY]: ANY_VALUE } as const;

/** Metadata key holding a workspace's name, written when it is created (see NAME_METADATA_KEY in git). */
export const NAME_METADATA_KEY = "name";

/** A workspace as a type reports it: its metadata is what its file holds. */
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
  /** A known project's workspaces with their metadata, in tracking order; undefined for an unknown project. */
  workspacesOf(projectRef: ProjectRef): readonly RegisteredWorkspace[] | undefined;
  /**
   * Hold an existing workspace and its already-persisted metadata. `locate`
   * finds its metadata file; without one the registry keeps it under the
   * project's record directory and reads it now. A workspace already held at
   * its path stays as it is.
   */
  track(
    project: RegistryProject,
    workspace: RegisteredWorkspace,
    locate?: MetadataLocator
  ): Promise<void>;
  /**
   * Hold a workspace its type just created, and write its metadata file with
   * the workspace's name recorded. Best-effort: a failed write is logged, and
   * the next metadata write creates the file.
   */
  trackCreated(
    project: RegistryProject,
    workspace: RegisteredWorkspace,
    locate?: MetadataLocator
  ): Promise<void>;
  /** Stop holding a workspace. A deleted one's metadata file goes too when the registry chose where it lives. */
  untrack(workspacePath: Path, reason: UntrackReason): void;
  /**
   * A held workspace's metadata.
   * @throws WorkspaceError WORKSPACE_NOT_FOUND when no workspace is held at the path
   */
  metadata(workspacePath: Path): Metadata;
  /**
   * Set one metadata key of a held workspace (null deletes it).
   * @throws WorkspaceError INVALID_METADATA_KEY for a malformed key, WORKSPACE_NOT_FOUND for an unknown workspace
   */
  setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void>;
}

export interface WorkspaceRegistryModule extends IntentModule, WorkspaceRegistry {}

export interface WorkspaceRegistryDeps {
  readonly fs: Pick<FileSystemBoundary, "readFile" | "writeFile" | "rename" | "unlink" | "mkdir">;
  readonly logger: Logger;
  /** The directory an open project's record lives in (the project store's); undefined if unknown. */
  readonly projectDir: (projectRef: ProjectRef) => Path | undefined;
}

/** A held workspace: what the registry keeps besides its metadata (in the store). */
interface HeldWorkspace {
  readonly name: string;
  readonly path: Path;
  readonly branch: string | null;
  /** Its file is the registry's default location, so it goes with the workspace. */
  readonly defaultLocation: Path | undefined;
}

interface ProjectEntry {
  readonly path: ProjectPath;
  /** By `Path.toString()` of the workspace path, in tracking order. */
  readonly workspaces: Map<string, HeldWorkspace>;
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

/**
 * Directory, under a project's record directory, of the metadata files the
 * registry places. Not `workspaces`: under the default workspaces root that is
 * where git's worktrees of the project live.
 */
export const DEFAULT_METADATA_DIR = "workspace-metadata";

export function createWorkspaceRegistryModule(
  deps: WorkspaceRegistryDeps
): WorkspaceRegistryModule {
  const { fs, logger } = deps;
  const projects = new Map<ProjectRef, ProjectEntry>();
  const store = new WorkspaceMetadataStore(fs);

  const workspacePathOf = (ws: HeldWorkspace): WorkspacePath =>
    workspacePathSchema.parse(ws.path.toString());
  const metadataOf = (ws: HeldWorkspace): Metadata => store.get(ws.path) ?? {};

  function openProject(project: RegistryProject): ProjectEntry {
    let entry = projects.get(project.ref);
    if (entry === undefined) {
      entry = { path: project.path, workspaces: new Map() };
      projects.set(project.ref, entry);
    }
    return entry;
  }

  /** The held workspace at `workspacePath`, with the project holding it. */
  function find(workspacePath: Path): { project: ProjectEntry; ws: HeldWorkspace } | undefined {
    const key = workspacePath.toString();
    for (const project of projects.values()) {
      const ws = project.workspaces.get(key);
      if (ws !== undefined) return { project, ws };
    }
    return undefined;
  }

  /** The file the registry keeps a workspace's metadata in when its type names none. */
  function defaultLocation(projectRef: ProjectRef, name: string): Path {
    const dir = deps.projectDir(projectRef);
    if (dir === undefined) {
      throw new WorkspaceError(`No project record to keep workspace metadata in: ${projectRef}`);
    }
    return new Path(dir, DEFAULT_METADATA_DIR, `${sanitizeWorkspaceName(name)}.json`);
  }

  /** Record `workspace` as held; false when one already is at its path. */
  function hold(
    project: RegistryProject,
    workspace: RegisteredWorkspace,
    defaultFile: Path | undefined
  ): boolean {
    const entry = openProject(project);
    const key = workspace.path.toString();
    if (entry.workspaces.has(key)) return false;
    entry.workspaces.set(key, {
      name: workspace.name,
      path: workspace.path,
      branch: workspace.branch,
      defaultLocation: defaultFile,
    });
    return true;
  }

  /** The locator to hand the store: the type's, else one making the default file's directory. */
  function locatorFor(locate: MetadataLocator | undefined, defaultFile: Path | undefined) {
    if (locate !== undefined) return locate;
    const file = defaultFile!;
    return async (): Promise<Path> => {
      await fs.mkdir(file.dirname);
      return file;
    };
  }

  /** The resolve-hook answer for `ws` of the project `projectRef`. */
  function identityOf(
    projectRef: ProjectRef,
    project: ProjectEntry,
    ws: HeldWorkspace
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
      metadata: metadataOf(ws),
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
      { ref: ProjectRef; project: ProjectEntry; ws: HeldWorkspace; rootLength: number } | undefined;
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

  function notFound(workspacePath: Path): WorkspaceError {
    return new WorkspaceError(
      `Workspace not found: ${workspacePath.toString()}`,
      "WORKSPACE_NOT_FOUND"
    );
  }

  const registry: WorkspaceRegistry = {
    openProject(project) {
      openProject(project);
    },

    workspacesOf(projectRef) {
      const project = projects.get(projectRef);
      if (project === undefined) return undefined;
      return [...project.workspaces.values()].map((ws) => ({
        name: ws.name,
        path: ws.path,
        branch: ws.branch,
        metadata: metadataOf(ws),
      }));
    },

    async track(project, workspace, locate) {
      const defaultFile =
        locate === undefined ? defaultLocation(project.ref, workspace.name) : undefined;
      let metadata: Metadata = workspace.metadata;
      if (defaultFile !== undefined) {
        try {
          metadata = { ...metadata, ...((await readMetadataFile(fs, logger, defaultFile)) ?? {}) };
        } catch (error: unknown) {
          logger
            .scoped({ path: defaultFile.toString() })
            .warn("Failed to read workspace metadata file", { error: getErrorMessage(error) });
        }
      }
      // Held from here on with no await in between: a concurrent track of the
      // same path keeps the first.
      if (!hold(project, workspace, defaultFile)) return;
      store.track(workspace.path, locatorFor(locate, defaultFile), metadata);
    },

    async trackCreated(project, workspace, locate) {
      const defaultFile =
        locate === undefined ? defaultLocation(project.ref, workspace.name) : undefined;
      if (!hold(project, workspace, defaultFile)) return;
      try {
        await store.initialize(workspace.path, locatorFor(locate, defaultFile), {
          ...workspace.metadata,
          [NAME_METADATA_KEY]: workspace.name,
        });
      } catch (error: unknown) {
        logger
          .scoped({ path: workspace.path.toString() })
          .warn("Failed to write a new workspace's metadata", { error: getErrorMessage(error) });
      }
    },

    untrack(workspacePath, reason) {
      const held = find(workspacePath);
      if (held === undefined) return;
      held.project.workspaces.delete(workspacePath.toString());
      store.forget(workspacePath);
      const file = held.ws.defaultLocation;
      if (reason === "deleted" && file !== undefined) {
        void fs.unlink(file).catch((error: unknown) => {
          logger.scoped({ path: file.toString() }).debug("No workspace metadata file to remove", {
            error: getErrorMessage(error),
          });
        });
      }
    },

    metadata(workspacePath) {
      const metadata = store.get(workspacePath);
      if (metadata === undefined) throw notFound(workspacePath);
      return { ...metadata };
    },

    async setMetadata(workspacePath, key, value) {
      if (!isValidMetadataKey(key)) {
        throw new WorkspaceError(
          `Invalid metadata key '${key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`,
          "INVALID_METADATA_KEY"
        );
      }
      if (store.get(workspacePath) === undefined) throw notFound(workspacePath);
      await store.set(workspacePath, key, value);
    },
  };

  return {
    name: "workspace-registry",
    ...registry,

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
                const hibernated = metadataOf(ws)[HIBERNATED_METADATA_KEY] === "true";
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
            for (const [projectRef, project] of projects) {
              entries.push({
                projectPath: project.path,
                workspaces: toDiscoveredWorkspaces(registry.workspacesOf(projectRef) ?? []),
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
            for (const ws of projects.get(ctx.projectRef)?.workspaces.values() ?? []) {
              store.forget(ws.path);
            }
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

        /**
         * The metadata as the store holds it once the workspace opened, so
         * `workspace:created` (and the Workspace the operation returns) carry it.
         *
         * The `create` snapshot plus what the other hook points *report* is only
         * as complete as its reporters. An agent that acts on its own workspace
         * during creation — OpenCode sends its initial prompt from the setup
         * hook, and `codehydra_workspace_set_title` is one MCP call away — writes
         * through `workspace:set-metadata`, which is not a hook result. Its
         * `metadata:changed` event lands on a row the presenter is about to
         * overwrite with the stale snapshot. Reading here fixes it for every
         * writer. Merged last (open-workspace.ts folds finalize results after
         * setup's), so it supersedes both.
         */
        finalize: {
          handler: async (ctx): Promise<HookOutput<FinalizeHookResult>> => {
            const metadata = store.get(new Path(ctx.workspacePath));
            // A workspace the registry does not hold opens with the snapshot it has.
            return { result: metadata === undefined ? {} : { metadata: { ...metadata } } };
          },
        },
      },
    }),
  };
}
