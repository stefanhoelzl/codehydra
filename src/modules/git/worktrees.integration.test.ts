// @vitest-environment node
/**
 * Integration tests for the git module's workspace side (worktrees) through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers ->
 * GitWorktreeProvider calls + internal state management.
 *
 * Uses minimal test operations that exercise specific hook points, with
 * mock GitWorktreeProvider and PathProvider dependencies.
 */

import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../../intents/lib/dispatcher";
import { createMinimalOperation } from "../../intents/lib/operation.test-utils";

import { z } from "zod/v4";
import type {
  Operation,
  OperationSchemas,
  HookContext,
  DispatchFn,
} from "../../intents/lib/operation";
import type { Intent, DomainEvent } from "../../intents/lib/types";
import type { IntentModule } from "../../intents/lib/module";
import type { Workspace } from "../../boundaries/platform/git-types";
import { OPEN_PROJECT_OPERATION_ID, INTENT_OPEN_PROJECT } from "../../intents/open-project";
import type { DiscoverHookResult } from "../../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID, INTENT_CLOSE_PROJECT } from "../../intents/close-project";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../../intents/open-workspace";
import type { OpenWorkspaceIntent } from "../../intents/open-workspace";
import type { CreateHookResult } from "../../intents/open-workspace";
import {
  GET_OPTION_CHOICES_OPERATION_ID,
  INTENT_GET_OPTION_CHOICES,
  type ListChoicesHookResult,
} from "../../intents/get-option-choices";
import {
  INTENT_REFRESH_PROJECT,
  REFRESH_PROJECT_OPERATION_ID,
} from "../../intents/refresh-project";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  preflightResultSchema,
  deleteResultSchema,
} from "../../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
} from "../../intents/delete-workspace";
import type { DeleteHookResult } from "../../intents/delete-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
  getStatusHookResultSchema,
} from "../../intents/get-workspace-status";
import type { GetStatusHookInput, GetStatusHookResult } from "../../intents/get-workspace-status";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  ResolveWorkspaceOperation,
  type StateHookInput,
} from "../../intents/resolve-workspace";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  type FindCandidatesHookResult,
} from "../../intents/switch-workspace";
import {
  LIST_PROJECTS_OPERATION_ID,
  INTENT_LIST_PROJECTS,
  type ListWorkspacesHookResult,
} from "../../intents/list-projects";
import type { WorkspaceName } from "../../shared/api/types";
import type { GitProjectModuleDeps } from "./module";
import { createMockGitWorktreeProvider, createTestGitModule } from "./git.test-utils";
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import type { WorkspaceRegistryModule } from "../workspace-registry-module";
import { createTestWorkspaceRegistry } from "../workspace-registry.test-utils";
import { createMockDialogManager } from "../presentation/dialog-manager.state-mock";
import type { MockDialogManager } from "../presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import type { MockNotificationManager } from "../presentation/notification-manager.state-mock";
import { Path } from "../../utils/path/path";
import { parseProjectRef, projectRefOf } from "../../utils/ref";
import { gitProjectRef } from "./ref";
import { wsPath, projPath, testPath, workspaceRefIn } from "../../shared/test-fixtures";
import type {
  WorkspacePath,
  ProjectPath,
  WorkspaceRef,
  WorkspaceClosing,
} from "../../intents/contract";
import { WorkspaceError } from "../../shared/errors/service-errors";

// =============================================================================
// Minimal Test Operations
// =============================================================================

const openProjectOperation = createMinimalOperation<DiscoverHookResult>(
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  "discover",
  {
    hookContext: (ctx) => {
      const { projectPath } = ctx.intent.payload as { projectPath: ProjectPath };
      return { intent: ctx.intent, projectPath, projectRef: gitProjectRef(projectPath) };
    },
  }
);

const closeProjectOperation = createMinimalOperation<Record<string, never>>(
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  "close",
  {
    hookContext: (ctx) => {
      const { projectPath } = ctx.intent.payload as { projectPath: ProjectPath };
      return {
        intent: ctx.intent,
        projectPath,
        projectRef: gitProjectRef(projectPath),
        removeLocalRepo: false,
      };
    },
  }
);

