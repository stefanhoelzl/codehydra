// @vitest-environment node
/**
 * Integration tests for ClaudeAgentModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type {
  CheckConfigResult,
  ConfigureResult,
  CheckDepsResult,
  StartHookResult,
  ActivateHookResult,
  ActivateHookContext,
  CheckDepsHookContext,
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type { RegisterAgentResult, SaveAgentHookInput, BinaryHookInput } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type {
  SetupHookResult,
  SetupHookInput,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  ShutdownHookResult,
  DeletePipelineHookInput,
  DeleteWorkspaceIntent,
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
import { createClaudeAgentModule, type ClaudeAgentModuleDeps } from "./claude-agent-module";
import { SILENT_LOGGER } from "../../services/logging";
import { SetupError } from "../../services/errors";

// =============================================================================
// Minimal Test Operations
// =============================================================================

class MinimalCheckConfigOperation implements Operation<Intent, readonly CheckConfigResult[]> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<readonly CheckConfigResult[]> {
    const { results, errors } = await ctx.hooks.collect<CheckConfigResult>("check-config", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

class MinimalConfigureOperation implements Operation<Intent, readonly ConfigureResult[]> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<readonly ConfigureResult[]> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("configure", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

class MinimalCheckDepsOperation implements Operation<Intent, CheckDepsResult> {
  readonly id = APP_START_OPERATION_ID;
  private readonly configuredAgent: string | null;

  constructor(configuredAgent: string | null = "claude") {
    this.configuredAgent = configuredAgent;
  }

  async execute(ctx: OperationContext<Intent>): Promise<CheckDepsResult> {
    const hookCtx: CheckDepsHookContext = {
      intent: ctx.intent,
      configuredAgent: this.configuredAgent as CheckDepsHookContext["configuredAgent"],
    };
    const { results } = await ctx.hooks.collect<CheckDepsResult>("check-deps", hookCtx);
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
    const merged: StartHookResult = {};
    for (const r of results) {
      if (r.codeServerPort !== undefined) {
        (merged as Record<string, unknown>).codeServerPort = r.codeServerPort;
      }
    }
    return merged;
  }
}

class MinimalStartAndActivateOperation implements Operation<Intent, readonly ActivateHookResult[]> {
  readonly id = APP_START_OPERATION_ID;
  private readonly mcpPort: number | null;

  constructor(mcpPort: number | null = null) {
    this.mcpPort = mcpPort;
  }

  async execute(ctx: OperationContext<Intent>): Promise<readonly ActivateHookResult[]> {
    // Run start first to set the active flag
    const { errors: startErrors } = await ctx.hooks.collect<StartHookResult>("start", {
      intent: ctx.intent,
    });
    if (startErrors.length > 0) throw startErrors[0]!;

    // Then run activate
    const activateCtx: ActivateHookContext = {
      intent: ctx.intent,
      mcpPort: this.mcpPort,
      codeServerPort: null,
    };
    const { results, errors } = await ctx.hooks.collect<ActivateHookResult>(
      "activate",
      activateCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

class MinimalStopOperation implements Operation<Intent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("stop", { intent: ctx.intent });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalRegisterAgentsOperation implements Operation<Intent, readonly RegisterAgentResult[]> {
  readonly id = SETUP_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<readonly RegisterAgentResult[]> {
    const { results, errors } = await ctx.hooks.collect<RegisterAgentResult>("register-agents", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

class MinimalSaveAgentOperation implements Operation<Intent, void> {
  readonly id = SETUP_OPERATION_ID;
  private readonly selectedAgent: string;

  constructor(selectedAgent: string) {
    this.selectedAgent = selectedAgent;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const hookCtx: SaveAgentHookInput = {
      intent: ctx.intent,
      selectedAgent: this.selectedAgent as SaveAgentHookInput["selectedAgent"],
    };
    const { errors } = await ctx.hooks.collect("save-agent", hookCtx);
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalBinaryOperation implements Operation<Intent, void> {
  readonly id = SETUP_OPERATION_ID;
  private readonly hookInput: Partial<BinaryHookInput>;
  readonly report: ReturnType<typeof vi.fn>;

  constructor(hookInput: Partial<BinaryHookInput> = {}) {
    this.report = (hookInput.report as ReturnType<typeof vi.fn>) ?? vi.fn();
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("binary", {
      intent: ctx.intent,
      report: this.report,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalSetupOperation implements Operation<OpenWorkspaceIntent, SetupHookResult | undefined> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<SetupHookInput>;

  constructor(hookInput: Partial<SetupHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<SetupHookResult | undefined> {
    const { results, errors } = await ctx.hooks.collect<SetupHookResult | undefined>("setup", {
      intent: ctx.intent,
      workspacePath: "/test/workspace",
      projectPath: "/test/project",
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalShutdownOperation implements Operation<
  DeleteWorkspaceIntent,
  ShutdownHookResult | undefined
> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(
    ctx: OperationContext<DeleteWorkspaceIntent>
  ): Promise<ShutdownHookResult | undefined> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/test/project",
      workspacePath: payload.workspacePath ?? "/test/workspace",
    };
    const { results, errors } = await ctx.hooks.collect<ShutdownHookResult | undefined>(
      "shutdown",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalGetStatusOperation implements Operation<Intent, GetStatusHookResult | undefined> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<GetStatusHookResult | undefined> {
    const hookCtx: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath: "/test/workspace",
    };
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult | undefined>(
      "get",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalGetSessionOperation implements Operation<
  Intent,
  GetAgentSessionHookResult | undefined
> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<GetAgentSessionHookResult | undefined> {
    const hookCtx: GetAgentSessionHookInput = {
      intent: ctx.intent,
      workspacePath: "/test/workspace",
    };
    const { results, errors } = await ctx.hooks.collect<GetAgentSessionHookResult | undefined>(
      "get",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalRestartOperation implements Operation<Intent, RestartAgentHookResult | undefined> {
  readonly id = RESTART_AGENT_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<RestartAgentHookResult | undefined> {
    const hookCtx: RestartAgentHookInput = {
      intent: ctx.intent,
      workspacePath: "/test/workspace",
    };
    const { results, errors } = await ctx.hooks.collect<RestartAgentHookResult | undefined>(
      "restart",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

// =============================================================================
// Mock Factories
// =============================================================================

function createMockClaudeServerManager() {
  return {
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
    setMcpConfig: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn().mockReturnValue(vi.fn()),
    getSessionId: vi.fn().mockReturnValue("session-1"),
    getMcpConfig: vi.fn().mockReturnValue(null),
    getHooksConfigPath: vi.fn().mockReturnValue({ toNative: () => "/hooks.json" }),
    getMcpConfigPath: vi.fn().mockReturnValue({ toNative: () => "/mcp.json" }),
    getInitialPromptPath: vi.fn().mockReturnValue(undefined),
  };
}

function createMockAgentStatusManager() {
  return {
    onStatusChanged: vi.fn().mockReturnValue(vi.fn()),
    getStatus: vi.fn().mockReturnValue({ status: "idle", counts: { idle: 1, busy: 0 } }),
    getSession: vi.fn().mockReturnValue({ port: 8080, sessionId: "session-1" }),
    getProvider: vi.fn().mockReturnValue({
      getEnvironmentVariables: vi.fn().mockReturnValue({ CLAUDE_PORT: "8080" }),
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

function createMockDeps(
  overrides?: Partial<{
    configAgent: string | null;
    serverManager: ReturnType<typeof createMockClaudeServerManager>;
    agentStatusManager: ReturnType<typeof createMockAgentStatusManager>;
  }>
): {
  deps: ClaudeAgentModuleDeps;
  mockSM: ReturnType<typeof createMockClaudeServerManager>;
  mockASM: ReturnType<typeof createMockAgentStatusManager>;
} {
  const mockSM = overrides?.serverManager ?? createMockClaudeServerManager();
  const mockASM = overrides?.agentStatusManager ?? createMockAgentStatusManager();
  const configAgent = overrides && "configAgent" in overrides ? overrides.configAgent : "claude";

  const deps: ClaudeAgentModuleDeps = {
    configService: {
      load: vi.fn().mockResolvedValue({ agent: configAgent }),
      setAgent: vi.fn().mockResolvedValue(undefined),
    },
    agentBinaryManager: {
      preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
      downloadBinary: vi.fn().mockResolvedValue(undefined),
      getBinaryType: vi.fn().mockReturnValue("claude"),
    } as unknown as ClaudeAgentModuleDeps["agentBinaryManager"],
    serverManager: mockSM as unknown as ClaudeAgentModuleDeps["serverManager"],
    agentStatusManager: mockASM as unknown as ClaudeAgentModuleDeps["agentStatusManager"],
    dispatcher: new Dispatcher(new HookRegistry()),
    logger: SILENT_LOGGER,
    loggingService: {
      createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    } as unknown as ClaudeAgentModuleDeps["loggingService"],
  };

  return { deps, mockSM, mockASM };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDepsResult?: ReturnType<typeof createMockDeps>) {
  const { deps, mockSM, mockASM } = mockDepsResult ?? createMockDeps();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const module = createClaudeAgentModule(deps);

  dispatcher.registerModule(module);

  return { deps, dispatcher, hookRegistry, mockSM, mockASM };
}

/**
 * Helper: run a start operation to activate the module before testing hooks
 * that require lifecycle state.
 */
