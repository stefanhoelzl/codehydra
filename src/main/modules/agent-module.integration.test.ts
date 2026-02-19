// @vitest-environment node
/**
 * Integration tests for AgentModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 */

import { describe, it, expect, vi } from "vitest";
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
import { createAgentModule, type AgentModuleDeps, type AgentLifecycleDeps } from "./agent-module";
import { SILENT_LOGGER } from "../../services/logging";
import { createBehavioralIpcLayer } from "../../services/platform/ipc.test-utils";
import { SetupError } from "../../services/errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { AgentServerManager } from "../../agents/types";

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

class MinimalActivateOperation implements Operation<Intent, ActivateHookResult> {
  readonly id = APP_START_OPERATION_ID;
  private readonly hookInput: Partial<ActivateHookContext>;

  constructor(hookInput: Partial<ActivateHookContext> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<ActivateHookResult> {
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

function createMockLifecycleDeps(
  agentType: "opencode" | "claude" = "opencode"
): AgentLifecycleDeps {
  return {
    agentStatusManager:
      createMockAgentStatusManager() as unknown as AgentLifecycleDeps["agentStatusManager"],
    serverManager: createMockServerManager(
      agentType
    ) as unknown as AgentLifecycleDeps["serverManager"],
    selectedAgentType: agentType,
    loggingService: {
      createLogger: vi.fn().mockReturnValue(SILENT_LOGGER),
    } as unknown as AgentLifecycleDeps["loggingService"],
    dispatcher: new Dispatcher(new HookRegistry()),
    killTerminalsCallback: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDeps(overrides?: { lifecycleDeps?: AgentLifecycleDeps }): AgentModuleDeps {
  const lifecycleDeps = overrides?.lifecycleDeps ?? createMockLifecycleDeps();
  const ipcLayer = createBehavioralIpcLayer();

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
    getLifecycleDeps: () => lifecycleDeps,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDeps?: AgentModuleDeps) {
  const deps = mockDeps ?? createMockDeps();
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
  // ---------------------------------------------------------------------------
  // check-config
  // ---------------------------------------------------------------------------

  describe("check-config", () => {
    it("loads config and returns configuredAgent", async () => {
      const deps = createMockDeps();
      (deps.configService.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent: "claude",
      });
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const mockBinaryManager = {
        preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn(),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const mockWebContents = {
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      };
      (deps.getUIWebContentsFn as ReturnType<typeof vi.fn>).mockReturnValue(mockWebContents);
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "setup",
        new MinimalSaveAgentOperation({ selectedAgent: "claude" })
      );

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.configService.setAgent).toHaveBeenCalledWith("claude");
    });

    it("throws SetupError when setAgent fails", async () => {
      const deps = createMockDeps();
      (deps.configService.setAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("disk full")
      );
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn().mockResolvedValue(undefined),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn(),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      const { dispatcher } = createTestSetup(deps);
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
      const deps = createMockDeps();
      const mockBinaryManager = {
        preflight: vi.fn(),
        getBinaryType: vi.fn().mockReturnValue("opencode"),
        downloadBinary: vi.fn().mockRejectedValue(new Error("network error")),
      };
      (deps.getAgentBinaryManager as ReturnType<typeof vi.fn>).mockReturnValue(mockBinaryManager);
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Verify onStatusChanged was subscribed
      expect(
        (lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .onStatusChanged!
      ).toHaveBeenCalledWith(expect.any(Function));

      // Verify server callbacks were wired
      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .onServerStarted!
      ).toHaveBeenCalledWith(expect.any(Function));
      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .onServerStopped!
      ).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for opencode", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .setMarkActiveHandler!
      ).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls setMarkActiveHandler for claude", async () => {
      const lifecycleDeps = createMockLifecycleDeps("claude");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .setMarkActiveHandler!
      ).toHaveBeenCalledWith(expect.any(Function));
    });

    it("dispatches agent:update-status when status changes", async () => {
      // Build deps first, then wire so lifecycle.dispatcher is the SAME dispatcher
      const lifecycleDeps = createMockLifecycleDeps();
      // Capture the status callback
      let statusCallback: ((path: WorkspacePath, status: AggregatedAgentStatus) => void) | null =
        null;
      (
        lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).onStatusChanged!.mockImplementation(
        (cb: (path: WorkspacePath, status: AggregatedAgentStatus) => void) => {
          statusCallback = cb;
          return vi.fn();
        }
      );

      // Create module deps but override lifecycleDeps with a getter that
      // returns our lifecycleDeps with the REAL dispatcher (set below)
      const ipcLayer = createBehavioralIpcLayer();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      // Point lifecycleDeps.dispatcher at the real dispatcher
      (lifecycleDeps as unknown as Record<string, unknown>).dispatcher = dispatcher;

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
        getLifecycleDeps: () => lifecycleDeps,
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
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalActivateOperation({ mcpPort: 5555 }));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const serverManager = lifecycleDeps.serverManager as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(serverManager.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("calls setMcpConfig with mcpPort (Claude)", async () => {
      const lifecycleDeps = createMockLifecycleDeps("claude");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalActivateOperation({ mcpPort: 5555 }));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const serverManager = lifecycleDeps.serverManager as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(serverManager.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("skips setMcpConfig when mcpPort is null", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalActivateOperation({ mcpPort: null }));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const serverManager = lifecycleDeps.serverManager as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(serverManager.setMcpConfig).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // workspace setup
  // ---------------------------------------------------------------------------

  describe("workspace setup", () => {
    it("starts server, waits for provider, and returns envVars", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .startServer!
      ).toHaveBeenCalledWith("/test/project/.worktrees/feature-1");
      expect(result.envVars).toBeDefined();
      expect(result.envVars!.OPENCODE_PORT).toBe("8080");
    });

    it("sets initial prompt when provided", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .setInitialPrompt!
      ).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        expect.objectContaining({ prompt: "Hello world" })
      );
    });

    it("adds bridge port for OpenCode", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
    });
  });

