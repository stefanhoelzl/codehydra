// @vitest-environment node
/**
 * Integration tests for OpenCodeAgentModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type {
  CheckConfigResult,
  CheckDepsResult,
  ConfigureResult,
  StartHookResult,
  ActivateHookResult,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type { RegisterAgentResult, BinaryHookInput, SaveAgentHookInput } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type {
  SetupHookResult,
  OpenWorkspaceIntent,
  SetupHookInput,
} from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "../operations/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import type { GetStatusHookResult, GetStatusHookInput } from "../operations/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../operations/get-agent-session";
import type {
  GetAgentSessionHookResult,
  GetAgentSessionHookInput,
} from "../operations/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../operations/restart-agent";
import type { RestartAgentHookResult, RestartAgentHookInput } from "../operations/restart-agent";
import { createOpenCodeAgentModule, type OpenCodeAgentModuleDeps } from "./opencode-agent-module";
import { SILENT_LOGGER } from "../../services/logging";

// =============================================================================
// Mock OpenCodeProvider
// =============================================================================

function createMockProvider() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    fetchStatus: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ ok: true, value: { id: "sess-1" } }),
    sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
    getEnvironmentVariables: vi.fn().mockReturnValue({ CODEHYDRA_OPENCODE_PORT: "8080" }),
    setBridgePort: vi.fn(),
    onStatusChange: vi.fn().mockReturnValue(vi.fn()),
    getSession: vi.fn().mockReturnValue({ port: 8080, sessionId: "sess-1" }),
    markActive: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

let mockProviderInstance = createMockProvider();

vi.mock("../../agents/opencode/provider", () => {
  return {
    OpenCodeProvider: class MockOpenCodeProvider {
      connect: ReturnType<typeof vi.fn>;
      fetchStatus: ReturnType<typeof vi.fn>;
      createSession: ReturnType<typeof vi.fn>;
      sendPrompt: ReturnType<typeof vi.fn>;
      getEnvironmentVariables: ReturnType<typeof vi.fn>;
      setBridgePort: ReturnType<typeof vi.fn>;
      onStatusChange: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
      markActive: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      reconnect: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;

      constructor() {
        this.connect = mockProviderInstance.connect;
        this.fetchStatus = mockProviderInstance.fetchStatus;
        this.createSession = mockProviderInstance.createSession;
        this.sendPrompt = mockProviderInstance.sendPrompt;
        this.getEnvironmentVariables = mockProviderInstance.getEnvironmentVariables;
        this.setBridgePort = mockProviderInstance.setBridgePort;
        this.onStatusChange = mockProviderInstance.onStatusChange;
        this.getSession = mockProviderInstance.getSession;
        this.markActive = mockProviderInstance.markActive;
        this.disconnect = mockProviderInstance.disconnect;
        this.reconnect = mockProviderInstance.reconnect;
        this.dispose = mockProviderInstance.dispose;
      }
    },
  };
});

// =============================================================================
// Mock Factories
// =============================================================================

function createMockOpenCodeServerManager() {
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
    setMcpConfig: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    getBridgePort: vi.fn().mockReturnValue(9999),
    setPendingPrompt: vi.fn(),
    consumePendingPrompt: vi.fn(),
    onWorkspaceReady: vi.fn().mockReturnValue(vi.fn()),
  };
}

function createMockAgentStatusManager() {
  return {
    onStatusChanged: vi.fn().mockReturnValue(vi.fn()),
    getStatus: vi.fn().mockReturnValue({ status: "idle", counts: { idle: 1, busy: 0 } }),
    getSession: vi.fn().mockReturnValue({ port: 8080, sessionId: "sess-1" }),
    getProvider: vi.fn().mockReturnValue({
      getEnvironmentVariables: () => ({ CODEHYDRA_OPENCODE_PORT: "8080" }),
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

function createMockConfigService(agent: string | null = null) {
  return {
    load: vi.fn().mockResolvedValue({ agent }),
    setAgent: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAgentBinaryManager() {
  return {
    preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
    getBinaryType: vi.fn().mockReturnValue("opencode"),
    downloadBinary: vi.fn().mockResolvedValue(undefined),
  };
}

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

  constructor(configuredAgent: string | null = "opencode") {
    this.configuredAgent = configuredAgent;
  }

  async execute(ctx: OperationContext<Intent>): Promise<CheckDepsResult> {
    const { results } = await ctx.hooks.collect<CheckDepsResult>("check-deps", {
      intent: ctx.intent,
      configuredAgent: this.configuredAgent,
    } as never);
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

class MinimalStartOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<StartHookResult>("start", {
      intent: ctx.intent,
    });
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
    const { errors } = await ctx.hooks.collect("save-agent", {
      intent: ctx.intent,
      selectedAgent: this.selectedAgent,
    } as SaveAgentHookInput);
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
  private readonly workspacePath: string;

  constructor(workspacePath = "/test/project/.worktrees/feature-1") {
    this.workspacePath = workspacePath;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<SetupHookResult | undefined> {
    const { results, errors } = await ctx.hooks.collect<SetupHookResult | undefined>("setup", {
      intent: ctx.intent,
      workspacePath: this.workspacePath,
      projectPath: "/test/project",
    } as SetupHookInput);
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
      projectPath: "/projects/test",
      workspacePath: payload.workspacePath ?? "",
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
  private readonly workspacePath: string;

  constructor(workspacePath = "/test/project/.worktrees/feature-1") {
    this.workspacePath = workspacePath;
  }

  async execute(ctx: OperationContext<Intent>): Promise<GetStatusHookResult | undefined> {
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult | undefined>("get", {
      intent: ctx.intent,
      workspacePath: this.workspacePath,
    } as GetStatusHookInput);
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalGetSessionOperation implements Operation<
  Intent,
  GetAgentSessionHookResult | undefined
> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;
  private readonly workspacePath: string;

  constructor(workspacePath = "/test/project/.worktrees/feature-1") {
    this.workspacePath = workspacePath;
  }

  async execute(ctx: OperationContext<Intent>): Promise<GetAgentSessionHookResult | undefined> {
    const { results, errors } = await ctx.hooks.collect<GetAgentSessionHookResult | undefined>(
      "get",
      {
        intent: ctx.intent,
        workspacePath: this.workspacePath,
      } as GetAgentSessionHookInput
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

class MinimalRestartOperation implements Operation<Intent, RestartAgentHookResult | undefined> {
  readonly id = RESTART_AGENT_OPERATION_ID;
  private readonly workspacePath: string;

  constructor(workspacePath = "/test/project/.worktrees/feature-1") {
    this.workspacePath = workspacePath;
  }

  async execute(ctx: OperationContext<Intent>): Promise<RestartAgentHookResult | undefined> {
    const { results, errors } = await ctx.hooks.collect<RestartAgentHookResult | undefined>(
      "restart",
      {
        intent: ctx.intent,
        workspacePath: this.workspacePath,
      } as RestartAgentHookInput
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  hookRegistry: HookRegistry;
  serverManager: ReturnType<typeof createMockOpenCodeServerManager>;
  agentStatusManager: ReturnType<typeof createMockAgentStatusManager>;
  configService: ReturnType<typeof createMockConfigService>;
  agentBinaryManager: ReturnType<typeof createMockAgentBinaryManager>;
  module: IntentModule;
}

function createTestSetup(overrides?: { agent?: string | null }): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const serverManager = createMockOpenCodeServerManager();
  const agentStatusManager = createMockAgentStatusManager();
  const configService = createMockConfigService(overrides?.agent ?? null);
  const agentBinaryManager = createMockAgentBinaryManager();

  const module = createOpenCodeAgentModule({
    configService: configService as unknown as OpenCodeAgentModuleDeps["configService"],
    agentBinaryManager:
      agentBinaryManager as unknown as OpenCodeAgentModuleDeps["agentBinaryManager"],
    serverManager: serverManager as unknown as OpenCodeAgentModuleDeps["serverManager"],
    agentStatusManager:
      agentStatusManager as unknown as OpenCodeAgentModuleDeps["agentStatusManager"],
    dispatcher: dispatcher as unknown as OpenCodeAgentModuleDeps["dispatcher"],
    logger: SILENT_LOGGER,
    loggingService: {
      createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    } as unknown as OpenCodeAgentModuleDeps["loggingService"],
  });

  dispatcher.registerModule(module);

  return {
    dispatcher,
    hookRegistry,
    serverManager,
    agentStatusManager,
    configService,
    agentBinaryManager,
    module,
  };
}

/**
 * Runs both "start" and "activate" hook points in sequence, simulating
 * what AppStartOperation does. This allows a single operation registration
 * that can exercise both hooks.
 */
class StartThenActivateOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  private readonly mcpPort: number | null;

  constructor(mcpPort: number | null = null) {
    this.mcpPort = mcpPort;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors: startErrors } = await ctx.hooks.collect<StartHookResult>("start", {
      intent: ctx.intent,
    });
    if (startErrors.length > 0) throw startErrors[0]!;

    const { errors: activateErrors } = await ctx.hooks.collect<ActivateHookResult>("activate", {
      intent: ctx.intent,
      mcpPort: this.mcpPort,
    } as never);
    if (activateErrors.length > 0) throw activateErrors[0]!;
  }
}

/**
 * Helper: run the start hook so the module becomes active.
 * The module defaults to active when config.agent is null or "opencode".
 */
async function activateModule(setup: TestSetup): Promise<void> {
  setup.dispatcher.registerOperation("app:start", new MinimalStartOperation());
  await setup.dispatcher.dispatch({ type: "app:start", payload: {} });
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenCodeAgentModule Integration", () => {
  beforeEach(() => {
    mockProviderInstance = createMockProvider();
  });

  // ---------------------------------------------------------------------------
  // check-config
  // ---------------------------------------------------------------------------

  describe("check-config", () => {
    it("loads config and returns configuredAgent", async () => {
      const setup = createTestSetup({ agent: "opencode" });
      setup.dispatcher.registerOperation("app:start", new MinimalCheckConfigOperation());

      const results = (await setup.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly CheckConfigResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ configuredAgent: "opencode" });
      expect(setup.configService.load).toHaveBeenCalled();
    });

    it("returns null configuredAgent when not configured", async () => {
      const setup = createTestSetup({ agent: null });
      setup.dispatcher.registerOperation("app:start", new MinimalCheckConfigOperation());

      const results = (await setup.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly CheckConfigResult[];

      expect(results[0]).toEqual({ configuredAgent: null });
    });
  });

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  describe("configure", () => {
    it("returns OpenCode-specific scripts", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:start", new MinimalConfigureOperation());

      const results = (await setup.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as readonly ConfigureResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        scripts: ["ch-opencode", "ch-opencode.cjs", "ch-opencode.cmd"],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // check-deps
  // ---------------------------------------------------------------------------

  describe("check-deps", () => {
    it("returns missingBinaries when configuredAgent is opencode and binary needs download", async () => {
      const setup = createTestSetup();
      (setup.agentBinaryManager.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        needsDownload: true,
      });
      setup.dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("opencode"));

      const result = (await setup.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("opencode");
    });

    it("returns empty result when configuredAgent is not opencode", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("claude"));

      const result = (await setup.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).toHaveLength(0);
    });

    it("returns empty result when binary is up to date", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("opencode"));

      const result = (await setup.dispatcher.dispatch({
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
    it("activates when agent is opencode (default, null config)", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      // Should wire server callbacks
      expect(setup.serverManager.setMarkActiveHandler).toHaveBeenCalled();
      expect(setup.serverManager.onServerStarted).toHaveBeenCalled();
      expect(setup.serverManager.onServerStopped).toHaveBeenCalled();

      // Should subscribe to status changes
      expect(setup.agentStatusManager.onStatusChanged).toHaveBeenCalled();
    });

    it("activates when agent is explicitly opencode", async () => {
      const setup = createTestSetup({ agent: "opencode" });
      await activateModule(setup);

      expect(setup.serverManager.setMarkActiveHandler).toHaveBeenCalled();
      expect(setup.serverManager.onServerStarted).toHaveBeenCalled();
      expect(setup.serverManager.onServerStopped).toHaveBeenCalled();
    });

    it("does not activate when agent is claude", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      expect(setup.serverManager.setMarkActiveHandler).not.toHaveBeenCalled();
      expect(setup.serverManager.onServerStarted).not.toHaveBeenCalled();
      expect(setup.serverManager.onServerStopped).not.toHaveBeenCalled();
      expect(setup.agentStatusManager.onStatusChanged).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // activate
  // ---------------------------------------------------------------------------

  describe("activate", () => {
    it("calls setMcpConfig when active and mcpPort provided", async () => {
      const setup = createTestSetup({ agent: null });
      setup.dispatcher.registerOperation("app:start", new StartThenActivateOperation(5555));

      await setup.dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(setup.serverManager.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("skips setMcpConfig when mcpPort is null", async () => {
      const setup = createTestSetup({ agent: null });
      setup.dispatcher.registerOperation("app:start", new StartThenActivateOperation(null));

      await setup.dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(setup.serverManager.setMcpConfig).not.toHaveBeenCalled();
    });

    it("skips setMcpConfig when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      setup.dispatcher.registerOperation("app:start", new StartThenActivateOperation(5555));

      await setup.dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(setup.serverManager.setMcpConfig).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // register-agents
  // ---------------------------------------------------------------------------

  describe("register-agents", () => {
    it("returns opencode agent info", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:setup", new MinimalRegisterAgentsOperation());

      const results = (await setup.dispatcher.dispatch({
        type: "app:setup",
        payload: {},
      })) as readonly RegisterAgentResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ agent: "opencode", label: "OpenCode", icon: "terminal" });
    });
  });

  // ---------------------------------------------------------------------------
  // save-agent
  // ---------------------------------------------------------------------------

  describe("save-agent", () => {
    it("persists when selectedAgent is opencode", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:setup", new MinimalSaveAgentOperation("opencode"));

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      expect(setup.configService.setAgent).toHaveBeenCalledWith("opencode");
    });

    it("skips when selectedAgent is not opencode", async () => {
      const setup = createTestSetup();
      setup.dispatcher.registerOperation("app:setup", new MinimalSaveAgentOperation("claude"));

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      expect(setup.configService.setAgent).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // binary
  // ---------------------------------------------------------------------------

  describe("binary", () => {
    it("downloads when agent type is opencode and binary is missing", async () => {
      const setup = createTestSetup();
      const op = new MinimalBinaryOperation({
        selectedAgent: "opencode",
        missingBinaries: ["opencode"],
      });
      setup.dispatcher.registerOperation("app:setup", op);

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      expect(setup.agentBinaryManager.downloadBinary).toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("skips download when agent type is not opencode", async () => {
      const setup = createTestSetup();
      const op = new MinimalBinaryOperation({
        selectedAgent: "claude",
        missingBinaries: ["opencode"],
      });
      setup.dispatcher.registerOperation("app:setup", op);

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      // Handler returns early without downloading or reporting
      expect(setup.agentBinaryManager.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).not.toHaveBeenCalled();
    });

    it("skips download when binary is not missing", async () => {
      const setup = createTestSetup();
      const op = new MinimalBinaryOperation({
        selectedAgent: "opencode",
        missingBinaries: [],
      });
      setup.dispatcher.registerOperation("app:setup", op);

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      expect(setup.agentBinaryManager.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("falls back to configuredAgent when selectedAgent is not set", async () => {
      const setup = createTestSetup();
      const op = new MinimalBinaryOperation({
        configuredAgent: "opencode",
        missingBinaries: ["opencode"],
      });
      setup.dispatcher.registerOperation("app:setup", op);

      await setup.dispatcher.dispatch({ type: "app:setup", payload: {} });

      expect(setup.agentBinaryManager.downloadBinary).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // workspace setup
  // ---------------------------------------------------------------------------

  describe("workspace setup", () => {
    it("starts server, waits for provider, and returns envVars when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const wsPath = "/test/project/.worktrees/feature-1";
      setup.dispatcher.registerOperation("workspace:open", new MinimalSetupOperation(wsPath));

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as SetupHookResult | undefined;

      expect(setup.serverManager.startServer).toHaveBeenCalledWith(wsPath);
      expect(result).toBeDefined();
      expect(result!.envVars).toEqual({ CODEHYDRA_OPENCODE_PORT: "8080" });
      expect(result!.agentType).toBe("opencode");
    });

    it("passes initial prompt to startServer when provided", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const wsPath = "/test/project/.worktrees/feature-1";
      setup.dispatcher.registerOperation("workspace:open", new MinimalSetupOperation(wsPath));

      await setup.dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
          initialPrompt: "Fix the bug",
        },
      } as OpenWorkspaceIntent);

      expect(setup.serverManager.startServer).toHaveBeenCalledWith(
        wsPath,
        expect.objectContaining({
          initialPrompt: expect.any(Object),
        })
      );
    });

    it("returns undefined when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      setup.dispatcher.registerOperation("workspace:open", new MinimalSetupOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as SetupHookResult | undefined;

      expect(result).toBeUndefined();
      expect(setup.serverManager.startServer).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // delete shutdown
  // ---------------------------------------------------------------------------

  describe("delete shutdown", () => {
    it("stops server when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      setup.dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const wsPath = "/test/project/.worktrees/feature-1";
      const result = (await setup.dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath,
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(setup.serverManager.stopServer).toHaveBeenCalledWith(wsPath);
      expect(setup.agentStatusManager.clearTuiTracking).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result!.serverName).toBe("OpenCode");
    });

    it("returns undefined when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      setup.dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/path",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(result).toBeUndefined();
      expect(setup.serverManager.stopServer).not.toHaveBeenCalled();
    });

    it("includes error when stopServer fails", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      (setup.serverManager.stopServer as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "process not found",
      });

      setup.dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/path",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as ShutdownHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.error).toBe("process not found");
    });
  });

  // ---------------------------------------------------------------------------
  // get-status
  // ---------------------------------------------------------------------------

  describe("get-status", () => {
    it("returns status when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const wsPath = "/test/project/.worktrees/feature-1";
      setup.dispatcher.registerOperation(
        "workspace:get-status",
        new MinimalGetStatusOperation(wsPath)
      );

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:get-status",
        payload: { workspacePath: wsPath },
      })) as GetStatusHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.agentStatus).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
    });

    it("returns undefined when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      setup.dispatcher.registerOperation("workspace:get-status", new MinimalGetStatusOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "workspace:get-status",
        payload: { workspacePath: "/test/path" },
      })) as GetStatusHookResult | undefined;

      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // get-session
  // ---------------------------------------------------------------------------

  describe("get-session", () => {
    it("returns session when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const wsPath = "/test/project/.worktrees/feature-1";
      setup.dispatcher.registerOperation(
        "agent:get-session",
        new MinimalGetSessionOperation(wsPath)
      );

      const result = (await setup.dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: wsPath },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.session).toEqual({ port: 8080, sessionId: "sess-1" });
    });

    it("returns undefined when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      setup.dispatcher.registerOperation("agent:get-session", new MinimalGetSessionOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/path" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // restart
  // ---------------------------------------------------------------------------

  describe("restart", () => {
    it("restarts server when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const wsPath = "/test/project/.worktrees/feature-1";
      setup.dispatcher.registerOperation("agent:restart", new MinimalRestartOperation(wsPath));

      const result = (await setup.dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: wsPath },
      })) as RestartAgentHookResult | undefined;

      expect(setup.serverManager.restartServer).toHaveBeenCalledWith(wsPath);
      expect(result).toBeDefined();
      expect(result!.port).toBe(8081);
    });

    it("returns undefined when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      setup.dispatcher.registerOperation("agent:restart", new MinimalRestartOperation());

      const result = (await setup.dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: "/test/path" },
      })) as RestartAgentHookResult | undefined;

      expect(result).toBeUndefined();
    });

    it("throws when restart fails", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      (setup.serverManager.restartServer as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "server not running",
      });

      setup.dispatcher.registerOperation("agent:restart", new MinimalRestartOperation());

      await expect(
        setup.dispatcher.dispatch({
          type: "agent:restart",
          payload: { workspacePath: "/test/path" },
        })
      ).rejects.toThrow("server not running");
    });
  });

  // ---------------------------------------------------------------------------
  // stop (app:shutdown)
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("disposes server manager and status manager when active", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      // Need a quit hook module to avoid errors in AppShutdownOperation
      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };
      setup.dispatcher.registerModule(quitModule);
      setup.dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await setup.dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(setup.serverManager.dispose).toHaveBeenCalled();
      expect(setup.agentStatusManager.dispose).toHaveBeenCalled();
    });

    it("disposes server manager but not status manager when inactive", async () => {
      const setup = createTestSetup({ agent: "claude" });
      await activateModule(setup);

      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };
      setup.dispatcher.registerModule(quitModule);
      setup.dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await setup.dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(setup.serverManager.dispose).toHaveBeenCalled();
      expect(setup.agentStatusManager.dispose).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // server callbacks (wired during start)
  // ---------------------------------------------------------------------------

  describe("server callbacks", () => {
    it("onServerStopped with isRestart=false calls removeWorkspace", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      // Extract the onServerStopped callback
      const onServerStoppedCall = setup.serverManager.onServerStopped.mock.calls[0]!;
      const callback = onServerStoppedCall[0] as (wp: string, isRestart: boolean) => void;

      callback("/test/ws", false);

      expect(setup.agentStatusManager.removeWorkspace).toHaveBeenCalledWith("/test/ws");
    });

    it("onServerStopped with isRestart=true calls disconnectWorkspace", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const onServerStoppedCall = setup.serverManager.onServerStopped.mock.calls[0]!;
      const callback = onServerStoppedCall[0] as (wp: string, isRestart: boolean) => void;

      callback("/test/ws", true);

      expect(setup.agentStatusManager.disconnectWorkspace).toHaveBeenCalledWith("/test/ws");
    });

    it("onServerStarted creates provider and connects", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      // Extract the onServerStarted callback
      const onServerStartedCall = setup.serverManager.onServerStarted.mock.calls[0]!;
      const callback = onServerStartedCall[0] as (
        wp: string,
        port: number,
        pendingPrompt: unknown
      ) => void;

      callback("/test/ws", 8080, undefined);

      // Wait for async handleServerStarted to fully complete (addProvider is the last step)
      await vi.waitFor(() => {
        expect(setup.agentStatusManager.addProvider).toHaveBeenCalled();
      });

      expect(mockProviderInstance.connect).toHaveBeenCalledWith(8080);
      expect(mockProviderInstance.fetchStatus).toHaveBeenCalled();
      expect(mockProviderInstance.setBridgePort).toHaveBeenCalledWith(9999);
    });

    it("onServerStarted reconnects when provider already exists", async () => {
      const setup = createTestSetup({ agent: null });
      (setup.agentStatusManager.hasProvider as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await activateModule(setup);

      const onServerStartedCall = setup.serverManager.onServerStarted.mock.calls[0]!;
      const callback = onServerStartedCall[0] as (
        wp: string,
        port: number,
        pendingPrompt: unknown
      ) => void;

      callback("/test/ws", 8080, undefined);

      await vi.waitFor(() => {
        expect(setup.agentStatusManager.reconnectWorkspace).toHaveBeenCalledWith("/test/ws");
      });

      // Should NOT create a new provider
      expect(mockProviderInstance.connect).not.toHaveBeenCalled();
    });

    it("onServerStarted sends pending prompt when provided", async () => {
      const setup = createTestSetup({ agent: null });
      await activateModule(setup);

      const onServerStartedCall = setup.serverManager.onServerStarted.mock.calls[0]!;
      const callback = onServerStartedCall[0] as (
        wp: string,
        port: number,
        pendingPrompt: unknown
      ) => void;

      callback("/test/ws", 8080, { prompt: "Fix the bug" });

      await vi.waitFor(() => {
        expect(mockProviderInstance.createSession).toHaveBeenCalled();
      });

      expect(mockProviderInstance.sendPrompt).toHaveBeenCalledWith("sess-1", "Fix the bug", {});
    });
  });
});