async function activateModule(dispatcher: Dispatcher): Promise<void> {
  dispatcher.registerOperation("app:start", new MinimalStartOperation());
  await dispatcher.dispatch({ type: "app:start", payload: {} });
}

// =============================================================================
// Tests
// =============================================================================

describe("ClaudeAgentModule", () => {
  // ---------------------------------------------------------------------------
  // check-config
  // ---------------------------------------------------------------------------

  describe("check-config", () => {
    it("loads config and returns configuredAgent", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalCheckConfigOperation());

      const results = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly CheckConfigResult[];

      expect(results).toHaveLength(1);
      expect(results[0]!.configuredAgent).toBe("claude");
    });

    it("returns null when no agent configured", async () => {
      const { dispatcher } = createTestSetup(createMockDeps({ configAgent: null }));
      dispatcher.registerOperation("app:start", new MinimalCheckConfigOperation());

      const results = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly CheckConfigResult[];

      expect(results[0]!.configuredAgent).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  describe("configure", () => {
    it("returns Claude-specific scripts", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalConfigureOperation());

      const results = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly ConfigureResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        scripts: ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "claude-code-hook-handler.cjs"],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // check-deps
  // ---------------------------------------------------------------------------

  describe("check-deps", () => {
    it("returns missingBinaries when configuredAgent is claude and download needed", async () => {
      const mockDepsResult = createMockDeps();
      (
        mockDepsResult.deps.agentBinaryManager.preflight as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        needsDownload: true,
      });
      const { dispatcher } = createTestSetup(mockDepsResult);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("claude"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("claude");
    });

    it("returns empty when configuredAgent is not claude", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("opencode"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).toHaveLength(0);
    });

    it("returns empty missingBinaries when download not needed", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("claude"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("activates when agent is claude", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      // Verify wiring: setMarkActiveHandler and onServerStarted/onServerStopped called
      expect(mockSM.setMarkActiveHandler).toHaveBeenCalled();
      expect(mockSM.onServerStarted).toHaveBeenCalled();
      expect(mockSM.onServerStopped).toHaveBeenCalled();
      expect(mockASM.onStatusChanged).toHaveBeenCalled();
    });

    it("does not activate when agent is opencode", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup(
        createMockDeps({ configAgent: "opencode" })
      );
      await activateModule(dispatcher);

      expect(mockSM.setMarkActiveHandler).not.toHaveBeenCalled();
      expect(mockSM.onServerStarted).not.toHaveBeenCalled();
      expect(mockSM.onServerStopped).not.toHaveBeenCalled();
      expect(mockASM.onStatusChanged).not.toHaveBeenCalled();
    });

    it("wires server callbacks that handle server started", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      // Capture the onServerStarted callback
      const startedCallback = mockSM.onServerStarted.mock.calls[0]![0] as (
        workspacePath: string,
        port: number
      ) => void;

      // Trigger the callback
      startedCallback("/test/workspace", 8080);

      // Wait for the async handleServerStarted to complete
      await vi.waitFor(() => {
        expect(mockASM.addProvider).toHaveBeenCalled();
      });
    });

    it("wires server callbacks that handle server stopped (non-restart)", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      // Capture the onServerStopped callback
      const stoppedCallback = mockSM.onServerStopped.mock.calls[0]![0] as (
        workspacePath: string,
        isRestart: boolean
      ) => void;

      stoppedCallback("/test/workspace", false);

      expect(mockASM.removeWorkspace).toHaveBeenCalledWith("/test/workspace");
    });

    it("wires server callbacks that handle server stopped (restart)", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      const stoppedCallback = mockSM.onServerStopped.mock.calls[0]![0] as (
        workspacePath: string,
        isRestart: boolean
      ) => void;

      stoppedCallback("/test/workspace", true);

      expect(mockASM.disconnectWorkspace).toHaveBeenCalledWith("/test/workspace");
    });

    it("reconnects provider on server restart when provider already exists", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockASM.hasProvider.mockReturnValue(true);
      const { dispatcher, mockSM, mockASM } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      // Capture the onServerStarted callback
      const startedCallback = mockSM.onServerStarted.mock.calls[0]![0] as (
        workspacePath: string,
        port: number
      ) => void;

      startedCallback("/test/workspace", 8080);

      await vi.waitFor(() => {
        expect(mockASM.reconnectWorkspace).toHaveBeenCalledWith("/test/workspace");
      });

      // Should not create a new provider
      expect(mockASM.addProvider).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // activate
  // ---------------------------------------------------------------------------

  describe("activate", () => {
    it("calls setMcpConfig when active and mcpPort provided", async () => {
      const { dispatcher, mockSM } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartAndActivateOperation(9999));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).toHaveBeenCalledWith({ port: 9999 });
    });

    it("skips setMcpConfig when mcpPort is null", async () => {
      const { dispatcher, mockSM } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartAndActivateOperation(null));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockSM.setMcpConfig).not.toHaveBeenCalled();
    });

    it("returns empty result when inactive", async () => {
      const { dispatcher, mockSM } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      dispatcher.registerOperation("app:start", new MinimalStartAndActivateOperation(9999));

      const results = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly ActivateHookResult[];

      expect(mockSM.setMcpConfig).not.toHaveBeenCalled();
      expect(results[0]).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // register-agents
  // ---------------------------------------------------------------------------

  describe("register-agents", () => {
    it("returns claude agent info", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("setup", new MinimalRegisterAgentsOperation());

      const results = (await dispatcher.dispatch({
        type: "setup",
        payload: {},
      })) as readonly RegisterAgentResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        agent: "claude",
        label: "Claude Code",
        icon: "sparkle",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // save-agent
  // ---------------------------------------------------------------------------

  describe("save-agent", () => {
    it("persists when selectedAgent is claude", async () => {
      const { dispatcher, deps } = createTestSetup();
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("claude"));

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.configService.setAgent).toHaveBeenCalledWith("claude");
    });

    it("skips when selectedAgent is not claude", async () => {
      const { dispatcher, deps } = createTestSetup();
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("opencode"));

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.configService.setAgent).not.toHaveBeenCalled();
    });

    it("throws SetupError on config save failure", async () => {
      const mockDepsResult = createMockDeps();
      (mockDepsResult.deps.configService.setAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("disk full")
      );
      const { dispatcher } = createTestSetup(mockDepsResult);
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("claude"));

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    it("downloads when agent type is claude and binary is missing", async () => {
      const mockDepsResult = createMockDeps();
      const { dispatcher, deps } = createTestSetup(mockDepsResult);
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.agentBinaryManager.downloadBinary).toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("reports done when agent is claude but binary not missing", async () => {
      const { dispatcher, deps } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: [],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.agentBinaryManager.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("skips download and report when agent is not claude", async () => {
      const { dispatcher, deps } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "opencode",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.agentBinaryManager.downloadBinary).not.toHaveBeenCalled();
      // When agent is not claude, the handler returns early without calling report
      expect(op.report).not.toHaveBeenCalled();
    });

    it("reports progress during download", async () => {
      const mockDepsResult = createMockDeps();
      (
        mockDepsResult.deps.agentBinaryManager.downloadBinary as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async (cb: (p: { phase: string; bytesDownloaded: number; totalBytes: number }) => void) => {
          cb({ phase: "downloading", bytesDownloaded: 50, totalBytes: 100 });
          cb({ phase: "extracting", bytesDownloaded: 100, totalBytes: 100 });
        }
      );
      const { dispatcher } = createTestSetup(mockDepsResult);
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(op.report).toHaveBeenCalledWith("agent", "running", "Downloading...", undefined, 50);
      expect(op.report).toHaveBeenCalledWith("agent", "running", "Extracting...");
    });

    it("throws SetupError on download failure", async () => {
      const mockDepsResult = createMockDeps();
      (
        mockDepsResult.deps.agentBinaryManager.downloadBinary as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("network error"));
      const { dispatcher } = createTestSetup(mockDepsResult);
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith("agent", "failed", undefined, "network error");
    });

    it("uses configuredAgent when selectedAgent not provided", async () => {
      const mockDepsResult = createMockDeps();
      const { dispatcher, deps } = createTestSetup(mockDepsResult);
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.agentBinaryManager.downloadBinary).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // workspace setup
  // ---------------------------------------------------------------------------

  describe("workspace setup", () => {
    it("starts server and returns envVars when active", async () => {
      const { dispatcher, mockSM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
        },
      } as unknown as OpenWorkspaceIntent)) as SetupHookResult | undefined;

      expect(mockSM.startServer).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.agentType).toBe("claude");
      expect(result!.envVars).toEqual({ CLAUDE_PORT: "8080" });
    });

    it("sets initial prompt when provided in intent", async () => {
      const { dispatcher, mockSM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
          initialPrompt: "Hello Claude",
        },
      } as unknown as OpenWorkspaceIntent);

      expect(mockSM.setInitialPrompt).toHaveBeenCalled();
    });

    it("returns undefined when inactive", async () => {
      const { dispatcher, mockSM } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      await activateModule(dispatcher);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
        },
      } as unknown as OpenWorkspaceIntent)) as SetupHookResult | undefined;

      expect(result).toBeUndefined();
      expect(mockSM.startServer).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // delete / shutdown
  // ---------------------------------------------------------------------------

  describe("delete shutdown", () => {
    it("stops server when active", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/workspace",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(mockSM.stopServer).toHaveBeenCalledWith("/test/workspace");
      expect(mockASM.clearTuiTracking).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.serverName).toBe("Claude Code hook");
    });

    it("returns error in result when stop fails", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockSM.stopServer.mockResolvedValue({
        success: false,
        error: "server busy",
      });
      const { dispatcher } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      // With force=true, errors are captured but not thrown
      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/workspace",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.error).toBe("server busy");
    });

    it("throws when stop fails and not force mode", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockSM.stopServer.mockResolvedValue({
        success: false,
        error: "server busy",
      });
      const { dispatcher } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      await expect(
        dispatcher.dispatch({
          type: "workspace:delete",
          payload: {
            workspacePath: "/test/workspace",
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        } as DeleteWorkspaceIntent)
      ).rejects.toThrow("server busy");
    });

    it("returns undefined when inactive", async () => {
      const { dispatcher, mockSM } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/workspace",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(result).toBeUndefined();
      expect(mockSM.stopServer).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // get-status
  // ---------------------------------------------------------------------------

  describe("get-status", () => {
    it("returns status when active", async () => {
      const { dispatcher, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:get-status", new MinimalGetStatusOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:get-status",
        payload: { workspacePath: "/test/workspace" },
      })) as GetStatusHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.agentStatus).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
      expect(mockASM.getStatus).toHaveBeenCalledWith("/test/workspace");
    });

    it("returns undefined when inactive", async () => {
      const { dispatcher } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      await activateModule(dispatcher);

      dispatcher.registerOperation("workspace:get-status", new MinimalGetStatusOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:get-status",
        payload: { workspacePath: "/test/workspace" },
      })) as GetStatusHookResult | undefined;

      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // get-session
  // ---------------------------------------------------------------------------

  describe("get-session", () => {
    it("returns session when active", async () => {
      const { dispatcher, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:get-session", new MinimalGetSessionOperation());

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/workspace" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.session).toEqual({ port: 8080, sessionId: "session-1" });
      expect(mockASM.getSession).toHaveBeenCalledWith("/test/workspace");
    });

    it("returns null session when no session exists", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockASM.getSession.mockReturnValue(null);
      const { dispatcher } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:get-session", new MinimalGetSessionOperation());

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/workspace" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.session).toBeNull();
    });

    it("returns undefined when inactive", async () => {
      const { dispatcher } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:get-session", new MinimalGetSessionOperation());

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/workspace" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // restart
  // ---------------------------------------------------------------------------

  describe("restart", () => {
    it("restarts server when active and returns port", async () => {
      const { dispatcher, mockSM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:restart", new MinimalRestartOperation());

      const result = (await dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: "/test/workspace" },
      })) as RestartAgentHookResult | undefined;

      expect(mockSM.restartServer).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.port).toBe(8081);
    });

    it("throws when restart fails", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockSM.restartServer.mockResolvedValue({
        success: false,
        error: "restart failed",
      });
      const { dispatcher } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:restart", new MinimalRestartOperation());

      await expect(
        dispatcher.dispatch({
          type: "agent:restart",
          payload: { workspacePath: "/test/workspace" },
        })
      ).rejects.toThrow("restart failed");
    });

    it("returns undefined when inactive", async () => {
      const { dispatcher, mockSM } = createTestSetup(createMockDeps({ configAgent: "opencode" }));
      await activateModule(dispatcher);

      dispatcher.registerOperation("agent:restart", new MinimalRestartOperation());

      const result = (await dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: "/test/workspace" },
      })) as RestartAgentHookResult | undefined;

      expect(result).toBeUndefined();
      expect(mockSM.restartServer).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // stop (app:shutdown)
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("disposes server manager and agent status manager when active", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup();
      await activateModule(dispatcher);

      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockSM.dispose).toHaveBeenCalled();
      expect(mockASM.dispose).toHaveBeenCalled();
    });

    it("disposes server manager but not agent status manager when inactive", async () => {
      const { dispatcher, mockSM, mockASM } = createTestSetup(
        createMockDeps({ configAgent: "opencode" })
      );
      await activateModule(dispatcher);

      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockSM.dispose).toHaveBeenCalled();
      expect(mockASM.dispose).not.toHaveBeenCalled();
    });

    it("handles non-fatal stop errors", async () => {
      const mockDepsResult = createMockDeps();
      mockDepsResult.mockSM.dispose.mockRejectedValue(new Error("dispose failed"));
      const { dispatcher } = createTestSetup(mockDepsResult);
      await activateModule(dispatcher);

      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      // Should not throw - errors are caught internally
      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });
});