const openWorkspaceOperation = createMinimalOperation<CreateHookResult>(
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  "create",
  {
    hookContext: (ctx) => {
      // The real operation resolves the project; a checkout's ref carries its path.
      const { projectRef, workspaceName, existingWorkspace } = ctx.intent
        .payload as OpenWorkspaceIntent["payload"];
      const projectPath =
        projectRef !== undefined ? (parseProjectRef(projectRef)?.identifier ?? "") : "";
      // Decided by the real operation and handed to every hook point.
      return {
        intent: ctx.intent,
        projectPath,
        fresh: existingWorkspace === undefined,
        workspaceName: existingWorkspace?.name ?? workspaceName,
        ...(projectRef !== undefined && { projectRef }),
      };
    },
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

/**
 * Dispatch workspace:resolve for the intent's workspace (matching the real operation)
 * and build the delete-pipeline hook input from it. `resolved` is false when the
 * workspace is not found; the input then carries an empty project path.
 */
async function resolveDeletePipelineInput(
  dispatch: DispatchFn,
  intent: Intent & { readonly payload: DeleteWorkspaceIntent["payload"] }
): Promise<{ input: DeletePipelineHookInput; resolved: boolean }> {
  const { workspaceRef } = intent.payload;
  let resolvedProjectPath = "";
  let resolvedWorkspacePath = wsPath("/unresolved");
  try {
    const resolved = (await dispatch({
      type: "workspace:resolve",
      payload: { workspaceRef },
    } as Intent)) as ResolveResult;
    resolvedProjectPath = resolved.projectPath ?? "";
    resolvedWorkspacePath = resolved.workspacePath ?? resolvedWorkspacePath;
  } catch {
    // Workspace not found — continue with empty projectPath
  }
  return {
    input: {
      intent,
      projectRef: projectRefOf(workspaceRef),
      projectPath: projPath(resolvedProjectPath),
      workspaceRef,
      workspacePath: resolvedWorkspacePath,
      workspaceName: "test-workspace" as WorkspaceName,
      active: false,
    },
    resolved: resolvedProjectPath !== "",
  };
}

const minimalPreflightOperation: Operation<typeof preflightSchemas> = {
  id: DELETE_WORKSPACE_OPERATION_ID,
  schemas: preflightSchemas,
  async execute(ctx): Promise<PreflightResult> {
    const { input } = await resolveDeletePipelineInput(ctx.dispatch, ctx.intent);
    const { results, errors } = await ctx.hooks.collect("preflight", input);
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
    // delete (enriched with both paths, matching real operation's DeletePipelineHookInput)
    const { input, resolved } = await resolveDeletePipelineInput(ctx.dispatch, ctx.intent);
    const { results: deleteResults, errors: deleteErrors } = await ctx.hooks.collect(
      "delete",
      input
    );
    if (deleteErrors.length > 0 && !ctx.intent.payload.force) throw deleteErrors[0]!;

    return {
      ...deleteResults[0],
      ...(resolved && { resolvedPath: input.workspacePath }),
    };
  },
};

/** Result from workspace path resolution (reverse lookup: workspacePath → projectPath + workspaceName). */
interface ResolveResult {
  readonly workspaceRef?: WorkspaceRef | undefined;
  readonly workspacePath?: WorkspacePath | undefined;
  readonly projectPath?: ProjectPath | undefined;
  readonly workspaceName?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly closing?: WorkspaceClosing | null | undefined;
}

/** The real resolve-workspace operation: the module under test is its "resolve" handler. */
const minimalResolveWorkspaceOperation = new ResolveWorkspaceOperation();

/**
 * Minimal project:get-option-choices: the "list" hook point alone, the
 * project's path in the payload. `fresh` passes through.
 */
const getOptionChoicesSchemas = {
  type: INTENT_GET_OPTION_CHOICES,
  payload: z.unknown(),
  result: z.custom<ListChoicesHookResult>(),
} satisfies OperationSchemas;

const minimalGetOptionChoicesOperation: Operation<typeof getOptionChoicesSchemas> = {
  id: GET_OPTION_CHOICES_OPERATION_ID,
  schemas: getOptionChoicesSchemas,
  async execute(ctx): Promise<ListChoicesHookResult> {
    const payload = ctx.intent.payload as { projectPath: ProjectPath; fresh?: boolean };
    const { results, errors } = await ctx.hooks.collect("list", {
      intent: ctx.intent,
      projectPath: payload.projectPath,
      projectRef: gitProjectRef(payload.projectPath),
      fresh: payload.fresh === true,
    } as HookContext);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  },
};

/** Minimal project:refresh: the "refresh" hook point, the project's path in the payload. */
const refreshProjectSchemas = {
  type: INTENT_REFRESH_PROJECT,
  payload: z.unknown(),
} satisfies OperationSchemas;

const minimalRefreshProjectOperation: Operation<typeof refreshProjectSchemas> = {
  id: REFRESH_PROJECT_OPERATION_ID,
  schemas: refreshProjectSchemas,
  async execute(ctx): Promise<void> {
    const payload = ctx.intent.payload as { projectPath: ProjectPath };
    const { errors } = await ctx.hooks.collect("refresh", {
      intent: ctx.intent,
      projectPath: payload.projectPath,
      projectRef: gitProjectRef(payload.projectPath),
    } as HookContext);
    if (errors.length > 0) throw errors[0]!;
  },
};

/** Result from get-workspace-status: resolve-workspace + get. */
type GetStatusResult = GetStatusHookResult;

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
      workspaceRef: resolved.workspaceRef!,
      workspacePath: wsPath(payload.workspacePath),
      closing: resolved.closing ?? null,
    };
    const { results, errors } = await ctx.hooks.collect("get", getInput);
    if (errors.length > 0) throw errors[0]!;
    // The type answers its work status whole.
    return results.find((result) => result.status !== undefined) ?? {};
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

/** Both the registry (workspaces) and git (default bases) contribute; merged like the real operation. */
const listProjectsOperation = createMinimalOperation<
  ListWorkspacesHookResult,
  ListWorkspacesHookResult
>(LIST_PROJECTS_OPERATION_ID, INTENT_LIST_PROJECTS, "list-workspaces", {
  select: ({ results }) => ({ entries: results.flatMap((r) => r.entries ?? []) }),
});

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  provider: ReturnType<typeof createMockGitWorktreeProvider>;
  workspacesRoot: { workspacesDir: () => Path; previousWorkspacesDirs: () => readonly Path[] };
  module: IntentModule;
  /** The core registry the module feeds. */
  registry: WorkspaceRegistryModule;
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
  ui: GitProjectModuleDeps["ui"];
  notify: GitProjectModuleDeps["dispatcher"];
} {
  const dialogs = createMockDialogManager();
  const notifications = createMockNotificationManager();
  return {
    dialogs,
    notifications,
    ui: { dialog: dialogs.ui.dialog },
    notify: notifications.dispatcher,
  };
}

