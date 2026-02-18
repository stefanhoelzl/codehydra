// @vitest-environment node
/**
 * Integration tests for open-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> hooks -> event -> result,
 * including event emission on success, error propagation on failure,
 * and fatal handling of agent/setup failures.
 *
 * Test plan items covered:
 * #1: Creates workspace with correct return value
 * #2: Emits workspace:created event with full payload
 * #3: Worktree creation failure propagates error
 * #4: Agent server failure fails workspace creation
 * #5: Setup handler failure fails workspace creation
 * #6: Unknown project throws
 * #7: Initial prompt included in event payload
 * #8: keepInBackground flag included in event payload
 * #9: Interceptor cancels creation
 * #10: Keepfiles copies files after worktree creation
 * #11: Keepfiles failure does not fail workspace creation
 * #12: No keepfiles side effects when worktree creation fails
 * #15: existingWorkspace skips worktree creation
 * #16: existingWorkspace uses projectPath directly
 * #17: Incomplete payload returns bases
 * #18: Resolve-project failure propagates error
 *
 * Regression coverage (APP_LIFECYCLE_INTENTS #10):
 * The agentModule's setup hook behavior (starting per-workspace server) is tested
 * in test #4 ("agent server failure fails workspace creation"). This verifies that
 * the extended agentModule (which now also has app:start/stop hooks in the production
 * bootstrap) still correctly handles per-workspace server startup via its
 * workspace:open setup hook.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  OpenWorkspaceOperation,
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./open-workspace";
import type {
  OpenWorkspaceIntent,
  OpenWorkspacePayload,
  CreateHookInput,
  CreateHookResult,
  SetupHookInput,
  SetupHookResult,
  FinalizeHookInput,
  FinalizeHookResult,
  WorkspaceCreatedEvent,
  ExistingWorkspaceData,
  ResolveProjectHookResult,
} from "./open-workspace";
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
import type {
  SwitchWorkspaceHookResult,
  ResolveProjectHookResult as SwitchResolveProjectHookResult,
  ResolveWorkspaceHookInput,
  ResolveWorkspaceHookResult,
  ActivateHookInput,
} from "./switch-workspace";

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
  fetchBasesModule?: IntentModule;
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

  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(extractWorkspaceName, (path: string) => generateProjectId(path))
  );

  // Minimal switch modules for workspace:switch (satisfy 3 hook points)
  const switchResolveProjectModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (): Promise<SwitchResolveProjectHookResult> => {
            return { projectPath: PROJECT_ROOT, projectName: "test" };
          },
        },
      },
    },
  };
  const switchResolveWorkspaceModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { workspaceName } = ctx as ResolveWorkspaceHookInput;
            return { workspacePath: `/workspaces/${workspaceName}` };
          },
        },
      },
    },
  };
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath } = ctx as ActivateHookInput;
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
  };

  // ResolveProjectModule: "resolve-project" hook — resolves projectId to project path
  const resolveProjectModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            // Short-circuit: if projectPath is in payload, use it
            if (intent.payload.projectPath) {
              return { projectPath: intent.payload.projectPath };
            }
            // Check projectId
            if (intent.payload.projectId === projectId) {
              return { projectPath: PROJECT_ROOT };
            }
            return {};
          },
        },
      },
    },
  };

  // Default FetchBasesModule: "fetch-bases" hook — returns bases for dialog
  const defaultFetchBasesModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        "fetch-bases": {
          handler: async (): Promise<{
            bases: readonly { name: string; isRemote: boolean }[];
            defaultBaseBranch?: string;
          }> => {
            return {
              bases: [
                { name: "main", isRemote: false },
                { name: "origin/main", isRemote: true },
              ],
              defaultBaseBranch: "main",
            };
          },
        },
      },
    },
  };

  const fetchBasesModule = opts?.fetchBasesModule ?? defaultFetchBasesModule;

  // WorktreeModule: "create" hook — returns CreateHookResult
  const worktreeModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<CreateHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { projectPath } = ctx as CreateHookInput;

            // Existing workspace path: return context from existing data
            if (intent.payload.existingWorkspace) {
              const existing = intent.payload.existingWorkspace;
              return {
                workspacePath: existing.path,
                branch: existing.branch ?? existing.name,
                metadata: existing.metadata,
              };
            }

            if (intent.payload.projectId !== projectId) {
              throw new Error(`Project not found: ${intent.payload.projectId}`);
            }

            if (opts?.throwOnCreate) {
              throw new Error("Worktree creation failed");
            }

            const workspace = await provider.createWorkspace(
              intent.payload.workspaceName!,
              intent.payload.base!
            );

            // Suppress unused variable warning for projectPath verification
            void projectPath;

            return {
              workspacePath: workspace.path.toString(),
              branch: workspace.branch,
              metadata: workspace.metadata,
            };
          },
        },
      },
    },
  };

  // KeepFilesModule: "setup" hook (best-effort, try/catch internal)
  const keepFilesModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            try {
              await keepFilesService.copyToWorkspace(
                new Path(setupCtx.projectPath),
                new Path(setupCtx.workspacePath)
              );
            } catch {
              // Best-effort: do not re-throw
            }
            return {};
          },
        },
      },
    },
  };

  // AgentModule: "setup" hook (fatal — no try/catch)
  const agentModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;

            await serverManager.startServer(setupCtx.workspacePath);

            if (intent.payload.initialPrompt && serverManager.setInitialPrompt) {
              await serverManager.setInitialPrompt(
                setupCtx.workspacePath,
                intent.payload.initialPrompt
              );
            }

            const agentProvider = agentStatusManager.getProvider(setupCtx.workspacePath);
            return { envVars: agentProvider?.getEnvironmentVariables() ?? {} };
          },
        },
      },
    },
  };

  // Failing setup hook: simulates a setup handler that throws without
  // internal try/catch. With collect(), the error is returned in the errors
  // array, and the operation throws on any setup error (fatal).
  // Only registered when setupThrows is true.
  const failingSetupModule: IntentModule | null = opts?.setupThrows
    ? {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            setup: {
              handler: async () => {
                throw new Error("Setup handler failed");
              },
            },
          },
        },
      }
    : null;

  // CodeServerModule: "finalize" hook — returns FinalizeHookResult
  const codeServerModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<FinalizeHookResult> => {
            void (ctx as FinalizeHookInput).envVars;
            return { workspaceUrl };
          },
        },
      },
    },
  };

  const modules: IntentModule[] = [
    switchResolveProjectModule,
    switchResolveWorkspaceModule,
    switchViewModule,
    resolveProjectModule,
    fetchBasesModule,
    worktreeModule,
    keepFilesModule,
    agentModule,
    codeServerModule,
  ];
  if (failingSetupModule) {
    // Insert before keepFilesModule so the failing handler runs first on the "setup" hook
    modules.splice(modules.indexOf(worktreeModule) + 1, 0, failingSetupModule);
  }
  wireModules(modules, hookRegistry, dispatcher);

  return { dispatcher, projectId, keepFilesService };
}

// =============================================================================
// Helpers
// =============================================================================

function createIntent(
  projectId: ProjectId,
  overrides?: Partial<OpenWorkspacePayload>
): OpenWorkspaceIntent {
  return {
    type: INTENT_OPEN_WORKSPACE,
    payload: {
      projectId,
      workspaceName: "feature-x",
      base: "main",
      ...overrides,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenWorkspace Operation", () => {
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

  describe("agent server failure fails workspace creation (#4)", () => {
    it("throws error and does not emit event when agent fails", async () => {
      const setup = createTestSetup({
        serverManager: createMockServerManager({ throwOnStart: true }),
        agentStatusManager: createMockAgentStatusManager(undefined),
      });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await expect(setup.dispatcher.dispatch(createIntent(setup.projectId))).rejects.toThrow(
        "Agent server failed to start"
      );

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("setup handler failure fails workspace creation (#5)", () => {
    it("throws error and does not emit event when a setup handler throws", async () => {
      const setup = createTestSetup({ setupThrows: true });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_CREATED, (event) => {
        receivedEvents.push(event);
      });

      await expect(setup.dispatcher.dispatch(createIntent(setup.projectId))).rejects.toThrow(
        "Setup handler failed"
      );

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("unknown project throws (#6)", () => {
    it("throws Project not found error", async () => {
      const setup = createTestSetup();

      await expect(
        setup.dispatcher.dispatch(createIntent("nonexistent-12345678" as ProjectId))
      ).rejects.toThrow("resolve-project hook did not provide projectPath");
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

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          workspaceName: "feature-y",
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

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          workspaceName: "my-ws",
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

  describe("incomplete payload returns bases (#17)", () => {
    it("returns bases when workspaceName is missing", async () => {
      const setup = createTestSetup();

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          // No workspaceName or base
        },
      };

      const result = await setup.dispatcher.dispatch(intent);

      expect(result).toBeDefined();
      // Result should be the bases object, not a Workspace
      expect(result).toHaveProperty("bases");
      const basesResult = result as {
        bases: readonly { name: string; isRemote: boolean }[];
        defaultBaseBranch?: string;
      };
      expect(basesResult.bases).toHaveLength(2);
      expect(basesResult.bases[0]).toEqual({ name: "main", isRemote: false });
      expect(basesResult.bases[1]).toEqual({ name: "origin/main", isRemote: true });
      expect(basesResult.defaultBaseBranch).toBe("main");
    });

    it("returns bases when base is missing", async () => {
      const setup = createTestSetup();

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: setup.projectId,
          workspaceName: "feature-x",
          // No base
        },
      };

      const result = await setup.dispatcher.dispatch(intent);

      expect(result).toBeDefined();
      expect(result).toHaveProperty("bases");
      const basesResult = result as { bases: readonly { name: string; isRemote: boolean }[] };
      expect(basesResult.bases).toHaveLength(2);
    });
  });

  describe("resolve-project failure propagates error (#18)", () => {
    it("throws when resolve-project provides no projectPath", async () => {
      const setup = createTestSetup();

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: "nonexistent-12345678" as ProjectId,
          workspaceName: "feature-x",
          base: "main",
        },
      };

      await expect(setup.dispatcher.dispatch(intent)).rejects.toThrow(
        "resolve-project hook did not provide projectPath"
      );
    });
  });

  describe("env var accumulation from multiple setup modules (#19)", () => {
    it("merges envVars from multiple setup hooks", async () => {
      // Add a second setup module that contributes additional env vars
      const extraEnvModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            setup: {
              handler: async (): Promise<SetupHookResult> => {
                return { envVars: { BRIDGE_PORT: "15000" } };
              },
            },
          },
        },
      };

      // Re-create setup with the extra module
      const projectId = generateProjectId(PROJECT_ROOT);
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
      dispatcher.registerOperation(
        INTENT_SWITCH_WORKSPACE,
        new SwitchWorkspaceOperation(extractWorkspaceName, (path: string) =>
          generateProjectId(path)
        )
      );

      // Minimal switch modules
      const switchResolveProjectModule: IntentModule = {
        hooks: {
          [SWITCH_WORKSPACE_OPERATION_ID]: {
            "resolve-project": {
              handler: async (): Promise<SwitchResolveProjectHookResult> => {
                return { projectPath: PROJECT_ROOT, projectName: "test" };
              },
            },
          },
        },
      };
      const switchResolveWorkspaceModule: IntentModule = {
        hooks: {
          [SWITCH_WORKSPACE_OPERATION_ID]: {
            "resolve-workspace": {
              handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
                const { workspaceName } = ctx as ResolveWorkspaceHookInput;
                return { workspacePath: `/workspaces/${workspaceName}` };
              },
            },
          },
        },
      };
      const switchViewModule: IntentModule = {
        hooks: {
          [SWITCH_WORKSPACE_OPERATION_ID]: {
            activate: {
              handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
                const { workspacePath } = ctx as ActivateHookInput;
                return { resolvedPath: workspacePath };
              },
            },
          },
        },
      };
      const resolveProjectModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            "resolve-project": {
              handler: async (): Promise<ResolveProjectHookResult> => {
                return { projectPath: PROJECT_ROOT };
              },
            },
          },
        },
      };
      const fetchBasesModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            "fetch-bases": {
              handler: async () => ({
                bases: [{ name: "main", isRemote: false }],
              }),
            },
          },
        },
      };
      const worktreeModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            create: {
              handler: async (): Promise<CreateHookResult> => ({
                workspacePath: WORKSPACE_PATH,
                branch: WORKSPACE_BRANCH,
                metadata: WORKSPACE_METADATA,
              }),
            },
          },
        },
      };
      // Agent module contributes AGENT_PORT
      const agentModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            setup: {
              handler: async (): Promise<SetupHookResult> => {
                return { envVars: { AGENT_PORT: "9090" } };
              },
            },
          },
        },
      };
      // Finalize module captures envVars for verification
      let capturedEnvVars: Record<string, string> = {};
      const codeServerModule: IntentModule = {
        hooks: {
          [OPEN_WORKSPACE_OPERATION_ID]: {
            finalize: {
              handler: async (ctx: HookContext): Promise<FinalizeHookResult> => {
                capturedEnvVars = (ctx as FinalizeHookInput).envVars;
                return { workspaceUrl: WORKSPACE_URL };
              },
            },
          },
        },
      };

      wireModules(
        [
          switchResolveProjectModule,
          switchResolveWorkspaceModule,
          switchViewModule,
          resolveProjectModule,
          fetchBasesModule,
          worktreeModule,
          agentModule,
          extraEnvModule,
          codeServerModule,
        ],
        hookRegistry,
        dispatcher
      );

      await dispatcher.dispatch(createIntent(projectId));

      // Both modules' envVars should be merged
      expect(capturedEnvVars).toEqual({
        AGENT_PORT: "9090",
        BRIDGE_PORT: "15000",
      });
    });
  });
});
