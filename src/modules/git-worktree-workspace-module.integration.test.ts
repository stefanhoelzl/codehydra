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

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";

import { z } from "zod/v4";
import type {
  Operation,
  OperationSchemas,
  HookContext,
  HookOutput,
} from "../intents/lib/operation";
import type { Intent, DomainEvent } from "../intents/lib/types";
import type { IntentModule } from "../intents/lib/module";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import type { PathProvider } from "../boundaries/platform/path-provider";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import type { Workspace } from "../boundaries/platform/git-types";
import { OPEN_PROJECT_OPERATION_ID, INTENT_OPEN_PROJECT } from "../intents/open-project";
import type { DiscoverHookResult } from "../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID, INTENT_CLOSE_PROJECT } from "../intents/close-project";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import type { OpenWorkspaceIntent } from "../intents/open-workspace";
import type { CreateHookResult } from "../intents/open-workspace";
import {
  GET_PROJECT_BASES_OPERATION_ID,
  INTENT_GET_PROJECT_BASES,
} from "../intents/get-project-bases";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  preflightResultSchema,
  deleteResultSchema,
} from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent, DeletePipelineHookInput } from "../intents/delete-workspace";
import type { DeleteHookResult } from "../intents/delete-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
  getStatusHookResultSchema,
} from "../intents/get-workspace-status";
import type { GetStatusHookInput } from "../intents/get-workspace-status";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
  resolveHookResultSchema,
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
import { EVENT_METADATA_CHANGED, type MetadataChangedEvent } from "../intents/set-metadata";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { createGitWorktreeWorkspaceModule } from "./git-worktree-workspace-module";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import type { MockDialogManager } from "./presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "./presentation/notification-manager.state-mock";
import type { MockNotificationManager } from "./presentation/notification-manager.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";
import { wsPath, projPath } from "../shared/test-fixtures";
import type { WorkspacePath, ProjectPath, WorkspaceClosing } from "../intents/contract";

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
    countUnmergedCommits: vi.fn().mockResolvedValue(0),
    listBases: vi.fn().mockResolvedValue([]),
    defaultBase: vi.fn().mockResolvedValue(undefined),
    updateBases: vi.fn().mockResolvedValue(undefined),
    cleanupOrphanedWorkspaces: vi.fn().mockResolvedValue({ removedCount: 0, failedPaths: [] }),
    validateRepository: vi.fn().mockResolvedValue(undefined),
    ensureWorkspaceRegistered: vi.fn(),
    listUnmanagedWorktrees: vi.fn().mockResolvedValue([]),
    adoptWorktree: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

const openProjectOperation = createMinimalOperation<DiscoverHookResult>(
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  "discover",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: (ctx.intent.payload as { projectPath: ProjectPath }).projectPath,
    }),
  }
);

const closeProjectOperation = createMinimalOperation<Record<string, never>>(
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  "close",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: (ctx.intent.payload as { projectPath: ProjectPath }).projectPath,
      removeLocalRepo: false,
    }),
  }
);

const openWorkspaceOperation = createMinimalOperation<CreateHookResult>(
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  "create",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: (ctx.intent.payload as { projectPath?: ProjectPath }).projectPath ?? "",
    }),
  }
);

/** Preflight result from the delete-workspace preflight hook. */
interface PreflightResult {
  readonly blocked?: boolean | undefined;
  readonly reason?: string | undefined;
}

/**
 * Preflight-only operation: dispatches workspace:resolve then runs "preflight" hook point.
 */
const preflightSchemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: z.custom<DeleteWorkspaceIntent["payload"]>(),
  result: z.custom<PreflightResult>(),
  hooks: { preflight: { result: preflightResultSchema } },
} satisfies OperationSchemas;

const minimalPreflightOperation: Operation<typeof preflightSchemas> = {
  id: DELETE_WORKSPACE_OPERATION_ID,
  schemas: preflightSchemas,
  async execute(ctx): Promise<PreflightResult> {
    const { payload } = ctx.intent;

    let resolvedProjectPath = "";
    try {
      const resolved = (await ctx.dispatch({
        type: "workspace:resolve",
        payload: { workspacePath: payload.workspacePath },
      } as Intent)) as ResolveResult;
      resolvedProjectPath = resolved.projectPath ?? "";
    } catch {
      // Workspace not found
    }

    const preflightInput: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: projPath(resolvedProjectPath),
      workspacePath: payload.workspacePath,
      workspaceName: "test-workspace" as WorkspaceName,
      active: false,
    };
    const { results, errors } = await ctx.hooks.collect("preflight", preflightInput);
    // Mirrors the real operation's throwHookErrors: a handler that cannot
    // determine the state fails the gate closed instead of reporting "clean".
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  },
};

/** Extended delete result that includes the resolved path and possible error. */
interface DeleteResult extends DeleteHookResult {
  readonly resolvedPath?: string;
}

/**
 * Delete-workspace operation: dispatches workspace:resolve then runs "delete" hook point.
 */
const deleteWorkspaceSchemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: z.custom<DeleteWorkspaceIntent["payload"]>(),
  result: z.custom<DeleteResult>(),
  hooks: { delete: { result: deleteResultSchema } },
} satisfies OperationSchemas;

const minimalDeleteWorkspaceOperation: Operation<typeof deleteWorkspaceSchemas> = {
  id: DELETE_WORKSPACE_OPERATION_ID,
  schemas: deleteWorkspaceSchemas,
  async execute(ctx): Promise<DeleteResult> {
    const { payload } = ctx.intent;

    // Dispatch workspace:resolve (matching real operation)
    let resolvedProjectPath = "";
    try {
      const resolved = (await ctx.dispatch({
        type: "workspace:resolve",
        payload: { workspacePath: payload.workspacePath },
      } as Intent)) as ResolveResult;
      resolvedProjectPath = resolved.projectPath ?? "";
    } catch {
      // Workspace not found — continue with empty projectPath
    }

    // delete (enriched with both paths, matching real operation's DeletePipelineHookInput)
    const deleteInput: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: projPath(resolvedProjectPath),
      workspacePath: payload.workspacePath,
      workspaceName: "test-workspace" as WorkspaceName,
      active: false,
    };
    const { results: deleteResults, errors: deleteErrors } = await ctx.hooks.collect(
      "delete",
      deleteInput
    );
    if (deleteErrors.length > 0 && !payload.force) throw deleteErrors[0]!;

    return {
      ...deleteResults[0],
      ...(resolvedProjectPath !== "" && { resolvedPath: payload.workspacePath }),
    };
  },
};

