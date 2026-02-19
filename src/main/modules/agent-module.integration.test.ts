// @vitest-environment node
/**
 * Integration tests for AgentModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 *
 * The agent module's `start` hook creates AgentStatusManager and
 * AgentServerManager internally using factory functions. We mock the
 * `../../agents` module so the `start` hook uses our mock objects.
 * Tests that need lifecycle state (activate, stop, workspace setup/shutdown,
 * get-status, get-session, restart) first dispatch through a MinimalStartOperation
 * to populate the module's internal closure state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type {
  CheckConfigResult,
  CheckDepsResult,
  CheckDepsHookContext,
  StartHookResult,
  ActivateHookContext,
  ActivateHookResult,
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type {
  AgentSelectionHookResult,
  SaveAgentHookInput,
  BinaryHookInput,
} from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type {
  SetupHookInput,
  SetupHookResult,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  ShutdownHookResult,
} from "../operations/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import type { GetStatusHookInput, GetStatusHookResult } from "../operations/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../operations/get-agent-session";
import type {
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
} from "../operations/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../operations/restart-agent";
import type { RestartAgentHookInput, RestartAgentHookResult } from "../operations/restart-agent";
import { createAgentModule, type AgentModuleDeps } from "./agent-module";
import { SILENT_LOGGER } from "../../services/logging";
import type { LoggingService } from "../../services/logging";
import { createBehavioralIpcLayer } from "../../services/platform/ipc.test-utils";
import { SetupError } from "../../services/errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import { AgentStatusManager, createAgentServerManager, createAgentProvider } from "../../agents";
import type { AgentServerManager } from "../../agents/types";

// =============================================================================
// Mock the agents module so the start hook uses our mock objects
// =============================================================================

vi.mock("../../agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../agents")>();
  return {
    ...original,
    AgentStatusManager: vi.fn(),
    createAgentServerManager: vi.fn(),
    createAgentProvider: vi.fn(),
  };
});

// =============================================================================
// Minimal Test Operations
// =============================================================================

class MinimalCheckConfigOperation implements Operation<Intent, CheckConfigResult> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<CheckConfigResult> {
    const { results, errors } = await ctx.hooks.collect<CheckConfigResult>("check-config", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? { configuredAgent: null };
  }
}

class MinimalCheckDepsOperation implements Operation<Intent, CheckDepsResult> {
  readonly id = APP_START_OPERATION_ID;
  private readonly hookInput: Partial<CheckDepsHookContext>;

  constructor(hookInput: Partial<CheckDepsHookContext> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<CheckDepsResult> {
    const { results, errors } = await ctx.hooks.collect<CheckDepsResult>("check-deps", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    const merged: CheckDepsResult = {};
    for (const r of results) {
      if (r.missingBinaries) {
        (merged as Record<string, unknown>).missingBinaries = [
          ...((merged.missingBinaries as string[]) ?? []),
          ...r.missingBinaries,
        ];
      }
    }
    return merged;
  }
}

class MinimalStartOperation implements Operation<Intent, StartHookResult> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<StartHookResult> {
    const { results, errors } = await ctx.hooks.collect<StartHookResult>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalStartAndActivateOperation implements Operation<Intent, ActivateHookResult> {
  readonly id = APP_START_OPERATION_ID;
  private readonly hookInput: Partial<ActivateHookContext>;

  constructor(hookInput: Partial<ActivateHookContext> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<ActivateHookResult> {
    // Run start first to populate closure state
    await ctx.hooks.collect<StartHookResult>("start", { intent: ctx.intent });
    // Then run activate
    const { results, errors } = await ctx.hooks.collect<ActivateHookResult>("activate", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalStopOperation implements Operation<Intent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("stop", { intent: ctx.intent });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalAgentSelectionOperation implements Operation<Intent, AgentSelectionHookResult> {
  readonly id = SETUP_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<AgentSelectionHookResult> {
    const { results, errors } = await ctx.hooks.collect<AgentSelectionHookResult>(
      "agent-selection",
      { intent: ctx.intent }
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? { selectedAgent: "opencode" };
  }
}

class MinimalSaveAgentOperation implements Operation<Intent, void> {
  readonly id = SETUP_OPERATION_ID;
  private readonly hookInput: Partial<SaveAgentHookInput>;

  constructor(hookInput: Partial<SaveAgentHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("save-agent", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalBinaryOperation implements Operation<Intent, void> {
  readonly id = SETUP_OPERATION_ID;
  private readonly hookInput: Partial<BinaryHookInput>;

  constructor(hookInput: Partial<BinaryHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("binary", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalSetupOperation implements Operation<OpenWorkspaceIntent, SetupHookResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<SetupHookInput>;

  constructor(hookInput: Partial<SetupHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<SetupHookResult> {
    const { results, errors } = await ctx.hooks.collect<SetupHookResult>("setup", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalShutdownOperation implements Operation<DeleteWorkspaceIntent, ShutdownHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<ShutdownHookResult> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath ?? "",
      workspacePath: payload.workspacePath ?? "",
    };
    const { results, errors } = await ctx.hooks.collect<ShutdownHookResult>("shutdown", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalGetStatusOperation implements Operation<Intent, GetStatusHookResult> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;
  private readonly hookInput: Partial<GetStatusHookInput>;

  constructor(hookInput: Partial<GetStatusHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<GetStatusHookResult> {
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalGetSessionOperation implements Operation<Intent, GetAgentSessionHookResult> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;
  private readonly hookInput: Partial<GetAgentSessionHookInput>;

  constructor(hookInput: Partial<GetAgentSessionHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<GetAgentSessionHookResult> {
    const { results, errors } = await ctx.hooks.collect<GetAgentSessionHookResult>("get", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? { session: null };
  }
}

class MinimalRestartOperation implements Operation<Intent, RestartAgentHookResult> {
  readonly id = RESTART_AGENT_OPERATION_ID;
  private readonly hookInput: Partial<RestartAgentHookInput>;

  constructor(hookInput: Partial<RestartAgentHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<RestartAgentHookResult> {
    const { results, errors } = await ctx.hooks.collect<RestartAgentHookResult>("restart", {
      intent: ctx.intent,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

// =============================================================================
// Mock Factories
// =============================================================================

function createMockServerManager(agentType: "opencode" | "claude" = "opencode") {
  const base: AgentServerManager & Record<string, unknown> = {
    startServer: vi.fn().mockResolvedValue(8080),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true, port: 8081 }),
    isRunning: vi.fn().mockReturnValue(true),
    getPort: vi.fn().mockReturnValue(8080),
    stopAllForProject: vi.fn().mockResolvedValue(undefined),
    onServerStarted: vi.fn().mockReturnValue(vi.fn()),
    onServerStopped: vi.fn().mockReturnValue(vi.fn()),
    setMarkActiveHandler: vi.fn(),
    setInitialPrompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  if (agentType === "opencode") {
    base.getBridgePort = vi.fn().mockReturnValue(9999);
    base.setMcpConfig = vi.fn();
  } else {
    base.setMcpConfig = vi.fn();
  }

  return base;
}

function createMockAgentStatusManager() {
  return {
    onStatusChanged: vi.fn().mockReturnValue(vi.fn()),
    getStatus: vi.fn().mockReturnValue({
      status: "idle" as const,
      counts: { idle: 1, busy: 0 },
    }),
    getSession: vi.fn().mockReturnValue({ port: 8080, sessionId: "sess-1" }),
    getProvider: vi.fn().mockReturnValue({
      getEnvironmentVariables: vi.fn().mockReturnValue({ OPENCODE_PORT: "8080" }),
    }),
    hasProvider: vi.fn().mockReturnValue(false),
    markActive: vi.fn(),
    clearTuiTracking: vi.fn(),
    dispose: vi.fn(),
    getLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    getSdkFactory: vi.fn().mockReturnValue(undefined),
    addProvider: vi.fn(),
    removeWorkspace: vi.fn(),
    disconnectWorkspace: vi.fn(),
    reconnectWorkspace: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Configure the vi.mock'd constructors/factories to return our mock objects.
 * Must be called before dispatching any operation that triggers the `start` hook.
 */
