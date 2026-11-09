// @vitest-environment node
/**
 * Integration tests for the core workspace registry, driven through the
 * dispatcher with the fake project type (plain folders, no git) as the only
 * project type: what a second type gets from the registry for one module. The
 * fake type names no metadata location, so its workspaces' metadata files go
 * under the project's record directory, on an in-memory filesystem.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type {
  HookContext,
  HookOutput,
  Operation,
  OperationSchemas,
} from "../intents/lib/operation";
import type { Intent } from "../intents/lib/types";
import { OPEN_PROJECT_OPERATION_ID, INTENT_OPEN_PROJECT } from "../intents/open-project";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  type FinalizeHookResult,
  type OpenWorkspaceIntent,
} from "../intents/open-workspace";
import {
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  type CloseResolveHookResult,
} from "../intents/close-project";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  type DeleteHookResult,
} from "../intents/delete-workspace";
import {
  ResolveWorkspaceOperation,
  type ResolveWorkspaceResult,
} from "../intents/resolve-workspace";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  type FindCandidatesHookResult,
} from "../intents/switch-workspace";
import {
  LIST_PROJECTS_OPERATION_ID,
  INTENT_LIST_PROJECTS,
  type ListWorkspacesHookResult,
} from "../intents/list-projects";
import type { ProjectPath, WorkspacePath, WorkspaceRef } from "../intents/contract";
import { WorkspaceError } from "../shared/errors/service-errors";
import { makeWorkspaceRef } from "../utils/ref";
import { projPath, wsPath } from "../shared/test-fixtures";
import { DEFAULT_METADATA_DIR, type WorkspaceRegistryModule } from "./workspace-registry-module";
import { createTestWorkspaceRegistry, TEST_PROJECT_DIR } from "./workspace-registry.test-utils";
import type { MockFileSystemBoundary } from "../boundaries/platform/filesystem.state-mock";
import { Path } from "../utils/path/path";
import {
  createFakeProjectType,
  fakeProjectRef,
  type FakeProjectType,
} from "./fake-project-type.test-utils";

// =============================================================================
// Minimal operations: just the hook points the registry and the fake type serve
// =============================================================================

const openProjectOperation = createMinimalOperation(
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  "discover",
  {
    hookContext: (ctx) => {
      const { projectPath } = ctx.intent.payload as { projectPath: ProjectPath };
      return { intent: ctx.intent, projectPath, projectRef: fakeProjectRef(projectPath) };
    },
  }
);

const openWorkspaceOperation = createMinimalOperation(
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  "create",
  {
    hookContext: (ctx) => {
      const { payload } = ctx.intent as OpenWorkspaceIntent;
      const projectPath = payload.project as ProjectPath;
      return {
        intent: ctx.intent,
        projectPath,
        projectRef: fakeProjectRef(projectPath),
        fresh: payload.existingWorkspace === undefined,
        workspaceName: payload.existingWorkspace?.name ?? payload.workspaceName,
      };
    },
  }
);

/** Close: "resolve" (returned, for the assertions), then "close". */
const closeSchemas = {
  type: INTENT_CLOSE_PROJECT,
  payload: z.custom<{ projectPath: ProjectPath }>(),
  result: z.custom<CloseResolveHookResult>(),
} satisfies OperationSchemas;
const closeProjectOperation: Operation<typeof closeSchemas> = {
  id: CLOSE_PROJECT_OPERATION_ID,
  schemas: closeSchemas,
  async execute(ctx) {
    const { projectPath } = ctx.intent.payload;
    const hookCtx = { intent: ctx.intent, projectPath, projectRef: fakeProjectRef(projectPath) };
    const resolved = await ctx.hooks.collect("resolve", hookCtx);
    await ctx.hooks.collect("close", hookCtx);
    return (resolved.results[0] ?? {}) as CloseResolveHookResult;
  },
};

