// @vitest-environment node
/**
 * Integration tests for GitWorktreeWorkspaceModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers ->
 * GitWorktreeProvider calls + internal state management.
 *
 * Uses minimal test operations that exercise specific hook points, with
 * mock GitWorktreeProvider and PathProvider dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import type { PathProvider } from "../../services/platform/path-provider";
import type { Workspace } from "../../services/git/types";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import type { DiscoverHookResult, DiscoverHookInput } from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import type { CloseHookInput } from "../operations/close-project";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type { OpenWorkspaceIntent } from "../operations/open-workspace";
import type { CreateHookInput, CreateHookResult } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
} from "../operations/delete-workspace";
import type {
  DeleteHookResult,
  ResolveHookInput as DeleteResolveInput,
} from "../operations/delete-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import type {
  GetStatusHookInput,
  GetStatusHookResult,
  ResolveHookResult as GetStatusResolveHookResult,
} from "../operations/get-workspace-status";
import { createGitWorktreeWorkspaceModule } from "./git-worktree-workspace-module";
import type { FetchBasesHookResult } from "./git-worktree-workspace-module";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { ProjectId } from "../../shared/api/types";

// =============================================================================
// Mock Dependencies
// =============================================================================

function createMockGitWorktreeProvider() {
  return {
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    discover: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn(),
    removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
    isDirty: vi.fn().mockResolvedValue(false),
    listBases: vi.fn().mockResolvedValue([]),
    defaultBase: vi.fn().mockResolvedValue(undefined),
    cleanupOrphanedWorkspaces: vi.fn().mockResolvedValue({ removedCount: 0, failedPaths: [] }),
    validateRepository: vi.fn().mockResolvedValue(undefined),
    ensureWorkspaceRegistered: vi.fn(),
  };
}

function createMockPathProvider(): PathProvider {
  return {
    getProjectWorkspacesDir: vi.fn().mockReturnValue(new Path("/workspaces")),
  } as unknown as PathProvider;
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

/**
 * Open-project operation: runs "discover" hook point.
 */
class MinimalOpenProjectOperation implements Operation<Intent, DiscoverHookResult> {
  readonly id = OPEN_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<DiscoverHookResult> {
    const input: DiscoverHookInput = {
      intent: ctx.intent,
      projectPath: (ctx.intent.payload as { projectPath: string }).projectPath,
    };
    const { results, errors } = await ctx.hooks.collect<DiscoverHookResult>("discover", input);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? { workspaces: [] };
  }
}

/**
 * Close-project operation: runs "close" hook point.
 */
class MinimalCloseProjectOperation implements Operation<Intent, Record<string, never>> {
  readonly id = CLOSE_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<Record<string, never>> {
    const payload = ctx.intent.payload as { projectPath: string };
    const input: CloseHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath,
      removeLocalRepo: false,
    };
    const { results, errors } = await ctx.hooks.collect<Record<string, never>>("close", input);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

/**
 * Open-workspace operation: runs "create" hook point.
 */
class MinimalOpenWorkspaceOperation implements Operation<OpenWorkspaceIntent, CreateHookResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<CreateHookResult> {
    const payload = ctx.intent.payload as { projectPath?: string };
    const input: CreateHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath ?? "",
    };
    const { results, errors } = await ctx.hooks.collect<CreateHookResult>("create", input);
    if (errors.length > 0) throw errors[0]!;
    return results[0]!;
  }
}

/** Extended delete result that includes the resolved path and possible error. */
interface DeleteResult extends DeleteHookResult {
  readonly resolvedPath?: string;
}

/**
 * Delete-workspace operation: runs "resolve-workspace" then "delete" hook points.
 */
class MinimalDeleteWorkspaceOperation implements Operation<DeleteWorkspaceIntent, DeleteResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<DeleteResult> {
    const { payload } = ctx.intent;

    // resolve (workspacePath → projectPath + workspaceName, matching real operation)
    const resolveInput: DeleteResolveInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults } = await ctx.hooks.collect<{
      projectPath?: string;
    }>("resolve", resolveInput);
    const resolved = resolveResults[0];
    const resolvedProjectPath = resolved?.projectPath ?? "";

    // delete (enriched with both paths, matching real operation's DeletePipelineHookInput)
    const deleteInput: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: resolvedProjectPath,
      workspacePath: payload.workspacePath,
    };
    const { results: deleteResults, errors: deleteErrors } =
      await ctx.hooks.collect<DeleteHookResult>("delete", deleteInput);
    if (deleteErrors.length > 0 && !payload.force) throw deleteErrors[0]!;

    return {
      ...deleteResults[0],
      ...(resolvedProjectPath !== "" && { resolvedPath: payload.workspacePath }),
    };
  }
}