function setupAgentMocks(agentType: "opencode" | "claude" = "opencode") {
  const mockSM = createMockServerManager(agentType);
  const mockASM = createMockAgentStatusManager();

  vi.mocked(AgentStatusManager).mockImplementation(function (this: AgentStatusManager) {
    return mockASM as unknown as AgentStatusManager;
  });
  vi.mocked(createAgentServerManager).mockReturnValue(mockSM as unknown as AgentServerManager);
  vi.mocked(createAgentProvider).mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
    fetchStatus: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ ok: true, value: { id: "sess-1" } }),
    sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
    getEnvironmentVariables: vi.fn().mockReturnValue({ OPENCODE_PORT: "8080" }),
  } as never);

  return { mockSM, mockASM };
}

function createMockDeps(): AgentModuleDeps {
  const ipcLayer = createBehavioralIpcLayer();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  return {
    configService: {
      load: vi.fn().mockResolvedValue({ agent: "opencode" }),
      setAgent: vi.fn().mockResolvedValue(undefined),
    },
    getAgentBinaryManager: vi.fn().mockReturnValue({
      preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
      downloadBinary: vi.fn().mockResolvedValue(undefined),
      getBinaryType: vi.fn().mockReturnValue("opencode"),
    }),
    ipcLayer,
    getUIWebContentsFn: vi.fn().mockReturnValue({
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn(),
    }),
    reportProgress: vi.fn(),
    logger: SILENT_LOGGER,
    loggingService: {
      createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    } as unknown as LoggingService,
    dispatcher,
    killTerminalsCallback: vi.fn().mockResolvedValue(undefined),
    serverManagerDeps: {
      processRunner: {} as never,
      portManager: {} as never,
      httpClient: {} as never,
      pathProvider: {} as never,
      fileSystem: {} as never,
      logger: SILENT_LOGGER,
    },
    onAgentInitialized: vi.fn(),
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup() {
  const deps = createMockDeps();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const module = createAgentModule(deps);

  wireModules([module], hookRegistry, dispatcher);

  return { deps, dispatcher, hookRegistry };
}

// =============================================================================
// Tests
// =============================================================================

describe("AgentModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // check-config
  // ---------------------------------------------------------------------------

  describe("check-config", () => {
    it("loads config and returns configuredAgent", async () => {
      const { deps, dispatcher } = createTestSetup();
      (deps.configService.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent: "claude",
      });
      dispatcher.registerOperation("app:start", new MinimalCheckConfigOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckConfigResult;

      expect(result.configuredAgent).toBe("claude");
      expect(deps.configService.load).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // check-deps
  // ---------------------------------------------------------------------------

  describe("check-deps", () => {
    it("returns missingBinaries when agent binary needs download", async () => {
      const { deps, dispatcher } = createTestSetup();
      const mockBinaryManager = {
        preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn(),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      dispatcher.registerOperation(
        "app:start",
        new MinimalCheckDepsOperation({ configuredAgent: "opencode" })
      );

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("opencode");
      expect(deps.getAgentBinaryManager).toHaveBeenCalledWith("opencode");
    });

    it("returns empty missingBinaries when no agent configured", async () => {
      const { deps, dispatcher } = createTestSetup();
      dispatcher.registerOperation(
        "app:start",
        new MinimalCheckDepsOperation({ configuredAgent: null })
      );

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).toEqual([]);
      expect(deps.getAgentBinaryManager).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // agent-selection
  // ---------------------------------------------------------------------------

  describe("agent-selection", () => {
    it("sends IPC to show selection and returns chosen agent", async () => {
      const { deps, dispatcher } = createTestSetup();
      const mockWebContents = {
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      };
      (deps.getUIWebContentsFn as ReturnType<typeof vi.fn>).mockReturnValue(mockWebContents);
      dispatcher.registerOperation("setup", new MinimalAgentSelectionOperation());

      // Simulate user selecting "claude" after IPC is sent
      const resultPromise = dispatcher.dispatch({
        type: "setup",
        payload: {},
      });

      // Give the hook time to register the IPC listener and send the IPC message
      await vi.waitFor(() => {
        expect(mockWebContents.send).toHaveBeenCalledWith(
          ApiIpcChannels.LIFECYCLE_SHOW_AGENT_SELECTION,
          expect.objectContaining({ agents: ["opencode", "claude"] })
        );
      });

      // Simulate the renderer responding
      const ipcLayer = deps.ipcLayer as ReturnType<typeof createBehavioralIpcLayer>;
      ipcLayer._emit(ApiIpcChannels.LIFECYCLE_AGENT_SELECTED, { agent: "claude" });

      const result = (await resultPromise) as AgentSelectionHookResult;
      expect(result.selectedAgent).toBe("claude");
    });
  });

  // ---------------------------------------------------------------------------
  // save-agent
  // ---------------------------------------------------------------------------

  describe("save-agent", () => {
    it("persists agent selection to config", async () => {
      const { deps, dispatcher } = createTestSetup();
      dispatcher.registerOperation(
        "setup",
        new MinimalSaveAgentOperation({ selectedAgent: "claude" })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.configService.setAgent).toHaveBeenCalledWith("claude");
    });

    it("throws SetupError when setAgent fails", async () => {
      const { deps, dispatcher } = createTestSetup();
      (deps.configService.setAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("disk full")
      );
      dispatcher.registerOperation(
        "setup",
        new MinimalSaveAgentOperation({ selectedAgent: "opencode" })
      );

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    it("downloads agent binary when missing", async () => {
      const { deps, dispatcher } = createTestSetup();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn().mockResolvedValue(undefined),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      dispatcher.registerOperation(
        "setup",
        new MinimalBinaryOperation({
          selectedAgent: "opencode",
          missingBinaries: ["opencode"],
        })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockBinaryManager.downloadBinary).toHaveBeenCalled();
      expect(deps.reportProgress).toHaveBeenCalledWith("agent", "done");
    });

    it("skips download when binary is not missing", async () => {
      const { deps, dispatcher } = createTestSetup();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn(),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      dispatcher.registerOperation(
        "setup",
        new MinimalBinaryOperation({
          selectedAgent: "opencode",
          missingBinaries: [],
        })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockBinaryManager.downloadBinary).not.toHaveBeenCalled();
      expect(deps.reportProgress).toHaveBeenCalledWith("agent", "done");
    });

    it("reports progress during download and handles error", async () => {
      const { deps, dispatcher } = createTestSetup();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn().mockRejectedValue(new Error("network error")),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      dispatcher.registerOperation(
        "setup",
        new MinimalBinaryOperation({
          selectedAgent: "opencode",
          missingBinaries: ["opencode"],
        })
      );

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(deps.reportProgress).toHaveBeenCalledWith(
        "agent",
        "failed",
        undefined,
        "network error"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("wires status changes to dispatcher via onStatusChanged", async () => {
      const { mockSM, mockASM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Verify onStatusChanged was subscribed
      expect(mockASM.onStatusChanged).toHaveBeenCalledWith(expect.any(Function));

      // Verify server callbacks were wired
      expect(mockSM.onServerStarted).toHaveBeenCalledWith(expect.any(Function));
      expect(mockSM.onServerStopped).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for opencode", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMarkActiveHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for claude", async () => {
      const { mockSM } = setupAgentMocks("claude");
      const { deps, dispatcher } = createTestSetup();
      (deps.configService.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent: "claude",
      });
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMarkActiveHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it("dispatches agent:update-status when status changes", async () => {
      // Capture the status callback
      const { mockASM } = setupAgentMocks("opencode");
      let statusCallback: ((path: WorkspacePath, status: AggregatedAgentStatus) => void) | null =
        null;
      mockASM.onStatusChanged.mockImplementation(
        (cb: (path: WorkspacePath, status: AggregatedAgentStatus) => void) => {
          statusCallback = cb;
          return vi.fn();
        }
      );

      // Create module deps with shared dispatcher
      const ipcLayer = createBehavioralIpcLayer();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      const deps: AgentModuleDeps = {
        configService: {
          load: vi.fn().mockResolvedValue({ agent: "opencode" }),
          setAgent: vi.fn().mockResolvedValue(undefined),
        },
        getAgentBinaryManager: vi.fn().mockReturnValue({
          preflight: vi.fn(),
          downloadBinary: vi.fn(),
          getBinaryType: vi.fn().mockReturnValue("opencode"),
        }),
        ipcLayer,
        getUIWebContentsFn: vi.fn().mockReturnValue(null),
        reportProgress: vi.fn(),
        logger: SILENT_LOGGER,
        loggingService: {
          createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
        } as unknown as LoggingService,
        dispatcher,
        killTerminalsCallback: vi.fn().mockResolvedValue(undefined),
        serverManagerDeps: {
          processRunner: {} as never,
          portManager: {} as never,
          httpClient: {} as never,
          pathProvider: {} as never,
          fileSystem: {} as never,
          logger: SILENT_LOGGER,
        },
        onAgentInitialized: vi.fn(),
      };

      const module = createAgentModule(deps);
      wireModules([module], hookRegistry, dispatcher);

      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      // Register a mock operation for agent:update-status so dispatch succeeds
      const updateStatusSpy = vi.fn();
      dispatcher.registerOperation("agent:update-status", {
        id: "update-agent-status",
        execute: async (ctx: OperationContext<Intent>) => {
          updateStatusSpy(ctx.intent);
        },
      });

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Simulate a status change
      expect(statusCallback).not.toBeNull();
      const testStatus: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 1 } };
      statusCallback!("/test/workspace" as WorkspacePath, testStatus);

      // Wait for the async dispatch to complete
      await vi.waitFor(() => {
        expect(updateStatusSpy).toHaveBeenCalled();
      });

      const dispatchedIntent = updateStatusSpy.mock.calls[0]![0] as Intent & {
        payload: Record<string, unknown>;
      };
      expect(dispatchedIntent.type).toBe("agent:update-status");
      expect(dispatchedIntent.payload).toEqual({
        workspacePath: "/test/workspace",
        status: testStatus,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // activate
  // ---------------------------------------------------------------------------

  describe("activate", () => {
    it("calls setMcpConfig with mcpPort (OpenCode)", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation(
        "app:start",
        new MinimalStartAndActivateOperation({ mcpPort: 5555 })
      );

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("calls setMcpConfig with mcpPort (Claude)", async () => {
      const { mockSM } = setupAgentMocks("claude");
      const { deps, dispatcher } = createTestSetup();
      (deps.configService.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent: "claude",
      });
      dispatcher.registerOperation(
        "app:start",
        new MinimalStartAndActivateOperation({ mcpPort: 5555 })
      );

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("skips setMcpConfig when mcpPort is null", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation(
        "app:start",
        new MinimalStartAndActivateOperation({ mcpPort: null })
      );

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // workspace setup
  // ---------------------------------------------------------------------------

  describe("workspace setup", () => {
    it("starts server, waits for provider, and returns envVars", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run workspace setup
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as SetupHookResult;

      expect(mockSM.startServer).toHaveBeenCalledWith("/test/project/.worktrees/feature-1");
      expect(result.envVars).toBeDefined();
      expect(result.envVars!.OPENCODE_PORT).toBe("8080");
    });

    it("sets initial prompt when provided", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run workspace setup
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
          initialPrompt: "Hello world",
        },
      } as OpenWorkspaceIntent);

      expect(mockSM.setInitialPrompt).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        expect.objectContaining({ prompt: "Hello world" })
      );
    });

    it("adds bridge port for OpenCode", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run workspace setup
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as SetupHookResult;

      expect(result.envVars!.CODEHYDRA_BRIDGE_PORT).toBe("9999");
      expect(mockSM.getBridgePort).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // delete shutdown
  // ---------------------------------------------------------------------------

  describe("delete shutdown", () => {
    it("stops server and clears TUI tracking", async () => {
      const { mockSM, mockASM } = setupAgentMocks("opencode");
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult;

      expect(mockSM.stopServer).toHaveBeenCalledWith("/test/project/.worktrees/feature-1");
      expect(mockASM.clearTuiTracking).toHaveBeenCalled();
      expect(result.serverName).toBeDefined();
    });

    it("continues on error in force mode", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      mockSM.stopServer = vi.fn().mockResolvedValue({ success: false, error: "server crash" });
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult;

      // Force mode returns error string instead of throwing
      expect(result.error).toBe("server crash");
    });

    it("throws on stop failure in non-force mode", async () => {
      const { mockSM } = setupAgentMocks("opencode");
      mockSM.stopServer = vi.fn().mockResolvedValue({ success: false, error: "server crash" });
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      await expect(
        dispatcher.dispatch({
          type: "workspace:delete",
          payload: {
            projectId: "test-12345678" as ProjectId,
            workspaceName: "feature-1" as WorkspaceName,
            workspacePath: "/test/project/.worktrees/feature-1",
            projectPath: "/test/project",
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        } as DeleteWorkspaceIntent)
      ).rejects.toThrow("server crash");
    });

    it("calls killTerminalsCallback (best-effort)", async () => {
      setupAgentMocks("opencode");
      const { deps, dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(deps.killTerminalsCallback).toHaveBeenCalledWith("/test/project/.worktrees/feature-1");
    });
  });

  // ---------------------------------------------------------------------------
  // get workspace status
  // ---------------------------------------------------------------------------

  describe("get workspace status", () => {
    it("returns agent status from agentStatusManager", async () => {
      const { mockASM } = setupAgentMocks();
      const expectedStatus: AggregatedAgentStatus = {
        status: "busy",
        counts: { idle: 0, busy: 2 },
      };
      mockASM.getStatus.mockReturnValue(expectedStatus);
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run get-status
      dispatcher.registerOperation(
        "workspace:get-status",
        new MinimalGetStatusOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:get-status",
        payload: {},
      })) as GetStatusHookResult;

      expect(result.agentStatus).toEqual(expectedStatus);
    });
  });

  // ---------------------------------------------------------------------------
  // get agent session
  // ---------------------------------------------------------------------------

  describe("get agent session", () => {
    it("returns session from agentStatusManager", async () => {
      const { mockASM } = setupAgentMocks();
      mockASM.getSession.mockReturnValue({ port: 8080, sessionId: "sess-1" });
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run get-session
      dispatcher.registerOperation(
        "agent:get-session",
        new MinimalGetSessionOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: {},
      })) as GetAgentSessionHookResult;

      expect(result.session).toEqual({ port: 8080, sessionId: "sess-1" });
    });

    it("returns null when no session exists", async () => {
      const { mockASM } = setupAgentMocks();
      mockASM.getSession.mockReturnValue(null);
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run get-session
      dispatcher.registerOperation(
        "agent:get-session",
        new MinimalGetSessionOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: {},
      })) as GetAgentSessionHookResult;

      expect(result.session).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // restart agent
  // ---------------------------------------------------------------------------

  describe("restart agent", () => {
    it("restarts server and returns port", async () => {
      const { mockSM } = setupAgentMocks();
      mockSM.restartServer = vi.fn().mockResolvedValue({ success: true, port: 9090 });
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run restart
      dispatcher.registerOperation(
        "agent:restart",
        new MinimalRestartOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "agent:restart",
        payload: {},
      })) as RestartAgentHookResult;

      expect(result.port).toBe(9090);
    });

    it("throws on restart failure", async () => {
      const { mockSM } = setupAgentMocks();
      mockSM.restartServer = vi.fn().mockResolvedValue({
        success: false,
        error: "restart failed",
        serverStopped: false,
      });
      const { dispatcher } = createTestSetup();

      // Run start to populate closure state
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run restart
      dispatcher.registerOperation(
        "agent:restart",
        new MinimalRestartOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
        })
      );

      await expect(dispatcher.dispatch({ type: "agent:restart", payload: {} })).rejects.toThrow(
        "restart failed"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // stop (app:shutdown)
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("disposes serverManager and agentStatusManager", async () => {
      const { mockSM, mockASM } = setupAgentMocks();
      const { dispatcher } = createTestSetup();

      // First run start to create agent services and wire callbacks
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());
      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockSM.dispose).toHaveBeenCalled();
      expect(mockASM.dispose).toHaveBeenCalled();
    });

    it("handles shutdown errors gracefully (non-fatal)", async () => {
      const { mockSM } = setupAgentMocks();
      mockSM.dispose = vi.fn().mockRejectedValue(new Error("dispose failed"));
      const { dispatcher } = createTestSetup();

      // First run start to create agent services
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      // Should not throw - shutdown errors are non-fatal
      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });
});