/** Delete: resolve the workspace like the real operation, then "delete". */
const deleteSchemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: z.custom<{ workspaceRef: WorkspaceRef; removeWorktree: boolean; force: boolean }>(),
  result: z.custom<DeleteHookResult>(),
} satisfies OperationSchemas;
const deleteWorkspaceOperation: Operation<typeof deleteSchemas> = {
  id: DELETE_WORKSPACE_OPERATION_ID,
  schemas: deleteSchemas,
  async execute(ctx) {
    const resolved = (await ctx.dispatch({
      type: "workspace:resolve",
      payload: { workspaceRef: ctx.intent.payload.workspaceRef },
    } as Intent)) as ResolveWorkspaceResult;
    // The fields the delete pipeline's hook input carries that the fake type reads.
    const input = {
      intent: ctx.intent,
      projectRef: resolved.projectRef,
      projectPath: resolved.projectPath,
      workspaceRef: resolved.workspaceRef,
      workspacePath: resolved.workspacePath,
    };
    const { results } = await ctx.hooks.collect("delete", input as HookContext);
    return (results[0] ?? {}) as DeleteHookResult;
  },
};

const findCandidatesOperation = createMinimalOperation(
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  "find-candidates"
);

const listWorkspacesOperation = createMinimalOperation(
  LIST_PROJECTS_OPERATION_ID,
  INTENT_LIST_PROJECTS,
  "list-workspaces"
);

// =============================================================================
// Setup and helpers
// =============================================================================

const PROJECT = projPath("/projects/folders");
const OTHER = projPath("/projects/other");

interface Setup {
  dispatcher: Dispatcher;
  fake: FakeProjectType;
  registry: WorkspaceRegistryModule;
  fs: MockFileSystemBoundary;
}

function createSetup(): Setup {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(openProjectOperation);
  dispatcher.registerOperation(openWorkspaceOperation);
  dispatcher.registerOperation(closeProjectOperation);
  dispatcher.registerOperation(deleteWorkspaceOperation);
  dispatcher.registerOperation(new ResolveWorkspaceOperation());
  dispatcher.registerOperation(findCandidatesOperation);
  dispatcher.registerOperation(listWorkspacesOperation);
  const { registry, fs } = createTestWorkspaceRegistry();
  const fake = createFakeProjectType(registry);
  dispatcher.registerModule(registry);
  dispatcher.registerModule(fake.module);
  return { dispatcher, fake, registry, fs };
}

async function run<T>(dispatcher: Dispatcher, type: string, payload: unknown): Promise<T> {
  return (await dispatcher.dispatch({ type, payload } as Intent)) as T;
}

const openProject = (d: Dispatcher, projectPath: ProjectPath): Promise<unknown> =>
  run(d, INTENT_OPEN_PROJECT, { projectPath });

/** Resolve by path or ref; one no module knows reads as empty. */
async function resolve(
  d: Dispatcher,
  by: { workspacePath?: WorkspacePath; workspaceRef?: WorkspaceRef }
): Promise<Partial<ResolveWorkspaceResult>> {
  try {
    return await run<ResolveWorkspaceResult>(d, "workspace:resolve", by);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_FOUND") return {};
    throw error;
  }
}

const refOf = (projectPath: string, name: string): WorkspaceRef =>
  makeWorkspaceRef(fakeProjectRef(projectPath), name);

const create = (d: Dispatcher, projectPath: ProjectPath, workspaceName: string): Promise<unknown> =>
  run(d, INTENT_OPEN_WORKSPACE, { project: projectPath, workspaceName });

const remove = (
  d: Dispatcher,
  workspaceRef: WorkspaceRef,
  options: { force?: boolean; removeWorktree?: boolean } = {}
): Promise<DeleteHookResult> =>
  run(d, INTENT_DELETE_WORKSPACE, {
    workspaceRef,
    removeWorktree: options.removeWorktree ?? true,
    force: options.force ?? false,
  });

const listNames = async (d: Dispatcher, projectPath: string): Promise<string[]> => {
  const listed = await run<ListWorkspacesHookResult>(d, INTENT_LIST_PROJECTS, {});
  const entry = listed.entries?.find((e) => e.projectPath === projectPath);
  return entry?.workspaces.map((w) => w.name) ?? [];
};

// =============================================================================
// Tests
// =============================================================================