function createTestSetup(): TestSetup {
  const provider = createMockGitWorktreeProvider();
  const workspacesRoot = {
    workspacesDir: () => testPath("/workspaces"),
    previousWorkspacesDirs: () => [testPath("/old-root/workspaces")],
  };

  const dispatcher = createMockDispatcher();

  // Register operations
  dispatcher.registerOperation(openProjectOperation);
  dispatcher.registerOperation(closeProjectOperation);
  dispatcher.registerOperation(openWorkspaceOperation);
  dispatcher.registerOperation(minimalDeleteWorkspaceOperation);
  dispatcher.registerOperation(minimalResolveWorkspaceOperation);
  dispatcher.registerOperation(minimalGetOptionChoicesOperation);
  dispatcher.registerOperation(minimalRefreshProjectOperation);
  dispatcher.registerOperation(minimalGetStatusOperation);
  dispatcher.registerOperation(minimalEmitEventOperation);
  dispatcher.registerOperation(switchWorkspaceOperation);
  dispatcher.registerOperation(listProjectsOperation);

  // Wire the module under test, with the core registry it feeds
  const { registry } = createTestWorkspaceRegistry();
  const { dialogs, notifications, ui, notify } = createMockUi();
  const module = createTestGitModule({
    gitWorktreeProvider: provider,
    workspacesRoot: { ...workspacesRoot, remotesDir: () => testPath("/remotes") },
    ui,
    dispatcher: notify,
    registry,
  });
  dispatcher.registerModule(registry);
  dispatcher.registerModule(module);

  // Stands in for workspace-lifecycle-module's state contribution: the module
  // under test only ever sees `closing` as hook-context enrichment, so the test
  // supplies it the same way production does — through a resolve handler.
  const closing = new Map<string, WorkspaceClosing>();
  dispatcher.registerModule({
    name: "closing-stub",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        state: {
          handler: async (ctx: HookContext) => {
            const { workspacePath } = ctx as StateHookInput;
            const reason = closing.get(new Path(workspacePath).toString());
            return { result: reason === undefined ? {} : { closing: reason } };
          },
        },
      },
    },
  });

  return {
    dispatcher,
    provider,
    workspacesRoot,
    module,
    registry,
    closing,
    dialogs,
    notifications,
  };
}

