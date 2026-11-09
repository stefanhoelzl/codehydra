/**
 * A fake project type for tests: plain folders held in memory, no git.
 *
 * It is the whole of what a second project type has to write to get resolve,
 * switch, list and close from the core workspace registry: one module that
 * tells the registry what discovery and creation found and when a workspace is
 * gone. Every workspace of a project is the folder `<project>/<name>`.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import { defineHooks } from "../intents/declarations";
import { OPEN_PROJECT_OPERATION_ID, type DiscoverHookResult } from "../intents/open-project";
import { OPEN_WORKSPACE_OPERATION_ID, type CreateHookResult } from "../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID, type DeleteHookResult } from "../intents/delete-workspace";
import { projectPathSchema, workspacePathSchema } from "../intents/contract";
import { toDiscoveredWorkspaces } from "../utils/workspace-conversion";
import { Path } from "../utils/path/path";
import { makeProjectRef } from "../utils/ref";
import type { ProjectRef } from "../intents/contract";
import {
  REQUIRES_FREE_NAME,
  type RegisteredWorkspace,
  type WorkspaceRegistry,
} from "./workspace-registry-module";

/** The type name the fake projects go by. */
export const FAKE_PROJECT_TYPE = "fake";

/** The ref of the fake project at `path`: named by its path. */
export const fakeProjectRef = (path: string): ProjectRef =>
  makeProjectRef(FAKE_PROJECT_TYPE, new Path(path).toString());

export interface FakeProjectType {
  readonly module: IntentModule;
  /** Put a workspace folder into a project before it is discovered. */
  addFolder(projectPath: string, name: string, metadata?: Readonly<Record<string, string>>): Path;
  /** Every folder the type holds for a project, by name. */
  folders(projectPath: string): readonly string[];
  /** Names of the workspaces "create" made, in order. */
  readonly created: readonly string[];
  /** When set, removing a folder fails with this message. */
  failRemoval: string | undefined;
}

export function createFakeProjectType(registry: WorkspaceRegistry): FakeProjectType {
  const projects = new Map<string, Map<string, RegisteredWorkspace>>();
  const created: string[] = [];

  const key = (projectPath: string): string => new Path(projectPath).toString();
  const foldersOf = (projectPath: string): Map<string, RegisteredWorkspace> => {
    let folders = projects.get(key(projectPath));
    if (folders === undefined) {
      folders = new Map();
      projects.set(key(projectPath), folders);
    }
    return folders;
  };

  const fake: FakeProjectType = {
    created,
    failRemoval: undefined,

    addFolder(projectPath, name, metadata = {}) {
      const path = new Path(projectPath, name);
      foldersOf(projectPath).set(name, { name, path, branch: null, metadata });
      return path;
    },

    folders: (projectPath) => [...foldersOf(projectPath).keys()],

    module: {
      name: "fake-project-type",
      hooks: defineHooks({
        [OPEN_PROJECT_OPERATION_ID]: {
          discover: {
            handler: async (ctx): Promise<HookOutput<DiscoverHookResult>> => {
              const project = {
                ref: ctx.projectRef,
                path: projectPathSchema.parse(key(ctx.projectPath)),
              };
              const found = [...foldersOf(ctx.projectPath).values()];
              registry.openProject(project);
              for (const ws of found) registry.track(project, ws);
              return { result: { workspaces: toDiscoveredWorkspaces(found) } };
            },
          },
        },

        [OPEN_WORKSPACE_OPERATION_ID]: {
          create: {
            requires: REQUIRES_FREE_NAME,
            handler: async (ctx): Promise<HookOutput<CreateHookResult>> => {
              const project = {
                ref: ctx.projectRef,
                path: projectPathSchema.parse(key(ctx.projectPath)),
              };
              const ws: RegisteredWorkspace = {
                name: ctx.workspaceName,
                path: new Path(ctx.projectPath, ctx.workspaceName),
                branch: null,
                metadata: {},
              };
              if (ctx.fresh) {
                foldersOf(ctx.projectPath).set(ws.name, ws);
                created.push(ws.name);
              }
              registry.track(project, ws);
              return {
                result: {
                  workspacePath: workspacePathSchema.parse(ws.path.toString()),
                  branch: null,
                  metadata: ws.metadata,
                },
              };
            },
          },
        },

        [DELETE_WORKSPACE_OPERATION_ID]: {
          delete: {
            handler: async (ctx): Promise<HookOutput<DeleteHookResult>> => {
              const path = new Path(ctx.workspacePath);
              if (!ctx.intent.payload.removeWorktree) {
                registry.untrack(path, "closed");
                return { result: {} };
              }
              if (fake.failRemoval !== undefined) {
                if (ctx.intent.payload.force) registry.untrack(path, "deleted");
                return { result: { error: fake.failRemoval } };
              }
              foldersOf(ctx.projectPath).delete(path.basename);
              registry.untrack(path, "deleted");
              return { result: {} };
            },
          },
        },
      }),
    },
  };
  return fake;
}