describe("WorkspaceRegistryModule", () => {
  let setup: Setup;
  beforeEach(() => {
    setup = createSetup();
  });

  describe("resolve-workspace", () => {
    it("resolves a discovered workspace by its path and by its ref", async () => {
      const { dispatcher, fake } = setup;
      const path = fake.addFolder(PROJECT, "alpha", { title: "Alpha" });
      await openProject(dispatcher, PROJECT);

      const byPath = await resolve(dispatcher, { workspacePath: wsPath(path.toString()) });
      const byRef = await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") });

      for (const result of [byPath, byRef]) {
        expect(result).toMatchObject({
          workspaceRef: refOf(PROJECT, "alpha"),
          workspacePath: path.toString(),
          projectRef: fakeProjectRef(PROJECT),
          projectPath: PROJECT,
          workspaceName: "alpha",
          branch: null,
          metadata: { title: "Alpha" },
        });
      }
    });

    it("resolves a path inside a workspace to that workspace", async () => {
      // The `ch` CLI knows its working directory, not the workspace root.
      const { dispatcher, fake } = setup;
      const path = fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);

      const result = await resolve(dispatcher, {
        workspacePath: wsPath(`${path.toString()}/src/deep`),
      });
      expect(result.workspaceName).toBe("alpha");
    });

    it("does not let a workspace claim a sibling whose name extends it", async () => {
      // A bare startsWith would resolve alpha-old to alpha.
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);

      const result = await resolve(dispatcher, { workspacePath: wsPath(`${PROJECT}/alpha-old`) });
      expect(result.workspaceName).toBeUndefined();
    });

    it("resolves to the innermost workspace when they nest", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "outer");
      fake.addFolder(PROJECT, "outer/inner");
      await openProject(dispatcher, PROJECT);

      const result = await resolve(dispatcher, {
        workspacePath: wsPath(`${PROJECT}/outer/inner/src`),
      });
      expect(result.workspaceName).toBe("outer/inner");
    });

    it("answers with the stored name, not one derived from the path", async () => {
      // On Windows Path lowercases, so a path-derived name would break the
      // renderer's case-sensitive name matching.
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "SDK-214");
      await openProject(dispatcher, PROJECT);

      const result = await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "SDK-214") });
      expect(result.workspaceName).toBe("SDK-214");
    });

    it("knows nothing of a workspace no project type reported", async () => {
      const { dispatcher } = setup;
      await openProject(dispatcher, PROJECT);

      expect(await resolve(dispatcher, { workspacePath: wsPath("/elsewhere") })).toEqual({});
      expect(await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "ghost") })).toEqual({});
    });

    it("resolves a workspace the type created", async () => {
      const { dispatcher } = setup;
      await openProject(dispatcher, PROJECT);

      await create(dispatcher, PROJECT, "fresh");

      const result = await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "fresh") });
      expect(result.workspacePath).toBe(`${PROJECT}/fresh`);
    });
  });

  describe("open-workspace -> create", () => {
    it("refuses a name the project already has, ignoring case, before the type creates anything", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "feat");
      await openProject(dispatcher, PROJECT);

      await expect(create(dispatcher, PROJECT, "Feat")).rejects.toThrow(
        "Workspace 'Feat' already exists"
      );
      expect(fake.created).toEqual([]);
    });

    it("lets another project use the same name", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "feat");
      await openProject(dispatcher, PROJECT);
      await openProject(dispatcher, OTHER);

      await create(dispatcher, OTHER, "feat");

      expect(fake.created).toEqual(["feat"]);
    });

    it("reopens a held workspace without replacing what the registry holds", async () => {
      const { dispatcher, fake } = setup;
      const path = fake.addFolder(PROJECT, "alpha", { title: "Held" });
      await openProject(dispatcher, PROJECT);

      await run(dispatcher, INTENT_OPEN_WORKSPACE, {
        project: PROJECT,
        workspaceName: "alpha",
        existingWorkspace: {
          path: path.toString(),
          name: "alpha",
          branch: null,
          metadata: { title: "Stale" },
        },
      });

      const result = await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") });
      expect(result.metadata).toEqual({ title: "Held" });
    });
  });

  describe("switch-workspace -> find-candidates", () => {
    it("offers every workspace of every project, flagging hibernated ones", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "awake");
      fake.addFolder(PROJECT, "asleep", { hibernated: "true" });
      fake.addFolder(OTHER, "elsewhere");
      await openProject(dispatcher, PROJECT);
      await openProject(dispatcher, OTHER);

      const { candidates } = await run<FindCandidatesHookResult>(
        dispatcher,
        INTENT_SWITCH_WORKSPACE,
        {}
      );

      expect(candidates).toEqual([
        {
          projectRef: fakeProjectRef(PROJECT),
          projectName: "folders",
          workspaceRef: refOf(PROJECT, "awake"),
          workspaceName: "awake",
        },
        {
          projectRef: fakeProjectRef(PROJECT),
          projectName: "folders",
          workspaceRef: refOf(PROJECT, "asleep"),
          workspaceName: "asleep",
          hibernated: true,
        },
        {
          projectRef: fakeProjectRef(OTHER),
          projectName: "other",
          workspaceRef: refOf(OTHER, "elsewhere"),
          workspaceName: "elsewhere",
        },
      ]);
    });
  });

  describe("list-projects -> list-workspaces", () => {
    it("lists each open project's workspaces, an empty project included", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      fake.addFolder(PROJECT, "beta");
      await openProject(dispatcher, PROJECT);
      await openProject(dispatcher, OTHER);

      const listed = await run<ListWorkspacesHookResult>(dispatcher, INTENT_LIST_PROJECTS, {});

      expect(listed.entries).toEqual([
        {
          projectPath: PROJECT,
          workspaces: [
            { name: "alpha", path: `${PROJECT}/alpha`, branch: null, metadata: {} },
            { name: "beta", path: `${PROJECT}/beta`, branch: null, metadata: {} },
          ],
        },
        { projectPath: OTHER, workspaces: [] },
      ]);
    });
  });

  describe("delete-workspace", () => {
    it("forgets a workspace once the type removed it", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);

      await remove(dispatcher, refOf(PROJECT, "alpha"));

      expect(await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).toEqual({});
      expect(await listNames(dispatcher, PROJECT)).toEqual([]);
    });

    it("keeps a workspace whose removal failed resolvable, listed and switchable, so it can be retried", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);
      fake.failRemoval = "EBUSY";

      const result = await remove(dispatcher, refOf(PROJECT, "alpha"));
      // Re-opening the open project must not lose it either.
      await openProject(dispatcher, PROJECT);

      expect(result.error).toBe("EBUSY");
      expect(
        (await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).workspaceName
      ).toBe("alpha");
      expect(await listNames(dispatcher, PROJECT)).toEqual(["alpha"]);
      const { candidates } = await run<FindCandidatesHookResult>(
        dispatcher,
        INTENT_SWITCH_WORKSPACE,
        {}
      );
      expect(candidates?.map((c) => c.workspaceName)).toEqual(["alpha"]);
    });

    it("forgets a workspace whose forced removal failed", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);
      fake.failRemoval = "EBUSY";

      await remove(dispatcher, refOf(PROJECT, "alpha"), { force: true });

      expect(await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).toEqual({});
    });
  });

  describe("close-project", () => {
    it("lists the project's workspaces for the close, then forgets them", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      fake.addFolder(PROJECT, "beta");
      fake.addFolder(OTHER, "kept");
      await openProject(dispatcher, PROJECT);
      await openProject(dispatcher, OTHER);

      const closing = await run<CloseResolveHookResult>(dispatcher, INTENT_CLOSE_PROJECT, {
        projectPath: PROJECT,
      });

      expect(closing.workspaces).toEqual([
        { workspaceRef: refOf(PROJECT, "alpha"), workspacePath: `${PROJECT}/alpha` },
        { workspaceRef: refOf(PROJECT, "beta"), workspacePath: `${PROJECT}/beta` },
      ]);
      expect(await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).toEqual({});
      expect(
        (await resolve(dispatcher, { workspaceRef: refOf(OTHER, "kept") })).workspaceName
      ).toBe("kept");
    });

    it("forgets a workspace whose removal failed along with its project", async () => {
      const { dispatcher, fake } = setup;
      fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);
      fake.failRemoval = "EBUSY";
      await remove(dispatcher, refOf(PROJECT, "alpha"));

      await run(dispatcher, INTENT_CLOSE_PROJECT, { projectPath: PROJECT });

      expect(await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).toEqual({});
    });
  });

  describe("metadata", () => {
    /** Where the registry keeps a fake-type workspace's metadata. */
    const fileOf = (name: string): Path =>
      new Path(TEST_PROJECT_DIR, DEFAULT_METADATA_DIR, `${name}.json`);
    const readFile = async (fs: MockFileSystemBoundary, name: string): Promise<unknown> =>
      JSON.parse(await fs.readFile(fileOf(name)));

    it("serves a discovered workspace's metadata from memory, and writes a key to its file", async () => {
      const { dispatcher, fake, registry, fs } = setup;
      const path = fake.addFolder(PROJECT, "alpha", { title: "Alpha" });
      await openProject(dispatcher, PROJECT);

      await registry.setMetadata(path, "note", "WIP");

      expect(registry.metadata(path)).toEqual({ title: "Alpha", note: "WIP" });
      expect(
        (await resolve(dispatcher, { workspaceRef: refOf(PROJECT, "alpha") })).metadata
      ).toEqual({ title: "Alpha", note: "WIP" });
      expect(await readFile(fs, "alpha")).toEqual({
        version: 1,
        internal: {},
        protected: {},
        public: { title: "Alpha", note: "WIP" },
      });
    });

    it("reads the file back when the project opens again", async () => {
      const { dispatcher, fake, registry } = setup;
      const path = fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);
      await registry.setMetadata(path, "note", "WIP");

      await run(dispatcher, INTENT_CLOSE_PROJECT, { projectPath: PROJECT });
      expect(() => registry.metadata(path)).toThrow(WorkspaceError);
      await openProject(dispatcher, PROJECT);

      expect(registry.metadata(path)).toEqual({ note: "WIP" });
    });

    it("records a created workspace's name in its new file", async () => {
      const { dispatcher, registry, fs } = setup;
      await openProject(dispatcher, PROJECT);

      await create(dispatcher, PROJECT, "fresh");

      expect(registry.metadata(new Path(PROJECT, "fresh"))).toEqual({ name: "fresh" });
      expect(await readFile(fs, "fresh")).toMatchObject({ protected: { name: "fresh" } });
    });

    it("deletes the file with the workspace", async () => {
      const { dispatcher, fs } = setup;
      await openProject(dispatcher, PROJECT);
      await create(dispatcher, PROJECT, "fresh");

      await remove(dispatcher, refOf(PROJECT, "fresh"));

      await expect(fs.readFile(fileOf("fresh"))).rejects.toThrow();
    });

    it("keeps the file when only the workspace's runtime is torn down", async () => {
      const { dispatcher, fs } = setup;
      await openProject(dispatcher, PROJECT);
      await create(dispatcher, PROJECT, "fresh");

      await remove(dispatcher, refOf(PROJECT, "fresh"), { removeWorktree: false });

      expect(await readFile(fs, "fresh")).toMatchObject({ protected: { name: "fresh" } });
    });

    it("leaves memory as it was when a write fails", async () => {
      const { dispatcher, fake, registry, fs } = setup;
      const path = fake.addFolder(PROJECT, "alpha", { title: "Alpha" });
      await openProject(dispatcher, PROJECT);
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));

      await expect(registry.setMetadata(path, "title", "Beta")).rejects.toThrow("disk full");

      expect(registry.metadata(path)).toEqual({ title: "Alpha" });
    });

    it("refuses a malformed key and a workspace it does not hold", async () => {
      const { dispatcher, fake, registry } = setup;
      const path = fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);

      await expect(registry.setMetadata(path, "bad_key", "x")).rejects.toMatchObject({
        code: "INVALID_METADATA_KEY",
      });
      await expect(
        registry.setMetadata(new Path(PROJECT, "ghost"), "note", "x")
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      expect(() => registry.metadata(new Path(PROJECT, "ghost"))).toThrow(WorkspaceError);
    });

    it("flags a workspace hibernated once its metadata says so", async () => {
      const { dispatcher, fake, registry } = setup;
      const path = fake.addFolder(PROJECT, "alpha");
      await openProject(dispatcher, PROJECT);

      await registry.setMetadata(path, "hibernated", "true");

      const { candidates } = await run<FindCandidatesHookResult>(
        dispatcher,
        INTENT_SWITCH_WORKSPACE,
        {}
      );
      expect(candidates?.[0]?.hibernated).toBe(true);
    });

    it("finalizes an opened workspace with the metadata held now, a write made during creation included", async () => {
      // An agent acting on its own workspace mid-creation writes through
      // workspace:set-metadata, which no hook result reports.
      const { dispatcher, registry } = setup;
      await openProject(dispatcher, PROJECT);
      await create(dispatcher, PROJECT, "fresh");
      const path = new Path(PROJECT, "fresh");
      await registry.setMetadata(path, "title", "renamed by agent");

      // The registry's own finalize handler, as open-workspace runs it last.
      const output = (await registry.hooks![OPEN_WORKSPACE_OPERATION_ID]!["finalize"]!.handler({
        intent: { type: INTENT_OPEN_WORKSPACE, payload: {} },
        workspacePath: path.toString(),
      } as HookContext)) as HookOutput<FinalizeHookResult>;

      expect(output.result).toEqual({ metadata: { name: "fresh", title: "renamed by agent" } });
    });
  });
});