function createPreflightTestSetup(): Omit<TestSetup, "module" | "registry"> {
  const provider = createMockGitWorktreeProvider();
  const workspacesRoot = {
    workspacesDir: () => testPath("/workspaces"),
    previousWorkspacesDirs: () => [],
  };

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(openProjectOperation);
  dispatcher.registerOperation(minimalPreflightOperation);
  dispatcher.registerOperation(minimalResolveWorkspaceOperation);

  const { registry } = createTestWorkspaceRegistry();
  const { dialogs, notifications, ui, notify } = createMockUi();
  const module = createTestGitModule({
    gitWorktreeProvider: provider,
    workspacesRoot: { ...workspacesRoot, remotesDir: () => testPath("/remotes") },
    ui,
    dispatcher: notify,
    registry,
  });
  dispatcher.registerModule(registry);
  dispatcher.registerModule(module);

  return {
    dispatcher,
    provider,
    workspacesRoot,
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

/** The ref of a workspace made by {@link makeWorkspace}, from its path (`<project>/.worktrees/<name>`). */
function wsRefAt(workspacePath: string): WorkspaceRef {
  const path = new Path(workspacePath);
  return workspaceRefIn(path.dirname.dirname.toString(), path.basename);
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

/** Resolve a workspace; one no module knows reads as empty. */
async function dispatchResolveWorkspace(
  dispatcher: Dispatcher,
  workspacePath: WorkspacePath
): Promise<ResolveResult> {
  try {
    return (await dispatcher.dispatch({
      type: "workspace:resolve",
      payload: { workspacePath },
    } as Intent)) as ResolveResult;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_FOUND") return {};
    throw error;
  }
}

async function dispatchListChoices(
  dispatcher: Dispatcher,
  projectPath: ProjectPath,
  fresh = false
): Promise<ListChoicesHookResult> {
  return (await dispatcher.dispatch({
    type: INTENT_GET_OPTION_CHOICES,
    payload: { projectPath, fresh },
  } as Intent)) as ListChoicesHookResult;
}

async function dispatchRefreshBases(
  dispatcher: Dispatcher,
  projectPath: ProjectPath
): Promise<void> {
  await dispatcher.dispatch({
    type: INTENT_REFRESH_PROJECT,
    payload: { projectPath },
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

/** Fully delete `ws` (keeping no branch); non-forced unless asked. */
function deleteIntentFor(ws: Workspace, options?: { force?: boolean }): DeleteWorkspaceIntent {
  return {
    type: "workspace:delete",
    payload: {
      workspaceRef: wsRefAt(ws.path.toString()),
      options: { keepBranch: false },
      force: options?.force ?? false,
      removeWorktree: true,
    },
  };
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
      workspaceRef: wsRefAt(workspacePath),
      options: { keepBranch: false },
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

describe("Git module: worktrees", () => {
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
        testPath("/workspaces"),
        [testPath("/old-root/workspaces")]
      );
      expect(provider.discover).toHaveBeenCalledWith(new Path(projectPath));
      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces[0]!.name).toBe("feature-1");
      expect(result.workspaces[1]!.name).toBe("feature-2");
    });

    it("describes each workspace by its branch and recorded base, and the registry resolves it so", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      const detached: Workspace = {
        ...makeWorkspace("detached", projectPath),
        branch: null,
        metadata: {},
      };
      provider.discover.mockResolvedValue([makeWorkspace("feature-1", projectPath), detached]);

      const result = await dispatchOpenProject(dispatcher, projPath(projectPath));

      expect(result.workspaces[0]).toMatchObject({
        subtitle: "feature-1",
        subtitleIcon: "branch",
        details: { branch: "feature-1", base: "origin/main" },
      });
      // A detached HEAD with no recorded base: no subtitle, nothing invented in details.
      expect(result.workspaces[1]).not.toHaveProperty("subtitle");
      expect(result.workspaces[1]!.details).toEqual({});

      const resolved = await dispatchResolveWorkspace(
        dispatcher,
        wsPath(`${projectPath}/.worktrees/feature-1`)
      );
      expect(resolved.subtitle).toBe("feature-1");
      expect(resolved.details).toEqual({ branch: "feature-1", base: "origin/main" });
    });

    it("calls fire-and-forget cleanupOrphanedWorkspaces", async () => {
      const { dispatcher, provider } = setup;

      await dispatchOpenProject(dispatcher, projPath("/projects/my-app"));

      expect(provider.cleanupOrphanedWorkspaces).toHaveBeenCalledWith(testPath("/projects/my-app"));
    });

    it("keeps a known workspace resolvable when re-opening the project no longer discovers it", async () => {
      // An automation naming a project by URL re-runs project:open on an open
      // project; discover ran again and skipped a worktree the app still holds.
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      const kept = makeWorkspace("feature-1", projectPath);
      const skipped = makeWorkspace("feature-2", projectPath);
      provider.discover.mockResolvedValue([kept, skipped]);
      await dispatchOpenProject(dispatcher, projectPath);

      provider.discover.mockResolvedValue([kept]);
      await dispatchOpenProject(dispatcher, projectPath);

      const result = await dispatchResolveWorkspace(dispatcher, wsPath(skipped.path.toString()));
      expect(result.projectPath).toBe(projectPath);
    });

    it("hands the registry each workspace's metadata, located in its worktree on first write", async () => {
      const { dispatcher, provider, registry } = setup;
      const projectPath = projPath("/projects/my-app");
      const ws = makeWorkspace("feature-1", projectPath);
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projectPath);

      // Read from memory: discovery read the file.
      expect(registry.metadata(ws.path)).toEqual({ base: "origin/main" });
      expect(provider.metadataFileOf).not.toHaveBeenCalled();

      await registry.setMetadata(ws.path, "title", "Login");

      expect(provider.metadataFileOf).toHaveBeenCalledWith(ws.path);
      expect(registry.metadata(ws.path)).toEqual({ base: "origin/main", title: "Login" });
    });

    it("caches the default base from discover and surfaces it via list-workspaces", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      provider.discover.mockResolvedValue([]);
      provider.defaultBase.mockResolvedValue("origin/main");

      await dispatchOpenProject(dispatcher, projPath(projectPath));
      const listed = await dispatchListWorkspaces(dispatcher);

      // list-projects takes the default from whichever entry for the path carries one.
      const defaults = listed
        .entries!.filter((e) => e.projectPath === new Path(projectPath).toString())
        .map((e) => e.defaultBaseBranch);
      expect(defaults).toContain("origin/main");
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
          path: testPath("/workspaces/new-feature"),
          branch: "new-feature",
          metadata: { base: "origin/main" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "new-feature",
            options: { base: "origin/main" },
            projectRef: gitProjectRef(projectPath),
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.createWorkspace).toHaveBeenCalledWith(
          new Path(projectPath),
          "new-feature",
          "origin/main",
          undefined
        );
        expect(result.workspacePath).toBe(testPath("/workspaces/new-feature").toString());
        expect(result.subtitle).toBe("new-feature");
        expect(result.subtitleIcon).toBe("branch");

        // The registry holds its metadata, the name recorded, and wrote its file
        // where the provider says the worktree's metadata lives.
        expect(setup.registry.metadata(testPath("/workspaces/new-feature"))).toEqual({
          base: "origin/main",
          name: "new-feature",
        });
        expect(provider.metadataFileOf).toHaveBeenCalledWith(testPath("/workspaces/new-feature"));

        // Verify state was updated (resolve should find it)
        const resolveResult = await dispatchResolveWorkspace(
          dispatcher,
          wsPath("/workspaces/new-feature")
        );
        expect(resolveResult.projectPath).toBe(projectPath);
      });

      it("refuses a name a workspace on another branch still has", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        // Created as `feat`, since switched to `main`: the name stays taken
        provider.discover.mockResolvedValue([
          { ...makeWorkspace("feat", projPath(projectPath)), branch: "main" },
        ]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "Feat",
            options: { base: "origin/main" },
            projectRef: gitProjectRef(projectPath),
          },
        };

        await expect(dispatchCreateWorkspace(dispatcher, createIntent)).rejects.toThrow(
          "Workspace 'Feat' already exists"
        );
        expect(provider.createWorkspace).not.toHaveBeenCalled();
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
            options: { base: "origin/main" },
            projectRef: gitProjectRef(projectPath),
            existingWorkspace: {
              path: wsPath("/workspaces/existing-ws"),
              name: "existing-ws",
              details: { branch: "existing-ws" },
              metadata: { base: "origin/main" },
            },
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);

        expect(provider.createWorkspace).not.toHaveBeenCalled();
        expect(result.workspacePath).toBe(testPath("/workspaces/existing-ws").toString());
        expect(result.subtitle).toBe("existing-ws");

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
          path: testPath("/workspaces/auto-base"),
          branch: "auto-base",
          metadata: { base: "origin/main" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "auto-base",
            projectRef: gitProjectRef(projectPath),
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
        expect(result.details).toEqual({ branch: "auto-base", base: "origin/main" });
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
            projectRef: gitProjectRef(projectPath),
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
            options: { base: "main" },
            projectRef: gitProjectRef(projectPath),
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
          path: testPath("/workspaces/explicit-base"),
          branch: "explicit-base",
          metadata: { base: "develop" },
        };
        provider.createWorkspace.mockResolvedValue(createdWs);

        const createIntent: OpenWorkspaceIntent = {
          type: "workspace:open",
          payload: {
            workspaceName: "explicit-base",
            options: { base: "develop" },
            projectRef: gitProjectRef(projectPath),
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
        expect(result.details?.["base"]).toBe("develop");
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
            options: { base: "origin/main" },
            projectRef: gitProjectRef(projectPath),
            existingWorkspace: {
              path: wsPath("/workspaces/existing-ws"),
              name: "existing-ws",
              details: { branch: "existing-ws" },
              metadata: { base: "origin/main" },
            },
          },
        };

        const result = await dispatchCreateWorkspace(dispatcher, createIntent);
        expect(result.details).toEqual({ branch: "existing-ws", base: "origin/main" });
      });

      // A reopen reports what the workspace records, whatever the caller put in
      // the payload — and nothing when nothing is recorded (an adopted worktree).
      it.each([
        ["reports the recorded base", { base: "develop" }, "develop"],
        ["omits a base that was never recorded", {}, undefined],
      ])("existing workspace %s", async (_label, metadata, expected) => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const result = await dispatchCreateWorkspace(dispatcher, {
          type: "workspace:open",
          payload: {
            workspaceName: "existing-ws",
            projectRef: gitProjectRef(projectPath),
            existingWorkspace: {
              path: wsPath("/workspaces/existing-ws"),
              name: "existing-ws",
              details: { branch: "existing-ws", base: "stale" },
              metadata,
            },
          },
        });
        expect(result.details?.["base"]).toBe(expected);
      });
    });

    describe("branch", () => {
      it("gives a detached HEAD no subtitle and no branch, not the workspace name", async () => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        provider.discover.mockResolvedValue([]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        const result = await dispatchCreateWorkspace(dispatcher, {
          type: "workspace:open",
          payload: {
            workspaceName: "detached-ws",
            projectRef: gitProjectRef(projectPath),
            existingWorkspace: {
              path: wsPath("/workspaces/detached-ws"),
              name: "detached-ws",
              metadata: {},
            },
          },
        });
        expect(result).not.toHaveProperty("subtitle");
        expect(result.details).toEqual({});
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

    describe("delete", () => {
      it("calls removeWorkspace when removeWorktree=true", async () => {
        const { dispatcher, provider } = setup;
        const { projectPath, ws } = await setupWithWorkspace(dispatcher, provider);

        await dispatchDeleteWorkspace(dispatcher, deleteIntentFor(ws));

        expect(provider.removeWorkspace).toHaveBeenCalledWith(new Path(projectPath), ws.path, true);
      });

      it("does not call removeWorkspace when removeWorktree=false", async () => {
        const { dispatcher, provider } = setup;
        const { ws } = await setupWithWorkspace(dispatcher, provider);

        const deleteIntent: DeleteWorkspaceIntent = {
          type: "workspace:delete",
          payload: {
            workspaceRef: wsRefAt(ws.path.toString()),
            options: { keepBranch: true },
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

        await dispatchDeleteWorkspace(dispatcher, deleteIntentFor(ws));

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

        const result = await dispatchDeleteWorkspace(
          dispatcher,
          deleteIntentFor(ws, { force: true })
        );

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
  // get-option-choices -> list
  // ---------------------------------------------------------------------------

  describe("get-option-choices -> list", () => {
    it("answers the branches as base choices, local first, the default preselected", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const bases = [
        { name: "origin/main", isRemote: true, base: "origin/main" },
        { name: "main", isRemote: false, base: "origin/main" },
      ];
      provider.listBases.mockResolvedValue(bases);
      provider.defaultBase.mockResolvedValue("origin/main");

      const result = await dispatchListChoices(dispatcher, projPath(projectPath));

      expect(provider.listBases).toHaveBeenCalledWith(new Path(projectPath), expect.any(Function));
      // defaultBase reuses the already-enumerated bases (no second listBases).
      expect(provider.defaultBase).toHaveBeenCalledWith(new Path(projectPath), bases);
      expect(result.fields).toEqual({
        base: {
          choices: [
            { value: "main", group: "Local Branches" },
            { value: "origin/main", group: "Remote Branches" },
          ],
          default: "origin/main",
        },
      });
    });

    it("suggests a derivable branch as a name that sets its base", async () => {
      const { dispatcher, provider } = setup;
      provider.listBases.mockResolvedValue([
        { name: "main", isRemote: false },
        { name: "origin/feature-x", isRemote: true, derives: "feature-x", base: "main" },
      ]);
      provider.defaultBase.mockResolvedValue("main");

      const result = await dispatchListChoices(dispatcher, projPath("/projects/my-app"));

      expect(result.nameSuggestions).toEqual([
        {
          value: "origin/feature-x",
          label: "feature-x",
          group: "Remote Branches",
          sets: { base: "main" },
        },
      ]);
    });

    it("says why there is nothing to choose for a repository without branches", async () => {
      const { dispatcher, provider } = setup;
      provider.listBases.mockResolvedValue([]);
      provider.defaultBase.mockResolvedValue(undefined);

      const result = await dispatchListChoices(dispatcher, projPath("/projects/my-app"));

      expect(result.fields?.["base"]).toEqual({
        choices: [],
        empty: "No base branches available",
      });
    });

    it("answers again from its last answer, and enumerates afresh when asked to", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      provider.listBases.mockResolvedValue([{ name: "main", isRemote: false }]);
      provider.defaultBase.mockResolvedValue("main");

      await dispatchListChoices(dispatcher, projectPath);
      await dispatchListChoices(dispatcher, projectPath);
      expect(provider.listBases).toHaveBeenCalledTimes(1);

      provider.listBases.mockResolvedValue([
        { name: "main", isRemote: false },
        { name: "develop", isRemote: false },
      ]);
      const fresh = await dispatchListChoices(dispatcher, projectPath, true);
      expect(provider.listBases).toHaveBeenCalledTimes(2);
      expect(fresh.fields?.["base"]?.choices).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // refresh-project -> refresh
  // ---------------------------------------------------------------------------

  describe("refresh-project -> refresh", () => {
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
    it("counts unmerged commits against the base the workspace recorded", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");
      const ws = { ...makeWorkspace("feature-1", projectPath), metadata: { base: "develop" } };
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projectPath);

      await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(provider.countUnmergedCommits).toHaveBeenCalledWith(ws.path, "develop");
    });

    it("reports uncommitted changes as dirty", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(true);

      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(provider.isDirty).toHaveBeenCalledWith(ws.path);
      expect(result.status).toBe("dirty");
    });

    it("reports a clean workspace as clean, with nothing to warn about", async () => {
      const { dispatcher, provider } = setup;
      const projectPath = projPath("/projects/my-app");

      const ws = makeWorkspace("feature-1", projPath(projectPath));
      provider.discover.mockResolvedValue([ws]);
      await dispatchOpenProject(dispatcher, projPath(projectPath));

      provider.isDirty.mockResolvedValue(false);

      const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

      expect(result.status).toBe("clean");
      expect(result).not.toHaveProperty("statusDescription");
      expect(result.details).toEqual({ isDirty: false, unmergedCommits: 0 });
    });

    it.each([
      [true, 0, "dirty", "Uncommitted changes"],
      [false, 1, "unmerged", "1 commit not merged into origin/main"],
      [true, 3, "dirty-unmerged", "Uncommitted changes · 3 commits not merged into origin/main"],
    ])(
      "reports dirty=%s with %i unmerged commits as %s",
      async (isDirty, unmergedCommits, status, statusDescription) => {
        const { dispatcher, provider } = setup;
        const projectPath = projPath("/projects/my-app");

        const ws = makeWorkspace("feature-1", projPath(projectPath));
        provider.discover.mockResolvedValue([ws]);
        await dispatchOpenProject(dispatcher, projPath(projectPath));

        provider.isDirty.mockResolvedValue(isDirty);
        provider.countUnmergedCommits.mockResolvedValue(unmergedCommits);

        const result = await dispatchGetStatus(dispatcher, wsPath(ws.path.toString()));

        expect(result).toEqual({
          status,
          statusDescription,
          details: { isDirty, unmergedCommits },
        });
      }
    );

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
      expect(result.status).toBe("clean");
      expect(result).not.toHaveProperty("statusDescription");
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
      expect(result.status).toBe("dirty");
    });
  });

  // ---------------------------------------------------------------------------
  // delete-workspace -> preflight
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> preflight", () => {
    /** Open a project with one workspace and return its path. */
    async function setupWorkspace(
      preflightSetup: Omit<TestSetup, "module" | "registry">
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
        options: { keepBranch: true },
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
        options: { keepBranch: true },
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
        testPath("/projects/my-app")
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

  /** As the provider lists it: named after its branch, else its directory. */
  function makeUnmanaged(dir: string, branch: string | null) {
    return {
      name: branch ?? dir,
      path: new Path(`/code/${dir}`),
      branch,
    };
  }

  function createPickerSetup(unmanaged: ReturnType<typeof makeUnmanaged>[]) {
    const provider = createMockGitWorktreeProvider();
    provider.listUnmanagedWorktrees.mockResolvedValue(unmanaged);
    const workspacesRoot = {
      workspacesDir: () => testPath("/workspaces"),
      previousWorkspacesDirs: () => [],
    };
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(prepareOperation);

    const { dialogs, notifications, ui, notify } = createMockUi();
    dispatcher.registerModule(
      createTestGitModule({
        gitWorktreeProvider: provider,
        workspacesRoot: { ...workspacesRoot, remotesDir: () => testPath("/remotes") },
        // Every picked path is a repository already, so no git-init offer comes first.
        gitClient: { ...createMockGitClient(), isRepositoryRoot: async () => true },
        ui,
        dispatcher: notify,
      })
    );

    return { dispatcher, provider, dialogs, notifications };
  }

  async function prepare(
    dispatcher: Dispatcher,
    payload: Record<string, unknown>
  ): Promise<{ canceled?: boolean } | undefined> {
    return (await dispatcher.dispatch({ type: INTENT_OPEN_PROJECT, payload } as Intent)) as
      { canceled?: boolean } | undefined;
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

  it("stays silent when there is nothing to adopt", async () => {
    const { dispatcher, dialogs } = createPickerSetup([]);

    await prepare(dispatcher, { path: PROJECT, initial: true });

    expect(dialogs.handles).toHaveLength(0);
  });

  it("lists unmanaged worktrees with nothing pre-ticked, detached ones included", async () => {
    const { dispatcher, dialogs } = createPickerSetup([
      makeUnmanaged("repo-login", "feature/login"),
      makeUnmanaged("wt-8fa2", null),
    ]);

    const pending = prepare(dispatcher, { path: PROJECT, initial: true });
    const handle = await openedDialog(dialogs);

    // One checkbox per worktree, name first (that is what the workspace gets
    // called: its branch), then where it lives.
    expect(handle.config.sections).toContainEqual({
      type: "checkbox",
      id: "wt-0",
      label: "feature/login — /code/repo-login",
      value: false,
      changeEvent: true,
    });
    expect(handle.config.sections).toContainEqual({
      type: "checkbox",
      id: "wt-1",
      label: "wt-8fa2 — /code/wt-8fa2",
      value: false,
      changeEvent: true,
    });
    // No orphaned detail lines: a second section per row is centered by the
    // default layout and a full gap away from its own checkbox.
    expect(handle.config.sections.filter((s) => s.type === "text")).toHaveLength(2);

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

  it("Select all ticks every worktree, the detached one included", async () => {
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
      "wt-1": true,
      "wt-2": true,
    });

    handle.emitAction("continue", { "wt-0": "true", "wt-1": "true", "wt-2": "true" });
    await pending;

    expect(provider.adoptWorktree.mock.calls.map((call) => call[2])).toEqual([
      "feature/login",
      null,
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
    await notifications.settle();
    expect(notifications.lastNotification?.latestConfig).toMatchObject({
      type: "error",
      message: expect.stringContaining("feature/login") as unknown as string,
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