/** Result from workspace path resolution (reverse lookup: workspacePath → projectPath + workspaceName). */
interface ResolveResult {
  readonly projectPath?: string | undefined;
  readonly workspaceName?: string | undefined;
}

/**
 * Resolve-workspace operation: runs "resolve" hook point via switch-workspace.
 *
 * Uses SWITCH_WORKSPACE_OPERATION_ID because the module registers its
 * resolve hook under that operation. Accepts workspacePath and reverse-looks
 * up projectPath + workspaceName.
 */
class MinimalResolveWorkspaceOperation implements Operation<Intent, ResolveResult> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<ResolveResult> {
    const payload = ctx.intent.payload as { workspacePath: string };
    const resolveInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults } = await ctx.hooks.collect<{
      projectPath?: string;
      workspaceName?: string;
    }>("resolve", resolveInput);
    const projectPath = resolveResults[0]?.projectPath;
    const workspaceName = resolveResults[0]?.workspaceName;
    return projectPath ? { projectPath, workspaceName } : {};
  }
}

/**
 * Fetch-bases operation: runs "fetch-bases" hook point on the open-workspace operation.
 */
class MinimalFetchBasesOperation implements Operation<Intent, FetchBasesHookResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<FetchBasesHookResult> {
    const payload = ctx.intent.payload as { projectPath: string };
    const input = {
      intent: ctx.intent,
      projectPath: payload.projectPath,
    };
    const { results, errors } = await ctx.hooks.collect<FetchBasesHookResult>("fetch-bases", input);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? { bases: [] };
  }
}

/** Result from get-workspace-status: resolve-workspace + get. */
interface GetStatusResult {
  readonly isDirty?: boolean;
}

/**
 * Get-workspace-status operation: runs "resolve" then "get" hook points.
 * Mirrors the real GetWorkspaceStatusOperation.
 */
class MinimalGetStatusOperation implements Operation<Intent, GetStatusResult> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<GetStatusResult> {
    const payload = ctx.intent.payload as { workspacePath: string };

    // resolve (workspacePath → projectPath + workspaceName)
    const resolveInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults } = await ctx.hooks.collect<GetStatusResolveHookResult>(
      "resolve",
      resolveInput
    );
    let found = false;
    for (const r of resolveResults) {
      if (r.projectPath !== undefined) found = true;
    }
    if (!found) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    // get
    const getInput: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", getInput);
    if (errors.length > 0) throw errors[0]!;

    let isDirty = false;
    for (const result of results) {
      if (result.isDirty) isDirty = true;
    }
    return { isDirty };
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  provider: ReturnType<typeof createMockGitWorktreeProvider>;
  pathProvider: PathProvider;
}

function createTestSetup(): TestSetup {
  const provider = createMockGitWorktreeProvider();
  const pathProvider = createMockPathProvider();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register operations
  dispatcher.registerOperation("project:open", new MinimalOpenProjectOperation());
  dispatcher.registerOperation("project:close", new MinimalCloseProjectOperation());
  dispatcher.registerOperation("workspace:open", new MinimalOpenWorkspaceOperation());
  dispatcher.registerOperation("workspace:delete", new MinimalDeleteWorkspaceOperation());
  dispatcher.registerOperation("workspace:resolve", new MinimalResolveWorkspaceOperation());
  dispatcher.registerOperation("open-workspace", new MinimalFetchBasesOperation());
  dispatcher.registerOperation("workspace:get-status", new MinimalGetStatusOperation());

  // Wire the module under test
  const module = createGitWorktreeWorkspaceModule(
    provider as unknown as GitWorktreeProvider,
    pathProvider,
    SILENT_LOGGER
  );
  dispatcher.registerModule(module);

  return { dispatcher, provider, pathProvider };
}

// =============================================================================
// Test Helpers
// =============================================================================

function makeWorkspace(name: string, projectPath: string): Workspace {
  return {
    name,
    path: new Path(`${projectPath}/.worktrees/${name}`),
    branch: name,
    metadata: { base: "origin/main" },
  };
}

// Typed dispatch helpers to avoid casting at every call site

async function dispatchOpenProject(
  dispatcher: Dispatcher,
  projectPath: string
): Promise<DiscoverHookResult> {
  return (await dispatcher.dispatch({
    type: "project:open",
    payload: { projectPath },
  } as Intent)) as DiscoverHookResult;
}

async function dispatchCloseProject(dispatcher: Dispatcher, projectPath: string): Promise<void> {
  await dispatcher.dispatch({
    type: "project:close",
    payload: { projectPath },
  } as Intent);
}

async function dispatchResolveWorkspace(
  dispatcher: Dispatcher,
  workspacePath: string
): Promise<ResolveResult> {
  return (await dispatcher.dispatch({
    type: "workspace:resolve",
    payload: { workspacePath },
  } as Intent)) as ResolveResult;
}

