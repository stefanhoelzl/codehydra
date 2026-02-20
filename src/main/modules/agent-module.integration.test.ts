// @vitest-environment node
/**
 * Integration tests for AgentModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 *
 * The agent module receives pre-created AgentServerManagers and AgentStatusManager
 * via deps. We mock `createAgentProvider` from `../../agents` so the start hook
 * uses our mock provider. Tests that need lifecycle state (activate, stop,
 * workspace setup/shutdown,
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
  ConfigureResult,
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
import { createAgentProvider } from "../../agents";
import type { AgentStatusManager } from "../../agents";
import type { AgentServerManager } from "../../agents/types";

// =============================================================================
// Mock createAgentProvider so the start hook uses our mock provider
// =============================================================================

vi.mock("../../agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../agents")>();
  return {
    ...original,
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

class MinimalConfigureOperation implements Operation<Intent, ConfigureResult> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<ConfigureResult> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("configure", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    // Merge scripts from all results
    const scripts: string[] = [];
    for (const r of results) {
      if (r.scripts) scripts.push(...r.scripts);
    }
    return scripts.length > 0 ? { scripts } : {};
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
      projectPath: "/projects/test",
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
 * Configure the vi.mock'd factories for agent provider creation.
 * Must be called before dispatching any operation that triggers server callbacks.
 */
function setupProviderMock() {
  vi.mocked(createAgentProvider).mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
    fetchStatus: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ ok: true, value: { id: "sess-1" } }),
    sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
    getEnvironmentVariables: vi.fn().mockReturnValue({ OPENCODE_PORT: "8080" }),
  } as never);
}

/**
 * Return references to the mock server manager (for the given agent type) and
 * the mock status manager from deps. Must be called after createTestSetup.
 */
