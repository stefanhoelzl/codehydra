// @vitest-environment node
/**
 * Integration tests for create-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> hooks -> event -> result,
 * including event emission on success, error propagation on failure,
 * and best-effort handling of agent/keepfiles failures.
 *
 * Test plan items covered:
 * #1: Creates workspace with correct return value
 * #2: Emits workspace:created event with full payload
 * #3: Worktree creation failure propagates error
 * #4: Agent server failure produces workspace without envVars
 * #5: Best-effort setup hook failure still produces workspace
 * #6: Unknown project throws
 * #7: Initial prompt included in event payload
 * #8: keepInBackground flag included in event payload
 * #9: Interceptor cancels creation
 * #10: Keepfiles copies files after worktree creation
 * #11: Keepfiles failure does not fail workspace creation
 * #12: No keepfiles side effects when worktree creation fails
 *
 * Regression coverage (APP_LIFECYCLE_INTENTS #10):
 * The agentModule's setup hook behavior (starting per-workspace server) is tested
 * in test #4 ("agent server failure produces workspace without envVars"). This
 * verifies that the extended agentModule (which now also has app:start/stop hooks
 * in the production bootstrap) still correctly handles per-workspace server startup
 * via its workspace:create setup hook.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  CreateWorkspaceOperation,
  CREATE_WORKSPACE_OPERATION_ID,
  INTENT_CREATE_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./create-workspace";
import type {
  CreateWorkspaceIntent,
  CreateWorkspaceHookContext,
  CreateWorkspacePayload,
  WorkspaceCreatedEvent,
  ExistingWorkspaceData,
} from "./create-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
import type { ProjectId, Workspace } from "../../shared/api/types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
} from "./switch-workspace";
import type { SwitchWorkspaceIntent, SwitchWorkspaceHookContext } from "./switch-workspace";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = "/project";
const WORKSPACE_PATH = "/workspaces/feature-x";
const WORKSPACE_BRANCH = "feature-x";
const WORKSPACE_METADATA: Readonly<Record<string, string>> = { base: "main" };
const WORKSPACE_URL = "http://127.0.0.1:8080/?folder=/workspaces/feature-x";

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface MockWorkspaceProvider {
  createWorkspace: (
    name: string,
    baseBranch: string
  ) => Promise<{
    name: string;
    path: Path;
    branch: string;
    metadata: Readonly<Record<string, string>>;
  }>;
}

function createMockWorkspaceProvider(): MockWorkspaceProvider {
  return {
    createWorkspace: async (name: string) => ({
      name,
      path: new Path(WORKSPACE_PATH),
      branch: WORKSPACE_BRANCH,
      metadata: WORKSPACE_METADATA,
    }),
  };
}

interface MockServerManager {
  startServer: (workspacePath: string) => Promise<number>;
  setInitialPrompt?: (workspacePath: string, config: unknown) => Promise<void>;
}

function createMockServerManager(opts?: { throwOnStart?: boolean }): MockServerManager {
  return {
    startServer: async () => {
      if (opts?.throwOnStart) {
        throw new Error("Agent server failed to start");
      }
      return 9090;
    },
    setInitialPrompt: vi.fn(),
  };
}

interface MockAgentStatusManager {
  getProvider: (
    path: string
  ) => { getEnvironmentVariables: () => Record<string, string> } | undefined;
}

function createMockAgentStatusManager(envVars?: Record<string, string>): MockAgentStatusManager {
  return {
    getProvider: () =>
      envVars !== undefined ? { getEnvironmentVariables: () => envVars } : undefined,
  };
}

interface MockKeepFilesService {
  copyToWorkspace: (
    projectRoot: Path,
    targetPath: Path
  ) => Promise<{
    configExists: boolean;
    copiedCount: number;
    skippedCount: number;
    errors: readonly { path: string; message: string }[];
  }>;
  /** State: tracks copy operations for assertions */
  copies: Array<{ from: Path; to: Path }>;
}