async function dispatchFetchBases(
  dispatcher: Dispatcher,
  projectPath: string
): Promise<FetchBasesHookResult> {
  return (await dispatcher.dispatch({
    type: "open-workspace",
    payload: { projectPath },
  } as Intent)) as FetchBasesHookResult;
}

async function dispatchGetStatus(
  dispatcher: Dispatcher,
  workspacePath: string
): Promise<GetStatusResult> {
  return (await dispatcher.dispatch({
    type: "workspace:get-status",
    payload: { workspacePath },
  } as Intent)) as GetStatusResult;
}

async function dispatchCreateWorkspace(
  dispatcher: Dispatcher,
  intent: OpenWorkspaceIntent
): Promise<CreateHookResult> {
  // Cast through Intent to bypass phantom type inference (test operation returns CreateHookResult)
  return (await dispatcher.dispatch(intent as unknown as Intent)) as CreateHookResult;
}

async function dispatchDeleteWorkspace(
  dispatcher: Dispatcher,
  intent: DeleteWorkspaceIntent
): Promise<DeleteResult> {
  // Cast through Intent to bypass phantom type inference (test operation returns DeleteResult)
  return (await dispatcher.dispatch(intent as unknown as Intent)) as DeleteResult;
}

// =============================================================================
// Tests
// =============================================================================