/** Result from workspace path resolution (reverse lookup: workspacePath → projectPath + workspaceName). */
interface ResolveResult {
  readonly projectPath?: ProjectPath | undefined;
  readonly workspaceName?: string | undefined;
  readonly closing?: WorkspaceClosing | null | undefined;
}

/**
 * Resolve-workspace operation: runs "resolve" hook point.
 *
 * Uses RESOLVE_WORKSPACE_OPERATION_ID because the module registers its
 * resolve hook under that operation. Accepts workspacePath and reverse-looks
 * up projectPath + workspaceName.
 */
const resolveWorkspaceSchemas = {
  type: INTENT_RESOLVE_WORKSPACE,
  payload: z.unknown(),
  result: z.custom<ResolveResult>(),
  hooks: { resolve: { result: resolveHookResultSchema } },
} satisfies OperationSchemas;

const minimalResolveWorkspaceOperation: Operation<typeof resolveWorkspaceSchemas> = {
  id: RESOLVE_WORKSPACE_OPERATION_ID,
  schemas: resolveWorkspaceSchemas,
  async execute(ctx): Promise<ResolveResult> {
    const payload = ctx.intent.payload as { workspacePath: WorkspacePath };
    const resolveInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults } = await ctx.hooks.collect("resolve", resolveInput);
    const projectPath = resolveResults.find((r) => r.projectPath !== undefined)?.projectPath;
    const workspaceName = resolveResults.find((r) => r.workspaceName !== undefined)?.workspaceName;
    const closing = resolveResults.find((r) => r.closing !== undefined)?.closing ?? null;
    return projectPath ? { projectPath, workspaceName, closing } : {};
  },
};

/** Result from get-project-bases list + refresh dispatch. */
interface GetProjectBasesTestResult {
  readonly bases?: readonly { name: string; isRemote: boolean }[] | undefined;
  readonly defaultBaseBranch?: string | undefined;
  readonly refreshed?: boolean | undefined;
}

/**
 * Minimal get-project-bases operation: calls "list" hook, then optionally "refresh".
 * The intent payload controls which hooks to run via a `hookPoint` field.
 */
const getProjectBasesSchemas = {
  type: INTENT_GET_PROJECT_BASES,
  payload: z.unknown(),
  result: z.custom<GetProjectBasesTestResult>(),
} satisfies OperationSchemas;

const minimalGetProjectBasesOperation: Operation<typeof getProjectBasesSchemas> = {
  id: GET_PROJECT_BASES_OPERATION_ID,
  schemas: getProjectBasesSchemas,
  async execute(ctx): Promise<GetProjectBasesTestResult> {
    const payload = ctx.intent.payload as {
      projectPath: ProjectPath;
      hookPoint?: "list" | "refresh";
    };
    const hookCtx = { intent: ctx.intent, projectPath: payload.projectPath };

    if (payload.hookPoint === "refresh") {
      const { errors } = await ctx.hooks.collect("refresh", hookCtx);
      if (errors.length > 0) throw errors[0]!;
      return { refreshed: true };
    }

    // Default: list
    const { results, errors } = await ctx.hooks.collect("list", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  },
};

/** Result from get-workspace-status: resolve-workspace + get. */
interface GetStatusResult {
  readonly isDirty?: boolean;
  readonly unmergedCommits?: number;
}

/**
 * Get-workspace-status operation: dispatches workspace:resolve then runs "get" hook point.
 * Mirrors the real GetWorkspaceStatusOperation.
 */
const getStatusSchemas = {
  type: INTENT_GET_WORKSPACE_STATUS,
  payload: z.unknown(),
  result: z.custom<GetStatusResult>(),
  hooks: { get: { result: getStatusHookResultSchema } },
} satisfies OperationSchemas;

const minimalGetStatusOperation: Operation<typeof getStatusSchemas> = {
  id: GET_WORKSPACE_STATUS_OPERATION_ID,
  schemas: getStatusSchemas,
  async execute(ctx): Promise<GetStatusResult> {
    const payload = ctx.intent.payload as { workspacePath: WorkspacePath };

    // Dispatch workspace:resolve (matching real operation)
    const resolved = (await ctx.dispatch({
      type: "workspace:resolve",
      payload: { workspacePath: payload.workspacePath },
    } as Intent)) as ResolveResult;
    if (!resolved.projectPath) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    // get — the real operation re-resolves here and passes `closing` through,
    // so a slow refresh cannot leave handlers acting on a stale value.
    const getInput: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath: wsPath(payload.workspacePath),
      closing: resolved.closing ?? null,
    };
    const { results, errors } = await ctx.hooks.collect("get", getInput);
    if (errors.length > 0) throw errors[0]!;

    let isDirty = false;
    let unmergedCommits = 0;
    for (const result of results) {
      if (result.isDirty) isDirty = true;
      if (result.unmergedCommits !== undefined && result.unmergedCommits > unmergedCommits) {
        unmergedCommits = result.unmergedCommits;
      }
    }
    return { isDirty, unmergedCommits };
  },
};

/**
 * Emit-event operation: emits a domain event from within an operation context.
 * Used to trigger event subscriptions registered by modules.
 */
const emitEventSchemas = {
  type: "emit-event",
  payload: z.unknown(),
} satisfies OperationSchemas;

const minimalEmitEventOperation: Operation<typeof emitEventSchemas> = {
  id: "emit-event",
  schemas: emitEventSchemas,
  async execute(ctx): Promise<void> {
    const event = ctx.intent.payload as DomainEvent;
    ctx.emit(event);
  },
};

const switchWorkspaceOperation = createMinimalOperation<FindCandidatesHookResult>(
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  "find-candidates"
);

const listProjectsOperation = createMinimalOperation<ListWorkspacesHookResult>(
  LIST_PROJECTS_OPERATION_ID,
  INTENT_LIST_PROJECTS,
  "list-workspaces"
);

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  provider: ReturnType<typeof createMockGitWorktreeProvider>;
  pathProvider: PathProvider;
  module: IntentModule;
  /** Drives the `closing` enrichment the status hook reads. */
  closing: Map<string, WorkspaceClosing>;
  /** Dialogs the add-project worktree picker opens. */
  dialogs: MockDialogManager;
  /** Notifications the module raises (adoption failures). */
  notifications: MockNotificationManager;
}