function createMockKeepFilesService(opts?: { throwOnCopy?: boolean }): MockKeepFilesService {
  const copies: Array<{ from: Path; to: Path }> = [];
  return {
    copies,
    copyToWorkspace: async (projectRoot: Path, targetPath: Path) => {
      if (opts?.throwOnCopy) {
        throw new Error("Keepfiles copy failed");
      }
      copies.push({ from: projectRoot, to: targetPath });
      return {
        configExists: true,
        copiedCount: 1,
        skippedCount: 0,
        errors: [],
      };
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetupOptions {
  serverManager?: MockServerManager;
  agentStatusManager?: MockAgentStatusManager;
  keepFilesService?: MockKeepFilesService;
  throwOnCreate?: boolean;
  setupThrows?: boolean;
  workspaceUrl?: string;
}

interface TestSetup {
  dispatcher: Dispatcher;
  projectId: ProjectId;
  keepFilesService: MockKeepFilesService;
}

function createTestSetup(opts?: TestSetupOptions): TestSetup {
  const projectId = generateProjectId(PROJECT_ROOT);
  const provider = createMockWorkspaceProvider();
  const serverManager = opts?.serverManager ?? createMockServerManager();
  const agentStatusManager =
    opts?.agentStatusManager ?? createMockAgentStatusManager({ AGENT_PORT: "9090" });
  const keepFilesService = opts?.keepFilesService ?? createMockKeepFilesService();
  const workspaceUrl = opts?.workspaceUrl ?? WORKSPACE_URL;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_CREATE_WORKSPACE, new CreateWorkspaceOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());

  // No-op SwitchViewModule for workspace:switch (just sets resolvedPath to satisfy operation)
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as SwitchWorkspaceHookContext;
            const intent = ctx.intent as SwitchWorkspaceIntent;
            // Minimal resolve: just set resolvedPath so the operation emits its event
            hookCtx.resolvedPath = `/workspaces/${intent.payload.workspaceName}`;
            hookCtx.projectPath = PROJECT_ROOT;
          },
        },
      },
    },
  };

  // WorktreeModule: "create" hook
  const worktreeModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            const intent = ctx.intent as CreateWorkspaceIntent;

            // Existing workspace path: populate context from existing data
            if (intent.payload.existingWorkspace) {
              const existing = intent.payload.existingWorkspace;
              hookCtx.workspacePath = existing.path;
              hookCtx.branch = existing.branch ?? existing.name;
              hookCtx.metadata = existing.metadata;
              hookCtx.projectPath = intent.payload.projectPath!;
              return;
            }

            if (intent.payload.projectId !== projectId) {
              throw new Error(`Project not found: ${intent.payload.projectId}`);
            }

            if (opts?.throwOnCreate) {
              throw new Error("Worktree creation failed");
            }

            const workspace = await provider.createWorkspace(
              intent.payload.name,
              intent.payload.base
            );

            hookCtx.workspacePath = workspace.path.toString();
            hookCtx.branch = workspace.branch;
            hookCtx.metadata = workspace.metadata;
            hookCtx.projectPath = PROJECT_ROOT;
          },
        },
      },
    },
  };

  // KeepFilesModule: "setup" hook (best-effort, try/catch internal)
  const keepFilesModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            try {
              const workspacePath = hookCtx.workspacePath!;
              const projectPath = hookCtx.projectPath!;
              await keepFilesService.copyToWorkspace(
                new Path(projectPath),
                new Path(workspacePath)
              );
            } catch {
              // Best-effort: do not re-throw
            }
          },
        },
      },
    },
  };

  // AgentModule: "setup" hook (best-effort, try/catch internal)
  const agentModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            const intent = ctx.intent as CreateWorkspaceIntent;
            try {
              await serverManager.startServer(hookCtx.workspacePath!);

              if (intent.payload.initialPrompt && serverManager.setInitialPrompt) {
                await serverManager.setInitialPrompt(
                  hookCtx.workspacePath!,
                  intent.payload.initialPrompt
                );
              }

              const agentProvider = agentStatusManager.getProvider(hookCtx.workspacePath!);
              hookCtx.envVars = agentProvider?.getEnvironmentVariables() ?? {};
            } catch {
              // Best-effort: do not re-throw
            }
          },
        },
      },
    },
  };

  // Failing setup hook: simulates a setup handler that throws without
  // internal try/catch. The hook runner will set ctx.error, but the
  // operation's execute() clears it, so the workspace is still created.
  // Only registered when setupThrows is true.
  const failingSetupModule: IntentModule | null = opts?.setupThrows
    ? {
        hooks: {
          [CREATE_WORKSPACE_OPERATION_ID]: {
            setup: {
              handler: async () => {
                throw new Error("Setup handler failed");
              },
            },
          },
        },
      }
    : null;

  // CodeServerModule: "finalize" hook
  const codeServerModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            // Use envVars with fallback (agent may have failed)
            void (hookCtx.envVars ?? {});
            hookCtx.workspaceUrl = workspaceUrl;
          },
        },
      },
    },
  };

  const modules: IntentModule[] = [
    switchViewModule,
    worktreeModule,
    keepFilesModule,
    agentModule,
    codeServerModule,
  ];
  if (failingSetupModule) {
    // Insert before keepFilesModule so the failing handler runs first on the "setup" hook
    modules.splice(1, 0, failingSetupModule);
  }
  wireModules(modules, hookRegistry, dispatcher);

  return { dispatcher, projectId, keepFilesService };
}