  // ---------------------------------------------------------------------------
  // delete shutdown
  // ---------------------------------------------------------------------------

  describe("delete shutdown", () => {
    it("stops server and clears TUI tracking", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .stopServer!
      ).toHaveBeenCalledWith("/test/project/.worktrees/feature-1");
      expect(
        (lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .clearTuiTracking!
      ).toHaveBeenCalled();
      expect(result.serverName).toBeDefined();
    });

    it("continues on error in force mode", async () => {
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      (
        lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).stopServer!.mockResolvedValue({ success: false, error: "server crash" });
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      (
        lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).stopServer!.mockResolvedValue({ success: false, error: "server crash" });
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps("opencode");
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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

      expect(lifecycleDeps.killTerminalsCallback).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // get workspace status
  // ---------------------------------------------------------------------------

  describe("get workspace status", () => {
    it("returns agent status from agentStatusManager", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const expectedStatus: AggregatedAgentStatus = {
        status: "busy",
        counts: { idle: 0, busy: 2 },
      };
      (
        lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).getStatus!.mockReturnValue(expectedStatus);
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      (
        lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).getSession!.mockReturnValue({ port: 8080, sessionId: "sess-1" });
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      (
        lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).getSession!.mockReturnValue(null);
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      (
        lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).restartServer!.mockResolvedValue({ success: true, port: 9090 });
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      (
        lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).restartServer!.mockResolvedValue({
        success: false,
        error: "restart failed",
        serverStopped: false,
      });
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
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
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });

      // We need to wire start first so that cleanup callbacks exist
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createAgentModule(deps);
      wireModules([module], hookRegistry, dispatcher);

      // First run start to wire callbacks
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now run shutdown
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());
      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(
        (lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .dispose!
      ).toHaveBeenCalled();
      expect(
        (lifecycleDeps.agentStatusManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
          .dispose!
      ).toHaveBeenCalled();
    });

    it("handles shutdown errors gracefully (non-fatal)", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      (
        lifecycleDeps.serverManager as unknown as Record<string, ReturnType<typeof vi.fn>>
      ).dispose!.mockRejectedValue(new Error("dispose failed"));
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      // Should not throw - shutdown errors are non-fatal
      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });
});