/** The dialog + notification surfaces the module takes as its `ui` dependency. */
function createMockUi(): {
  dialogs: MockDialogManager;
  notifications: MockNotificationManager;
  ui: Parameters<typeof createGitWorktreeWorkspaceModule>[3];
} {
  const dialogs = createMockDialogManager();
  const notifications = createMockNotificationManager();
  return {
    dialogs,
    notifications,
    ui: { dialog: dialogs.ui.dialog, notification: notifications.ui.notification },
  };
}

function createTestSetup(): TestSetup {
  const provider = createMockGitWorktreeProvider();
  const pathProvider = createMockPathProvider({
    getProjectWorkspacesDir: () => new Path("/workspaces"),
  });

  const dispatcher = createMockDispatcher();

  // Register operations
  dispatcher.registerOperation(openProjectOperation);
  dispatcher.registerOperation(closeProjectOperation);
  dispatcher.registerOperation(openWorkspaceOperation);
  dispatcher.registerOperation(minimalDeleteWorkspaceOperation);
  dispatcher.registerOperation(minimalResolveWorkspaceOperation);
  dispatcher.registerOperation(minimalGetProjectBasesOperation);
  dispatcher.registerOperation(minimalGetStatusOperation);
  dispatcher.registerOperation(minimalEmitEventOperation);
  dispatcher.registerOperation(switchWorkspaceOperation);
  dispatcher.registerOperation(listProjectsOperation);

  // Wire the module under test
  const { dialogs, notifications, ui } = createMockUi();
  const module = createGitWorktreeWorkspaceModule(
    provider as unknown as GitWorktreeProvider,
    pathProvider,
    SILENT_LOGGER,
    ui
  );
  dispatcher.registerModule(module);

  // Stands in for workspace-lifecycle-module's resolve contribution: the module
  // under test only ever sees `closing` as hook-context enrichment, so the test
  // supplies it the same way production does — through a resolve handler.
  const closing = new Map<string, WorkspaceClosing>();
  dispatcher.registerModule({
    name: "closing-stub",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext) => {
            const { workspacePath } = ctx as HookContext & { workspacePath: WorkspacePath };
            const reason = closing.get(new Path(workspacePath).toString());
            return { result: reason === undefined ? {} : { closing: reason } };
          },
        },
      },
    },
  });

  return { dispatcher, provider, pathProvider, module, closing, dialogs, notifications };
}