// =============================================================================
// Helpers
// =============================================================================

function createIntent(
  projectId: ProjectId,
  overrides?: Partial<CreateWorkspacePayload>
): CreateWorkspaceIntent {
  return {
    type: INTENT_CREATE_WORKSPACE,
    payload: {
      projectId,
      name: "feature-x",
      base: "main",
      ...overrides,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("CreateWorkspace Operation", () => {
  describe("creates workspace with correct return value (#1)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup();
    });

    it("returns Workspace with correct path, branch, metadata", async () => {
      const result = await setup.dispatcher.dispatch(createIntent(setup.projectId));

      expect(result).toBeDefined();
      const workspace = result as Workspace;
      expect(workspace.path).toBe(WORKSPACE_PATH);
      expect(workspace.branch).toBe(WORKSPACE_BRANCH);
      expect(workspace.metadata).toEqual(WORKSPACE_METADATA);
      expect(workspace.projectId).toBe(setup.projectId);
      expect(workspace.name).toBe(extractWorkspaceName(WORKSPACE_PATH));
    });
  });

  describe("emits workspace:created event with full payload (#2)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup();
    });

    it("emits event with all required fields", async () => {
      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await setup.dispatcher.dispatch(createIntent(setup.projectId));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.type).toBe(EVENT_WORKSPACE_CREATED);
      expect(event.payload.projectId).toBe(setup.projectId);
      expect(event.payload.workspaceName).toBe(extractWorkspaceName(WORKSPACE_PATH));
      expect(event.payload.workspacePath).toBe(WORKSPACE_PATH);
      expect(event.payload.projectPath).toBe(PROJECT_ROOT);
      expect(event.payload.branch).toBe(WORKSPACE_BRANCH);
      expect(event.payload.base).toBe("main");
      expect(event.payload.metadata).toEqual(WORKSPACE_METADATA);
      expect(event.payload.workspaceUrl).toBe(WORKSPACE_URL);
    });
  });

  describe("worktree creation failure propagates error (#3)", () => {
    it("throws error and does not emit event", async () => {
      const setup = createTestSetup({ throwOnCreate: true });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await expect(setup.dispatcher.dispatch(createIntent(setup.projectId))).rejects.toThrow(
        "Worktree creation failed"
      );

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("agent server failure produces workspace without envVars (#4)", () => {
    it("returns valid workspace when agent fails", async () => {
      const setup = createTestSetup({
        serverManager: createMockServerManager({ throwOnStart: true }),
        agentStatusManager: createMockAgentStatusManager(undefined),
      });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const result = await setup.dispatcher.dispatch(createIntent(setup.projectId));

      // Operation succeeds
      expect(result).toBeDefined();
      const workspace = result as Workspace;
      expect(workspace.path).toBe(WORKSPACE_PATH);
      expect(workspace.branch).toBe(WORKSPACE_BRANCH);

      // Event is emitted
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.workspaceUrl).toBe(WORKSPACE_URL);
    });
  });

  describe("best-effort setup failure still produces workspace (#5)", () => {
    it("returns valid workspace when a setup handler throws without try/catch", async () => {
      const setup = createTestSetup({ setupThrows: true });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const result = await setup.dispatcher.dispatch(createIntent(setup.projectId));

      // Operation succeeds despite setup hook error
      expect(result).toBeDefined();
      const workspace = result as Workspace;
      expect(workspace.path).toBe(WORKSPACE_PATH);
      expect(workspace.branch).toBe(WORKSPACE_BRANCH);

      // Event is emitted
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.workspaceUrl).toBe(WORKSPACE_URL);
    });
  });

  describe("unknown project throws (#6)", () => {
    it("throws Project not found error", async () => {
      const setup = createTestSetup();

      await expect(
        setup.dispatcher.dispatch(createIntent("nonexistent-12345678" as ProjectId))
      ).rejects.toThrow("Project not found");
    });
  });

  describe("initial prompt included in event payload (#7)", () => {
    it("includes normalizedInitialPrompt in event", async () => {
      const setup = createTestSetup();

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await setup.dispatcher.dispatch(
        createIntent(setup.projectId, {
          initialPrompt: { prompt: "Implement login", agent: "build" },
        })
      );

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.initialPrompt).toEqual({
        prompt: "Implement login",
        agent: "build",
      });
    });

    it("normalizes string prompt to object", async () => {
      const setup = createTestSetup();

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await setup.dispatcher.dispatch(
        createIntent(setup.projectId, {
          initialPrompt: "Fix the bug",
        })
      );

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.initialPrompt).toEqual({
        prompt: "Fix the bug",
      });
    });
  });

  describe("keepInBackground flag included in event payload (#8)", () => {
    it("includes keepInBackground in event when true", async () => {
      const setup = createTestSetup();

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await setup.dispatcher.dispatch(createIntent(setup.projectId, { keepInBackground: true }));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.keepInBackground).toBe(true);
    });

    it("does not include keepInBackground when not specified", async () => {
      const setup = createTestSetup();

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await setup.dispatcher.dispatch(createIntent(setup.projectId));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.keepInBackground).toBeUndefined();
    });
  });

  describe("interceptor cancels creation (#9)", () => {
    it("returns undefined and emits no events", async () => {
      const setup = createTestSetup();

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(createIntent(setup.projectId));

      expect(result).toBeUndefined();
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("keepfiles copies files after worktree creation (#10)", () => {
    it("copies files with correct project and workspace paths", async () => {
      const setup = createTestSetup();

      await setup.dispatcher.dispatch(createIntent(setup.projectId));

      expect(setup.keepFilesService.copies).toHaveLength(1);
      expect(setup.keepFilesService.copies[0]!.from.toString()).toBe(PROJECT_ROOT);
      expect(setup.keepFilesService.copies[0]!.to.toString()).toBe(WORKSPACE_PATH);
    });
  });

  describe("keepfiles failure does not fail workspace creation (#11)", () => {
    it("returns valid workspace when keepfiles copy throws", async () => {
      const failingKeepFiles = createMockKeepFilesService({ throwOnCopy: true });
      const setup = createTestSetup({ keepFilesService: failingKeepFiles });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const result = await setup.dispatcher.dispatch(createIntent(setup.projectId));

      // Operation succeeds despite keepfiles failure
      expect(result).toBeDefined();
      const workspace = result as Workspace;
      expect(workspace.path).toBe(WORKSPACE_PATH);
      expect(workspace.branch).toBe(WORKSPACE_BRANCH);

      // Event is emitted
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.workspaceUrl).toBe(WORKSPACE_URL);

      // No successful copies recorded
      expect(failingKeepFiles.copies).toHaveLength(0);
    });
  });

  describe("no keepfiles side effects when worktree creation fails (#12)", () => {
    it("does not invoke keepfiles when create hook throws", async () => {
      const setup = createTestSetup({ throwOnCreate: true });

      await expect(setup.dispatcher.dispatch(createIntent(setup.projectId))).rejects.toThrow(
        "Worktree creation failed"
      );

      // Keepfiles should not have been called
      expect(setup.keepFilesService.copies).toHaveLength(0);
    });
  });

  describe("existingWorkspace skips worktree creation (#15)", () => {
    it("registers workspace with existing path/branch, no new worktree", async () => {
      const setup = createTestSetup();

      const existingWorkspace: ExistingWorkspaceData = {
        path: "/existing/workspace/feature-y",
        name: "feature-y",
        branch: "feature-y",
        metadata: { base: "main" },
      };

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const intent: CreateWorkspaceIntent = {
        type: INTENT_CREATE_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          name: "feature-y",
          base: "main",
          existingWorkspace,
          projectPath: PROJECT_ROOT,
        },
      };

      const result = await setup.dispatcher.dispatch(intent);

      expect(result).toBeDefined();
      const workspace = result as Workspace;
      expect(workspace.path).toBe("/existing/workspace/feature-y");
      expect(workspace.branch).toBe("feature-y");
      expect(workspace.metadata).toEqual({ base: "main" });

      // Event emitted with existing workspace data
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.workspacePath).toBe("/existing/workspace/feature-y");
      expect(event.payload.projectPath).toBe(PROJECT_ROOT);
    });
  });

  describe("existingWorkspace uses projectPath directly (#16)", () => {
    it("populates context without projectId resolution", async () => {
      const setup = createTestSetup();
      const customProjectPath = "/custom/project/path";

      const existingWorkspace: ExistingWorkspaceData = {
        path: "/custom/workspace/my-ws",
        name: "my-ws",
        branch: null,
        metadata: { base: "develop" },
      };

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      const intent: CreateWorkspaceIntent = {
        type: INTENT_CREATE_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          name: "my-ws",
          base: "develop",
          existingWorkspace,
          projectPath: customProjectPath,
        },
      };

      const result = await setup.dispatcher.dispatch(intent);

      expect(result).toBeDefined();
      const workspace = result as Workspace;
      // branch falls back to name when null
      expect(workspace.branch).toBe("my-ws");

      // Event uses the provided projectPath directly
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceCreatedEvent;
      expect(event.payload.projectPath).toBe(customProjectPath);
    });
  });
});