function getMocksFromDeps(deps: AgentModuleDeps, agentType: "opencode" | "claude" = "opencode") {
  return {
    mockSM: deps.agentServerManagers[agentType] as AgentServerManager &
      Record<string, ReturnType<typeof vi.fn>>,
    mockASM: deps.agentStatusManager as unknown as ReturnType<typeof createMockAgentStatusManager>,
  };
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
    logger: SILENT_LOGGER,
    loggingService: {
      createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    } as unknown as LoggingService,
    dispatcher,
    killTerminalsCallback: vi.fn().mockResolvedValue(undefined),
    agentServerManagers: {
      claude: createMockServerManager("claude") as unknown as AgentServerManager,
      opencode: createMockServerManager("opencode") as unknown as AgentServerManager,
    },
    agentStatusManager: createMockAgentStatusManager() as unknown as AgentStatusManager,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(overrides?: Partial<AgentModuleDeps>) {
  const deps = { ...createMockDeps(), ...overrides };
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
  // configure
  // ---------------------------------------------------------------------------

  describe("configure", () => {
    it("declares all agent script files statically", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalConfigureOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as ConfigureResult;

      expect(result.scripts).toEqual([
        "ch-claude",
        "ch-claude.cjs",
        "ch-claude.cmd",
        "ch-opencode",
        "ch-opencode.cjs",
        "ch-opencode.cmd",
        "claude-code-hook-handler.cjs",
      ]);
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
      const reportMock = vi.fn();
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
          report: reportMock,
        })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockBinaryManager.downloadBinary).toHaveBeenCalled();
      expect(reportMock).toHaveBeenCalledWith("agent", "done");
    });

    it("skips download when binary is not missing", async () => {
      const reportMock = vi.fn();
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
          report: reportMock,
        })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockBinaryManager.downloadBinary).not.toHaveBeenCalled();
      expect(reportMock).toHaveBeenCalledWith("agent", "done");
    });

    it("reports progress during download and handles error", async () => {
      const reportMock = vi.fn();
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
          report: reportMock,
        })
      );

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(reportMock).toHaveBeenCalledWith("agent", "failed", undefined, "network error");
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("wires status changes to dispatcher via onStatusChanged", async () => {
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM, mockASM } = getMocksFromDeps(deps, "opencode");
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Verify onStatusChanged was subscribed
      expect(mockASM.onStatusChanged).toHaveBeenCalledWith(expect.any(Function));

      // Verify server callbacks were wired
      expect(mockSM.onServerStarted).toHaveBeenCalledWith(expect.any(Function));
      expect(mockSM.onServerStopped).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for opencode", async () => {
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMarkActiveHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for claude", async () => {
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "claude");
      (deps.configService.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent: "claude",
      });
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMarkActiveHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it("dispatches agent:update-status when status changes", async () => {
      setupProviderMock();

      // Create a custom mock ASM that captures the status callback
      let statusCallback: ((path: WorkspacePath, status: AggregatedAgentStatus) => void) | null =
        null;
      const customMockASM = createMockAgentStatusManager();
      customMockASM.onStatusChanged.mockImplementation(
        (cb: (path: WorkspacePath, status: AggregatedAgentStatus) => void) => {
          statusCallback = cb;
          return vi.fn();
        }
      );

      // Build a shared hookRegistry + dispatcher so the module's internal
      // deps.dispatcher is the SAME instance used by wireModules / test.
      const hookRegistry = new HookRegistry();
      const sharedDispatcher = new Dispatcher(hookRegistry);

      const deps = {
        ...createMockDeps(),
        agentStatusManager: customMockASM as unknown as AgentStatusManager,
        dispatcher: sharedDispatcher,
      } satisfies AgentModuleDeps;
      const module = createAgentModule(deps);
      wireModules([module], hookRegistry, sharedDispatcher);

      sharedDispatcher.registerOperation("app:start", new MinimalStartOperation());

      // Register a mock operation for agent:update-status so dispatch succeeds
      const updateStatusSpy = vi.fn();
      sharedDispatcher.registerOperation("agent:update-status", {
        id: "update-agent-status",
        execute: async (ctx: OperationContext<Intent>) => {
          updateStatusSpy(ctx.intent);
        },
      });

      await sharedDispatcher.dispatch({ type: "app:start", payload: {} });

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");
      dispatcher.registerOperation(
        "app:start",
        new MinimalStartAndActivateOperation({ mcpPort: 5555 })
      );

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("calls setMcpConfig with mcpPort (Claude)", async () => {
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "claude");
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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");
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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");

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
      expect(result.agentType).toBe("opencode");
    });

    it("sets initial prompt when provided", async () => {
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM, mockASM } = getMocksFromDeps(deps, "opencode");

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");
      mockSM.stopServer = vi.fn().mockResolvedValue({ success: false, error: "server crash" });

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps, "opencode");
      mockSM.stopServer = vi.fn().mockResolvedValue({ success: false, error: "server crash" });

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
      setupProviderMock();
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
      setupProviderMock();
      const expectedStatus: AggregatedAgentStatus = {
        status: "busy",
        counts: { idle: 0, busy: 2 },
      };
      const { deps, dispatcher } = createTestSetup();
      const { mockASM } = getMocksFromDeps(deps);
      mockASM.getStatus.mockReturnValue(expectedStatus);

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockASM } = getMocksFromDeps(deps);
      mockASM.getSession.mockReturnValue({ port: 8080, sessionId: "sess-1" });

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockASM } = getMocksFromDeps(deps);
      mockASM.getSession.mockReturnValue(null);

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps);
      mockSM.restartServer = vi.fn().mockResolvedValue({ success: true, port: 9090 });

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps);
      mockSM.restartServer = vi.fn().mockResolvedValue({
        success: false,
        error: "restart failed",
        serverStopped: false,
      });

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM, mockASM } = getMocksFromDeps(deps);

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
      setupProviderMock();
      const { deps, dispatcher } = createTestSetup();
      const { mockSM } = getMocksFromDeps(deps);
      mockSM.dispose = vi.fn().mockRejectedValue(new Error("dispose failed"));

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