function createPreflightTestSetup(): Omit<TestSetup, "module"> {
  const provider = createMockGitWorktreeProvider();
  const pathProvider = createMockPathProvider({
    getProjectWorkspacesDir: () => new Path("/workspaces"),
  });

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(openProjectOperation);
  dispatcher.registerOperation(minimalPreflightOperation);
  dispatcher.registerOperation(minimalResolveWorkspaceOperation);

  const { dialogs, notifications, ui } = createMockUi();
  const module = createGitWorktreeWorkspaceModule(
    provider as unknown as GitWorktreeProvider,
    pathProvider,
    SILENT_LOGGER,
    ui
  );
  dispatcher.registerModule(module);

  return {
    dispatcher,
    provider,
    pathProvider,
    closing: new Map<string, WorkspaceClosing>(),
    dialogs,
    notifications,
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

function makeWorkspace(name: string, projectPath: ProjectPath): Workspace {
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
  projectPath: ProjectPath
): Promise<DiscoverHookResult> {
  return (await dispatcher.dispatch({
    type: "project:open",
    payload: { projectPath },
  } as Intent)) as DiscoverHookResult;
}

async function dispatchCloseProject(
  dispatcher: Dispatcher,
  projectPath: ProjectPath
): Promise<void> {
  await dispatcher.dispatch({
    type: "project:close",
    payload: { projectPath },
  } as Intent);
}

async function dispatchResolveWorkspace(
  dispatcher: Dispatcher,
  workspacePath: WorkspacePath
): Promise<ResolveResult> {
  return (await dispatcher.dispatch({
    type: "workspace:resolve",
    payload: { workspacePath },
  } as Intent)) as ResolveResult;
}

async function dispatchListBases(
  dispatcher: Dispatcher,
  projectPath: ProjectPath
): Promise<GetProjectBasesTestResult> {
  return (await dispatcher.dispatch({
    type: "project:get-bases",
    payload: { projectPath },
  } as Intent)) as GetProjectBasesTestResult;
}

async function dispatchRefreshBases(
  dispatcher: Dispatcher,
  projectPath: ProjectPath
): Promise<void> {
  await dispatcher.dispatch({
    type: "project:get-bases",
    payload: { projectPath, hookPoint: "refresh" },
  } as Intent);
}

async function dispatchGetStatus(
  dispatcher: Dispatcher,
  workspacePath: WorkspacePath
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

async function dispatchFindCandidates(dispatcher: Dispatcher): Promise<FindCandidatesHookResult> {
  return (await dispatcher.dispatch({
    type: "workspace:switch",
    payload: {},
  } as Intent)) as FindCandidatesHookResult;
}

async function dispatchListWorkspaces(dispatcher: Dispatcher): Promise<ListWorkspacesHookResult> {
  return (await dispatcher.dispatch({
    type: "project:list",
    payload: {},
  } as Intent)) as ListWorkspacesHookResult;
}

async function dispatchPreflight(
  dispatcher: Dispatcher,
  workspacePath: WorkspacePath,
  payloadOverrides?: Partial<DeleteWorkspaceIntent["payload"]>
): Promise<PreflightResult> {
  const intent: DeleteWorkspaceIntent = {
    type: "workspace:delete",
    payload: {
      workspacePath,
      keepBranch: false,
      force: false,
      removeWorktree: true,
      ...payloadOverrides,
    },
  };
  return (await dispatcher.dispatch(intent as unknown as Intent)) as PreflightResult;
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
      const projectPath = projPath("/projects/my-app");

      const ws1 = makeWorkspace("feature-1", projPath(projectPath));
      const ws2 = makeWorkspace("feature-2", projPath(projectPath));
      provider.discover.mockResolvedValue([ws1, ws2]);

      const result = await dispatchOpenProject(dispatcher, projPath(projectPath));

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

      await dispatchOpenProject(dispatcher, projPath("/projects/my-app"));

      expect(provider.cleanupOrphanedWorkspaces).toHaveBeenCalledWith(new Path("/projects/my-app"));
    });

    it("caches the default base from discover and surfaces it via list-workspaces", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      provider.discover.mockResolvedValue([]);
      provider.defaultBase.mockResolvedValue("origin/main");

      await dispatchOpenProject(dispatcher, projPath(projectPath));
      const listed = await dispatchListWorkspaces(dispatcher);

      const entry = listed.entries!.find((e) => e.projectPath === new Path(projectPath).toString());
      expect(entry?.defaultBaseBranch).toBe("origin/main");
    });
  });

  // ---------------------------------------------------------------------------
  // close-project -> close
  // ---------------------------------------------------------------------------

  describe("close-project -> close", () => {
    it("unregisters project and clears state", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      // Open first
      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // Close
      await dispatchCloseProject(dispatcher, projPath(projectPath));

      expect(provider.unregisterProject).toHaveBeenCalledWith(new Path(projectPath));

      // Subsequent resolve should return empty (no projectPath)
      const resolveResult = await dispatchResolveWorkspace(
        dispatcher,
        wsPath(`${projectPath}/.worktrees/feature-1`)
      );
      expect(resolveResult.projectPath).toBeUndefined();
    });

    it("contributes the project's workspaces to the close resolve hook", async () => {
      const { dispatcher, provider, module } = setup;
      const projectPath = projPath("/projects/my-app");
      provider.discover.mockResolvedValue([
        makeWorkspace("feature-1", projPath(projectPath)),
        makeWorkspace("feature-2", projPath(projectPath)),
      ]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // The CloseProjectOperation collects this hook to drive its
      // per-workspace teardown (and the close confirm dialog's count).
      const result = (
        (await module.hooks![CLOSE_PROJECT_OPERATION_ID]!["resolve"]!.handler({
          intent: { type: "project:close", payload: { projectPath } },
        } as HookContext)) as HookOutput<{ workspaces: ReadonlyArray<{ path: string }> }>
      ).result!;

      expect(result.workspaces.map((workspace) => workspace.path)).toEqual([
        `${projectPath}/.worktrees/feature-1`,
        `${projectPath}/.worktrees/feature-2`,
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // open-workspace -> create
  // ---------------------------------------------------------------------------

  describe("open-workspace -> create", () => {
    describe("new workspace", () => {
      it("calls createWorkspace and updates state", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        // Open project first
        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

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
            workspaceName: "new-feature",
            base: "origin/main",
            projectPath,
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.createWorkspace).toHaveBeenCalledWith(
          new Path(projectPath),
          "new-feature",
          "origin/main",
          undefined
        );
        expect(result.workspacePath).toBe("/workspaces/new-feature");
        expect(result.branch).toBe("new-feature");

        // Verify state was updated (resolve should find it)
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          wsPath("/workspaces/new-feature")
        );
        expect(resolveResult.projectPath).toBe(projectPath);
      });
    });

    describe("existing workspace", () => {
      it("skips provider call and updates state", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        // Open project first
        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "existing-ws",
            base: "origin/main",
            projectPath,
            existingWorkspace: {
              path: wsPath("/workspaces/existing-ws"),
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
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          wsPath("/workspaces/existing-ws")
        );
        expect(resolveResult.projectPath).toBe(projectPath);
      });
    });

    describe("base resolution", () => {
      it("resolves default base via defaultBase() when base is omitted", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        provider.defaultBase.mockResolvedValue("origin/main");

        const createdWs: Workspace = {
          name: "auto-base",
          path: new Path("/workspaces/auto-base"),
          branch: "auto-base",
          metadata: { base: "origin/main" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "auto-base",
            projectPath,
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.defaultBase).toHaveBeenCalledWith(new Path(projectPath));
        expect(provider.createWorkspace).toHaveBeenCalledWith(
          new Path(projectPath),
          "auto-base",
          "origin/main",
          undefined
        );
        expect(result.resolvedBase).toBe("origin/main");
      });

      it("throws when base is omitted and no default branch exists", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        provider.defaultBase.mockResolvedValue(undefined);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "no-base",
            projectPath,
          },
        };

        await expect(dispatchCreateWorkspace(dispatcher, createIntent)).rejects.toThrow(
          "No base branch specified and no default branch could be detected"
        );
      });

      it("includes base branch in error when createWorkspace fails", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        provider.createWorkspace.mockRejectedValue(
          new Error("Failed to create branch focus-test-1: fatal: not a valid object name: 'main'")
        );

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "focus-test-1",
            base: "main",
            projectPath,
          },
        };

        await expect(dispatchCreateWorkspace(dispatcher, createIntent)).rejects.toThrow(
          "(base: 'main')"
        );
      });

      it("uses explicit base without calling defaultBase()", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const createdWs: Workspace = {
          name: "explicit-base",
          path: new Path("/workspaces/explicit-base"),
          branch: "explicit-base",
          metadata: { base: "develop" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "explicit-base",
            base: "develop",
            projectPath,
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        // defaultBase should not be called when base is explicitly provided
        // (the mock's default return is undefined, so if it were called and used, createWorkspace would fail)
        expect(provider.createWorkspace).toHaveBeenCalledWith(
          new Path(projectPath),
          "explicit-base",
          "develop",
          undefined
        );
        expect(result.resolvedBase).toBe("develop");
      });

      it("returns resolvedBase for existing workspace path", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "existing-ws",
            base: "origin/main",
            projectPath,
            existingWorkspace: {
              path: wsPath("/workspaces/existing-ws"),
              name: "existing-ws",
              branch: "existing-ws",
              metadata: { base: "origin/main" },
            },
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);
        expect(result.resolvedBase).toBe("origin/main");
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
      const projectPath = projPath("/projects/my-app");
      const ws = makeWorkspace("feature-1", projPath(projectPath));
      p.discover.mockResolvedValue([ws]);

      await dispatchOpenProject(d, projPath(projectPath));

      return { projectPath, ws };
    }

    describe("resolve-workspace", () => {
      it("returns projectPath for known workspace", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath } = await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/feature-1`)
        );
        expect(result.projectPath).toBe(projectPath);
      });

      it("returns empty for unknown workspace", async () => {
        const { dispatcher, provider } = setup;
        await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(dispatcher, wsPath("/nonexistent/path"));
        expect(result.projectPath).toBeUndefined();
      });

      it("resolves a path inside a workspace to that workspace", async () => {
        // The `ch` CLI knows its working directory, not the worktree root.
        const { dispatcher, provider } = setup;
        const { projectPath } = await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/feature-1/src/deep/nested`)
        );

        expect(result.projectPath).toBe(projectPath);
        expect(result.workspaceName).toBe("feature-1");
      });

      it("does not let a workspace claim a sibling whose name extends it", async () => {
        // A bare startsWith would resolve feature-1-old to feature-1.
        const { dispatcher, provider } = setup;
        const { projectPath } = await setupWithWorkspace(dispatcher, provider);

        const result = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/feature-1-old`)
        );

        expect(result.projectPath).toBeUndefined();
      });

      it("resolves to the innermost workspace when they nest", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");
        const outer: Workspace = {
          name: "outer",
          path: new Path(`${projectPath}/.worktrees/outer`),
          branch: "outer",
          metadata: { base: "main" },
        };
        const inner: Workspace = {
          name: "inner",
          path: new Path(`${projectPath}/.worktrees/outer/nested`),
          branch: "inner",
          metadata: { base: "main" },
        };
        provider.discover.mockResolvedValue([outer, inner]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const result = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/outer/nested/src`)
        );

        expect(result.workspaceName).toBe("inner");
      });

      it("returns the stored workspace name, not the path basename", async () => {
        // Regression: on Windows, Path normalization lowercases the path, so a
        // name re-derived from the path ("sdk-214") diverges from the stored
        // branch-cased name ("SDK-214") and breaks the renderer's
        // case-sensitive name matching for metadata updates.
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");
        const ws: Workspace = {
          name: "SDK-214",
          path: new Path(`${projectPath}/.worktrees/sdk-214`),
          branch: "SDK-214",
          metadata: { base: "origin/main" },
        };
        provider.discover.mockResolvedValue([ws]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const result = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/sdk-214`)
        );
        expect(result.workspaceName).toBe("SDK-214");
      });
    });

    describe("delete", () => {
      it("calls removeWorkspace when removeWorktree=true", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspacePath: wsPath(ws.path.toString()),
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
            workspacePath: wsPath(ws.path.toString()),
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
            workspacePath: wsPath(ws.path.toString()),
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        };

        await dispatchDeleteWorkspace(dispatcher, deleteIntent);

        // Workspace should no longer be resolvable
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          wsPath(`${projectPath}/.worktrees/feature-1`)
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
            workspacePath: wsPath(ws.path.toString()),
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
          wsPath(`${projectPath}/.worktrees/feature-1`)
        );
        expect(resolveResult.projectPath).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // get-project-bases -> list
  // ---------------------------------------------------------------------------

  describe("get-project-bases -> list", () => {
    it("returns bases and defaultBaseBranch from provider", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const bases = [
        { name: "origin/main", isRemote: true, base: "origin/main" },
        { name: "main", isRemote: false, base: "origin/main" },
      ];
      provider.listBases.mockResolvedValue(bases);
      provider.defaultBase.mockResolvedValue("origin/main");

      const result = await dispatchListBases(dispatcher, projPath(projectPath));

      expect(provider.listBases).toHaveBeenCalledWith(new Path(projectPath));
      // defaultBase reuses the already-enumerated bases (no second listBases).
      expect(provider.defaultBase).toHaveBeenCalledWith(new Path(projectPath), bases);
      expect(result.bases).toHaveLength(2);
      expect(result.defaultBaseBranch).toBe("origin/main");
    });
  });

  // ---------------------------------------------------------------------------
  // get-project-bases -> refresh
  // ---------------------------------------------------------------------------

  describe("get-project-bases -> refresh", () => {
    it("calls updateBases on provider", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      await dispatchRefreshBases(dispatcher, projPath(projectPath));

      expect(provider.updateBases).toHaveBeenCalledWith(new Path(projectPath));
    });
  });

  // ---------------------------------------------------------------------------
  // get-workspace-status -> get
  // ---------------------------------------------------------------------------

  describe("get-workspace-status -> get", () => {
    it("calls isDirty and returns result", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(true);

      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(provider.isDirty).toHaveBeenCalledWith(ws.path);
      expect(result.isDirty).toBe(true);
    });

    it("returns isDirty=false when workspace is clean", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(false);

      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(result.isDirty).toBe(false);
    });

    it("spawns no git for a workspace a teardown owns", async () => {
      const { dispatcher, provider, closing } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(true);
      provider.countUnmergedCommits.mockResolvedValue(3);
      closing.set(ws.path.toString(), "delete");

      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      // Both of these spawn git with the workspace as CWD. On Windows that is
      // enough to make `git worktree remove` fail with "Permission denied" on
      // the directory, which is the bug this gate exists to prevent.
      expect(provider.isDirty).not.toHaveBeenCalled();
      expect(provider.countUnmergedCommits).not.toHaveBeenCalled();
      // Same answer isDirty already gives for a torn-down worktree.
      expect(result.isDirty).toBe(false);
      expect(result.unmergedCommits).toBe(0);
    });

    it("reads git again once the teardown released the workspace", async () => {
      const { dispatcher, provider, closing } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(true);
      closing.set(ws.path.toString(), "delete");
      await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      // A failed delete leaves the workspace alive — its status must work again
      // rather than reporting a permanent, misleading "clean".
      closing.delete(ws.path.toString());
      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(provider.isDirty).toHaveBeenCalledWith(ws.path);
      expect(result.isDirty).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // delete-workspace -> preflight
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> preflight", () => {
    /** Open a project with one workspace and return its path. */
    async function setupWorkspace(
      preflightSetup: Omit<TestSetup, "module">
    ): Promise<WorkspacePath> {
      const projectPath = projPath("/projects/my-app");
      const ws = makeWorkspace("feature-1", projPath(projectPath));
      preflightSetup.provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(preflightSetup.dispatcher, projPath(projectPath));
      return wsPath(ws.path.toString());
    }

    it("blocks with a reason when the workspace is dirty", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.isDirty.mockResolvedValue(true);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      expect(result).toEqual({ blocked: true, reason: "Workspace has uncommitted changes" });
    });

    it("blocks with a reason when the branch has unmerged commits", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.countUnmergedCommits.mockResolvedValue(3);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      expect(result).toEqual({ blocked: true, reason: "Workspace has 3 unmerged commits" });
    });

    it("joins both reasons when the workspace is dirty and unmerged", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.isDirty.mockResolvedValue(true);
      preflightSetup.provider.countUnmergedCommits.mockResolvedValue(1);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      expect(result.reason).toBe(
        "Workspace has uncommitted changes; Workspace has 1 unmerged commit"
      );
    });

    it("ignores unmerged commits when the branch is kept", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.countUnmergedCommits.mockResolvedValue(3);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath, {
        keepBranch: true,
      });

      // The branch ref survives the worktree removal, so the commits stay
      // reachable — nothing is lost, and no fetch is needed to know that.
      expect(result).toEqual({});
      expect(preflightSetup.provider.updateBases).not.toHaveBeenCalled();
    });

    it("still blocks a dirty workspace when the branch is kept", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.isDirty.mockResolvedValue(true);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath, {
        keepBranch: true,
      });

      // Uncommitted changes live in the worktree, which goes either way.
      expect(result).toEqual({ blocked: true, reason: "Workspace has uncommitted changes" });
    });

    it("does not block a clean workspace", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      expect(result).toEqual({});
    });

    it("fails closed when the provider throws", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.isDirty.mockRejectedValue(new Error("git failed"));

      // A state it could not read must not report as "nothing to object to".
      await expect(dispatchPreflight(preflightSetup.dispatcher, workspacePath)).rejects.toThrow(
        "git failed"
      );
    });

    it("refreshes remotes before counting unmerged commits", async () => {
      // Without this, a delete right after a server-side merge (/ship) measures
      // against a stale origin/main and rejects the just-merged commits.
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      expect(preflightSetup.provider.updateBases).toHaveBeenCalledWith(
        new Path("/projects/my-app")
      );
    });

    it("checks against stale refs when the refresh fails", async () => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.updateBases.mockRejectedValue(new Error("network down"));
      preflightSetup.provider.countUnmergedCommits.mockResolvedValue(2);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath);

      // A fetch failure must not block the delete on its own, nor hide the count.
      expect(result).toEqual({ blocked: true, reason: "Workspace has 2 unmerged commits" });
    });

    it.each([
      ["force", { force: true }],
      ["ignoreWarnings", { ignoreWarnings: true }],
      ["a runtime-only teardown", { removeWorktree: false }],
    ])("checks nothing for %s", async (_label, overrides) => {
      const preflightSetup = createPreflightTestSetup();
      const workspacePath = await setupWorkspace(preflightSetup);

      preflightSetup.provider.isDirty.mockResolvedValue(true);
      preflightSetup.provider.countUnmergedCommits.mockResolvedValue(5);

      const result = await dispatchPreflight(preflightSetup.dispatcher, workspacePath, overrides);

      expect(result).toEqual({});
      // Not applicable means no work at all — notably no fetch.
      expect(preflightSetup.provider.updateBases).not.toHaveBeenCalled();
      expect(preflightSetup.provider.isDirty).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deletionPending preservation
  // ---------------------------------------------------------------------------

  describe("deletionPending preservation", () => {
    async function setupWithWorkspace(
      d: Dispatcher,
      p: ReturnType<typeof createMockGitWorktreeProvider>
    ) {
      const projectPath = projPath("/projects/my-app");
      const ws = makeWorkspace("feature-1", projPath(projectPath));
      p.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(d, projPath(projectPath));
      return { projectPath, ws };
    }

    it("re-discovery preserves deletion-pending workspace", async () => {
      const { dispatcher, provider } = setup;
      const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete fails (non-force) — workspace enters deletionPending
      provider.removeWorkspace.mockRejectedValue(new Error("EBUSY"));
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      const deleteResult = await dispatchDeleteWorkspace(dispatcher, deleteIntent);
      expect(deleteResult.error).toBe("EBUSY");

      // Re-discover project — git no longer lists the workspace
      provider.discover.mockResolvedValue([]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // Workspace should still be resolvable via deletionPending
      const resolveResult = await dispatchResolveWorkspace(dispatcher, wsPath(ws.path.toString()));
      expect(resolveResult.projectPath).toBe(projectPath);
    });

    it("successful delete clears deletionPending", async () => {
      const { dispatcher, provider } = setup;
      const { ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete succeeds
      provider.removeWorkspace.mockResolvedValue(undefined);
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatchDeleteWorkspace(dispatcher, deleteIntent);

      // Workspace should not be resolvable
      const resolveResult = await dispatchResolveWorkspace(dispatcher, wsPath(ws.path.toString()));
      expect(resolveResult.projectPath).toBeUndefined();
    });

    it("force delete clears deletionPending", async () => {
      const { dispatcher, provider } = setup;
      const { ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete fails but force=true — dismissed from both maps
      provider.removeWorkspace.mockRejectedValue(new Error("EBUSY"));
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      };
      await dispatchDeleteWorkspace(dispatcher, deleteIntent);

      // Re-discover with empty list
      provider.discover.mockResolvedValue([]);
      await dispatchOpenProject(dispatcher, projPath("/projects/my-app"));

      // Workspace should not be resolvable (force cleared deletionPending)
      const resolveResult = await dispatchResolveWorkspace(dispatcher, wsPath(ws.path.toString()));
      expect(resolveResult.projectPath).toBeUndefined();
    });

    it("list-workspaces merges deletion-pending entries", async () => {
      const { dispatcher, provider } = setup;
      const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete fails (non-force) — workspace enters deletionPending
      provider.removeWorkspace.mockRejectedValue(new Error("EBUSY"));
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatchDeleteWorkspace(dispatcher, deleteIntent);

      // Re-discover — git no longer lists the workspace, but a new one exists
      const ws2 = makeWorkspace("feature-2", projPath(projectPath));
      provider.discover.mockResolvedValue([ws2]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // list-workspaces should include both: feature-2 from git + feature-1 from deletionPending
      const listResult = await dispatchListWorkspaces(dispatcher);
      const entry = listResult.entries!.find((e) => e.projectPath === projectPath);
      const names = entry!.workspaces.map((w) => w.name);
      expect(names).toContain("feature-1");
      expect(names).toContain("feature-2");
    });

    it("find-candidates merges deletion-pending entries", async () => {
      const { dispatcher, provider } = setup;
      const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete fails (non-force)
      provider.removeWorkspace.mockRejectedValue(new Error("EBUSY"));
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatchDeleteWorkspace(dispatcher, deleteIntent);

      // Re-discover without the deleted workspace
      provider.discover.mockResolvedValue([]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // find-candidates should still include the deletion-pending workspace
      const result = await dispatchFindCandidates(dispatcher);
      const paths = result.candidates!.map((c) => c.workspacePath);
      expect(paths).toContain(ws.path.toString());
    });

    it("close-project clears deletionPending entries for that project", async () => {
      const { dispatcher, provider } = setup;
      const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

      // Delete fails (non-force) — workspace enters deletionPending
      provider.removeWorkspace.mockRejectedValue(new Error("EBUSY"));
      const deleteIntent: DeleteWorkspaceIntent = {
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath(ws.path.toString()),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatchDeleteWorkspace(dispatcher, deleteIntent);

      // Close project — should clear deletionPending too
      await dispatchCloseProject(dispatcher, projPath(projectPath));

      // Re-open with empty list
      provider.discover.mockResolvedValue([]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      // Workspace should not be resolvable (close cleared deletionPending)
      const resolveResult = await dispatchResolveWorkspace(dispatcher, wsPath(ws.path.toString()));
      expect(resolveResult.projectPath).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // metadata-changed event
  // ---------------------------------------------------------------------------

  describe("metadata-changed event", () => {
    async function emitMetadataChanged(
      dispatcher: Dispatcher,
      event: MetadataChangedEvent
    ): Promise<void> {
      await dispatcher.dispatch({
        type: "emit-event",
        payload: event,
      } as Intent);
    }

    async function dispatchListWorkspaces(
      dispatcher: Dispatcher
    ): Promise<ListWorkspacesHookResult> {
      return (await dispatcher.dispatch({
        type: "project:list",
        payload: {},
      } as Intent)) as ListWorkspacesHookResult;
    }

    it("updates metadata when a key is set", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      const event: MetadataChangedEvent = {
        type: EVENT_METADATA_CHANGED,
        payload: {
          projectId: "test-project" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: wsPath(ws.path.toString()),
          key: "auto-workspace.tracked",
          value: "true",
        },
      };
      await emitMetadataChanged(dispatcher, event);

      const result = await dispatchListWorkspaces(dispatcher);
      const entry = result.entries!.find((e) => e.projectPath === projectPath);
      const updatedWs = entry!.workspaces.find((w) => w.name === "feature-1");
      expect(updatedWs!.metadata).toEqual({
        base: "origin/main",
        "auto-workspace.tracked": "true",
      });
    });

    it("removes metadata key when value is null", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws: Workspace = {
        name: "feature-1",
        path: new Path(`${projectPath}/.worktrees/feature-1`),
        branch: "feature-1",
        metadata: { base: "origin/main", "auto-workspace.tracked": "true" },
      };
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      const event: MetadataChangedEvent = {
        type: EVENT_METADATA_CHANGED,
        payload: {
          projectId: "test-project" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: wsPath(ws.path.toString()),
          key: "auto-workspace.tracked",
          value: null,
        },
      };
      await emitMetadataChanged(dispatcher, event);

      const result = await dispatchListWorkspaces(dispatcher);
      const entry = result.entries!.find((e) => e.projectPath === projectPath);
      const updatedWs = entry!.workspaces.find((w) => w.name === "feature-1");
      expect(updatedWs!.metadata).toEqual({ base: "origin/main" });
    });

    it("ignores event for unknown workspace path", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      const event: MetadataChangedEvent = {
        type: EVENT_METADATA_CHANGED,
        payload: {
          projectId: "test-project" as ProjectId,
          workspaceName: "unknown" as WorkspaceName,
          workspacePath: wsPath("/nonexistent/workspace"),
          key: "auto-workspace.tracked",
          value: "true",
        },
      };
      await emitMetadataChanged(dispatcher, event);

      // Original workspace should be unchanged
      const result = await dispatchListWorkspaces(dispatcher);
      const entry = result.entries!.find((e) => e.projectPath === projectPath);
      const originalWs = entry!.workspaces.find((w) => w.name === "feature-1");
      expect(originalWs!.metadata).toEqual({ base: "origin/main" });
    });
  });
});

// =============================================================================
// Add-project worktree picker (project:open "prepare")
// =============================================================================

describe("Add-project worktree picker", () => {
  const PROJECT = projPath("/test/project");

  /** The prepare hook point, isolated from the discover-collecting operation above. */
  const prepareOperation = createMinimalOperation<{ canceled?: boolean } | undefined>(
    OPEN_PROJECT_OPERATION_ID,
    INTENT_OPEN_PROJECT,
    "prepare"
  );

  function makeUnmanaged(name: string, branch: string | null) {
    return {
      name,
      path: new Path(`/code/${name}`),
      branch,
      adoptable: branch !== null,
    };
  }

  function createPickerSetup(unmanaged: ReturnType<typeof makeUnmanaged>[]) {
    const provider = createMockGitWorktreeProvider();
    provider.listUnmanagedWorktrees.mockResolvedValue(unmanaged);
    const pathProvider = createMockPathProvider({
      getProjectWorkspacesDir: () => new Path("/workspaces"),
    });
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(prepareOperation);

    const { dialogs, notifications, ui } = createMockUi();
    dispatcher.registerModule(
      createGitWorktreeWorkspaceModule(
        provider as unknown as GitWorktreeProvider,
        pathProvider,
        SILENT_LOGGER,
        ui
      )
    );

    return { dispatcher, provider, dialogs, notifications };
  }

  async function prepare(
    dispatcher: Dispatcher,
    payload: Record<string, unknown>
  ): Promise<{ canceled?: boolean } | undefined> {
    return (await dispatcher.dispatch({ type: INTENT_OPEN_PROJECT, payload } as Intent)) as
      | { canceled?: boolean }
      | undefined;
  }

  /**
   * Settle microtasks until the picker opens. The handler awaits the worktree
   * listing first, so the dialog is not there on the dispatch's own turn.
   */
  async function openedDialog(dialogs: MockDialogManager) {
    for (let i = 0; i < 20 && !dialogs.lastHandle; i++) await Promise.resolve();
    const handle = dialogs.lastHandle;
    if (!handle) throw new Error("picker dialog was never opened");
    return handle;
  }

  /** Ids of the checkboxes in a picker config, in render order. */
  function checkboxIds(config: { sections: readonly { type: string }[] }): string[] {
    return config.sections
      .filter((s): s is { type: "checkbox"; id: string } => s.type === "checkbox")
      .map((s) => s.id);
  }

  /** Every checkbox in a picker config, id → checked. */
  function rowValues(config: { sections: readonly { type: string }[] }): Record<string, boolean> {
    const boxes = config.sections.filter(
      (s): s is { type: "checkbox"; id: string; value: boolean } => s.type === "checkbox"
    );
    return Object.fromEntries(boxes.map((box) => [box.id, box.value]));
  }

  it("does not show the picker for a restart re-open (no `initial`)", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
    ]);

    await prepare(dispatcher, { path: PROJECT });

    expect(dialogs.handles).toHaveLength(0);
    expect(provider.adoptWorktree).not.toHaveBeenCalled();
  });

  it("does not show the picker when cloning from a URL", async () => {
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
    ]);

    await prepare(dispatcher, { git: "org/repo", initial: true });

    expect(dialogs.handles).toHaveLength(0);
  });

  it("stays silent when nothing is adoptable", async () => {
    // An agent's scratch worktree is detached, so adding a project alongside one
    // must not put a dialog in the way.
    const { dispatcher, dialogs } = createPickerSetup([makeUnmanaged("wt-8fa2", null)]);

    await prepare(dispatcher, { path: PROJECT, initial: true });

    expect(dialogs.handles).toHaveLength(0);
  });

  it("lists unmanaged worktrees with nothing pre-ticked, detached ones disabled", async () => {
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("wt-8fa2", null),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);

    // One checkbox per worktree, name first (that is what the workspace gets
    // called), then where it lives. The branch is shown only where it differs.
    expect(handle.config.sections).toContainEqual({
      type: "checkbox",
      id: "wt-0",
      label: "repo-login (feature/login) — /code/repo-login",
      value: false,
      changeEvent: true,
      disabled: false,
    });
    expect(handle.config.sections).toContainEqual({
      type: "checkbox",
      id: "wt-1",
      label: "wt-8fa2 — /code/wt-8fa2 — detached HEAD, cannot be adopted",
      value: false,
      changeEvent: true,
      disabled: true,
    });
    // No orphaned detail lines: a second section per row is centered by the
    // default layout and a full gap away from its own checkbox.
    expect(handle.config.sections.filter((s) => s.type === "text")).toHaveLength(2);

    handle.emitAction("cancel");
    await pending;
  });

  it("omits the branch when it matches the directory name", async () => {
    const { dispatcher, dialogs } = createPickerSetup([makeUnmanaged("wt", "wt")]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);

    expect(handle.config.sections).toContainEqual(
      expect.objectContaining({ id: "wt-0", label: "wt — /code/wt" })
    );

    handle.emitAction("cancel");
    await pending;
  });

  it("adopts the ticked worktrees on Continue", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("repo-hotfix", "hotfix-2"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitAction("continue", { "wt-0": "true", "wt-1": "false" });

    const result = await pending;
    expect(result?.canceled).toBeUndefined();
    expect(provider.adoptWorktree).toHaveBeenCalledTimes(1);
    expect(provider.adoptWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      "feature/login"
    );
    expect(handle.closed).toBe(true);
  });

  it("Select all ticks every adoptable worktree, never the detached one", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("wt-8fa2", null),
      makeUnmanaged("repo-hotfix", "hotfix-2"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitChange("select-all", { "select-all": "true" });

    // [select-all, wt-0, wt-1 (detached), wt-2]
    expect(rowValues(handle.config)).toEqual({
      "select-all": true,
      "wt-0": true,
      "wt-1": false,
      "wt-2": true,
    });

    handle.emitAction("continue", { "wt-0": "true", "wt-1": "false", "wt-2": "true" });
    await pending;

    expect(provider.adoptWorktree.mock.calls.map((call) => call[2])).toEqual([
      "feature/login",
      "hotfix-2",
    ]);
  });

  it("unticking Select all clears every row", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("repo-hotfix", "hotfix-2"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitChange("select-all", { "select-all": "true" });
    handle.emitChange("select-all", { "select-all": "false" });

    expect(rowValues(handle.config)).toEqual({
      "select-all": false,
      "wt-0": false,
      "wt-1": false,
    });

    handle.emitAction("continue", { "wt-0": "false", "wt-1": "false" });
    await pending;
    expect(provider.adoptWorktree).not.toHaveBeenCalled();
  });

  it("Select all reflects the rows: unticking one clears it", async () => {
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("repo-hotfix", "hotfix-2"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitChange("select-all", { "select-all": "true" });
    handle.emitChange("wt-1", { "wt-1": "false" });

    expect(rowValues(handle.config)).toEqual({
      "select-all": false,
      "wt-0": true,
      "wt-1": false,
    });

    handle.emitAction("cancel");
    await pending;
  });

  it("re-ticks a box the user unticked after a first Select all", async () => {
    // The renderer adopts a pushed value it has not seen yet, so the module has to
    // echo its own model on every update — otherwise the second Select all is a
    // no-op for that box.
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("repo-hotfix", "hotfix-2"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);

    handle.emitChange("select-all", { "select-all": "true" });
    handle.emitChange("wt-0", { "wt-0": "false" });
    expect(rowValues(handle.config)["wt-0"]).toBe(false);

    handle.emitChange("select-all", { "select-all": "true" });
    expect(rowValues(handle.config)["wt-0"]).toBe(true);

    handle.emitAction("cancel");
    await pending;
  });

  it("Cancel aborts the whole project add", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitAction("cancel", { "wt-0": "true" });

    expect(await pending).toEqual({ canceled: true });
    expect(provider.adoptWorktree).not.toHaveBeenCalled();
  });

  it("Escape aborts the add, same as Cancel", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitDismiss();

    expect(await pending).toEqual({ canceled: true });
    expect(provider.adoptWorktree).not.toHaveBeenCalled();
  });

  it("reports a failed adoption instead of letting the workspace vanish later", async () => {
    const { dispatcher, provider, dialogs, notifications } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
    ]);
    provider.adoptWorktree.mockRejectedValue(new Error("config is read-only"));

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    handle.emitAction("continue", { "wt-0": "true" });

    // The add still goes through — only the adoption failed.
    expect(await pending).toEqual({});
    expect(notifications.lastNotification?.latestConfig).toMatchObject({
      type: "error",
      message: expect.stringContaining("repo-login") as unknown as string,
    });
  });

  it("proceeds without a picker when the worktree listing fails", async () => {
    const { dispatcher, provider, dialogs } = createPickerSetup([]);
    provider.listUnmanagedWorktrees.mockRejectedValue(new Error("not a git repository"));

    expect(await prepare(dispatcher, { path: PROJECT, initial: true })).toEqual({});
    expect(dialogs.handles).toHaveLength(0);
  });

  it("keeps checkbox ids aligned with the listed worktrees", async () => {
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("a", "branch-a"),
      makeUnmanaged("b", "branch-b"),
      makeUnmanaged("c", "branch-c"),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);
    expect(checkboxIds(handle.config)).toEqual(["select-all", "wt-0", "wt-1", "wt-2"]);

    handle.emitAction("cancel");
    await pending;
  });
});