describe("GitWorktreeWorkspaceModule Integration", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  // ---------------------------------------------------------------------------
  // open-project -> discover
  // ---------------------------------------------------------------------------

  describe("open-project -> discover", () => {
    it("registers project, discovers workspaces, returns them", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = "/projects/my-app";

      const ws1 = makeWorkspace("feature-1", projectPath);
      const ws2 = makeWorkspace("feature-2", projectPath);
      provider.discover.mockResolvedValue([ws1, ws2]);

      const result = await dispatchOpenProject(dispatcher, projectPath);

      expect(provider.registerProject).toHaveBeenCalledWith(
        new Path(projectPath),
        new Path("/workspaces")
      );
      expect(provider.discover).toHaveBeenCalledWith(new Path(projectPath));
      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces[0]!.name).toBe("feature-1");
      expect(result.workspaces[1]!.name).toBe("feature-2");
    });

    it("calls fire-and-forget cleanupOrphanedWorkspaces", async () => {
      const { dispatcher, provider } = setup;

      await dispatchOpenProject(dispatcher, "/projects/my-app");

      expect(provider.cleanupOrphanedWorkspaces).toHaveBeenCalledWith(new Path("/projects/my-app"));
    });
  });

  // ---------------------------------------------------------------------------
  // close-project -> close
  // ---------------------------------------------------------------------------

  describe("close-project -> close", () => {
    it("unregisters project and clears state", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = "/projects/my-app";

      // Open first
      const ws = makeWorkspace("feature-1", projectPath);
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projectPath);

      // Close
      await dispatchCloseProject(dispatcher, projectPath);

      expect(provider.unregisterProject).toHaveBeenCalledWith(new Path(projectPath));

      // Subsequent resolve should return empty (no projectPath)
      const resolveResult = await dispatchResolveWorkspace(
        dispatcher,
        `${projectPath}/.worktrees/feature-1`
      );
      expect(resolveResult.projectPath).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // open-workspace -> create
  // ---------------------------------------------------------------------------

  describe("open-workspace -> create", () => {
    describe("new workspace", () => {
      it("calls createWorkspace and updates state", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = "/projects/my-app";

        // Open project first
        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projectPath);

        // Mock createWorkspace
        const createdWs: Workspace = {
          name: "new-feature",
          path: new Path("/workspaces/new-feature"),
          branch: "new-feature",
          metadata: { base: "origin/main" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            projectId: "my-app-12345678" as ProjectId,
            workspaceName: "new-feature",
            base: "origin/main",
            projectPath,
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.createWorkspace).toHaveBeenCalledWith(
          new Path(projectPath),
          "new-feature",
          "origin/main"
        );
        expect(result.workspacePath).toBe("/workspaces/new-feature");
        expect(result.branch).toBe("new-feature");

        // Verify state was updated (resolve should find it)
        const resolveResult = await dispatchResolveWorkspace(dispatcher, "/workspaces/new-feature");
        expect(resolveResult.projectPath).toBe(projectPath);
      });
    });

    describe("existing workspace", () => {
      it("skips provider call and updates state", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = "/projects/my-app";

        // Open project first
        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projectPath);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            projectId: "my-app-12345678" as ProjectId,
            workspaceName: "existing-ws",
            base: "origin/main",
            projectPath,
            existingWorkspace: {
              path: "/workspaces/existing-ws",
              name: "existing-ws",
              branch: "existing-ws",
              metadata: { base: "origin/main" },
            },
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.createWorkspace).not.toHaveBeenCalled();
        expect(result.workspacePath).toBe("/workspaces/existing-ws");
        expect(result.branch).toBe("existing-ws");

        // Verify state was updated
        const resolveResult = await dispatchResolveWorkspace(dispatcher, "/workspaces/existing-ws");
        expect(resolveResult.projectPath).toBe(projectPath);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // delete-workspace
  // ---------------------------------------------------------------------------

  describe("delete-workspace", () => {
    async function setupWithWorkspace(
      d: Dispatcher,
      p: ReturnType<typeof createMockGitWorktreeProvider>
    ) {
      const projectPath = "/projects/my-app";
      const ws = makeWorkspace("feature-1", projectPath);
      p.discover.mockResolvedValue([ws]);

      await dispatchOpenProject(d, projectPath);

      return { projectPath, ws };
    }

    describe("resolve-workspace", () => {
      it("returns projectPath for known workspace", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath } = await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(
          dispatcher,
          `${projectPath}/.worktrees/feature-1`
        );
        expect(result.projectPath).toBe(projectPath);
      });

      it("returns empty for unknown workspace", async () => {
        const { dispatcher, provider } = setup;
        await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(dispatcher, "/nonexistent/path");
        expect(result.projectPath).toBeUndefined();
      });
    });

    describe("delete", () => {
      it("calls removeWorkspace when removeWorktree=true", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspacePath: ws.path.toString(),
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        };

        await dispatchDeleteWorkspace(dispatcher, deleteIntent);

        expect(provider.removeWorkspace).toHaveBeenCalledWith(new Path(projectPath), ws.path, true);
      });

      it("does not call removeWorkspace when removeWorktree=false", async () => {
        const { dispatcher, provider } = setup;
        const { ws } = await setupWithWorkspace(dispatcher, provider);

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspacePath: ws.path.toString(),
            keepBranch: true,
            force: false,
            removeWorktree: false,
          },
        };

        await dispatchDeleteWorkspace(dispatcher, deleteIntent);

        expect(provider.removeWorkspace).not.toHaveBeenCalled();
      });

      it("clears workspace from state after deletion", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspacePath: ws.path.toString(),
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        };

        await dispatchDeleteWorkspace(dispatcher, deleteIntent);

        // Workspace should no longer be resolvable
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          `${projectPath}/.worktrees/feature-1`
        );
        expect(resolveResult.projectPath).toBeUndefined();
      });
    });

    describe("force mode", () => {
      it("catches error, unregisters workspace, and returns error", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

        provider.removeWorkspace.mockRejectedValue(new Error("git error"));

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspacePath: ws.path.toString(),
            keepBranch: false,
            force: true,
            removeWorktree: true,
          },
        };

        const result = await dispatchDeleteWorkspace(dispatcher, deleteIntent);

        expect(result.error).toBe("git error");

        // Workspace should still be unregistered from state
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          `${projectPath}/.worktrees/feature-1`
        );
        expect(resolveResult.projectPath).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // open-workspace -> fetch-bases
  // ---------------------------------------------------------------------------

  describe("open-workspace -> fetch-bases", () => {
    it("returns bases and defaultBaseBranch from provider", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = "/projects/my-app";

      provider.listBases.mockResolvedValue([
        { name: "origin/main", isRemote: true, base: "origin/main" },
        { name: "main", isRemote: false, base: "origin/main" },
      ]);
      provider.defaultBase.mockResolvedValue("origin/main");

      const result = await dispatchFetchBases(dispatcher, projectPath);

      expect(provider.listBases).toHaveBeenCalledWith(new Path(projectPath));
      expect(provider.defaultBase).toHaveBeenCalledWith(new Path(projectPath));
      expect(result.bases).toHaveLength(2);
      expect(result.defaultBaseBranch).toBe("origin/main");
    });
  });

  // ---------------------------------------------------------------------------
  // get-workspace-status -> get
  // ---------------------------------------------------------------------------

  describe("get-workspace-status -> get", () => {
    it("calls isDirty and returns result", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = "/projects/my-app";

      const ws = makeWorkspace("feature-1", projectPath);
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projectPath);

      provider.isDirty.mockResolvedValue(true);

      const result = await dispatchGetStatus(dispatcher, ws.path.toString());

      expect(provider.isDirty).toHaveBeenCalledWith(ws.path);
      expect(result.isDirty).toBe(true);
    });

    it("returns isDirty=false when workspace is clean", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = "/projects/my-app";

      const ws = makeWorkspace("feature-1", projectPath);
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projectPath);

      provider.isDirty.mockResolvedValue(false);

      const result = await dispatchGetStatus(dispatcher, ws.path.toString());

      expect(result.isDirty).toBe(false);
    });
  });
});
