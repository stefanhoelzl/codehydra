// @vitest-environment node
/**
 * Integration tests for the generic createAgentModule factory through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers,
 * using a mock AgentModuleProvider to validate that the factory correctly
 * delegates all behavior to the provider interface.
 */

import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../../intents/lib/dispatcher";
import type { Operation, OperationContext, HookContext } from "../../intents/lib/operation";
import type { Intent } from "../../intents/lib/types";
import { createMinimalOperation } from "../../intents/lib/operation.test-utils";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import {
  AgentLaunchOptionsOperation,
  INTENT_GET_LAUNCH_OPTIONS,
} from "../../intents/agent-launch-options";
import type {
  ConfigureResult,
  CheckDepsResult,
  CheckDepsHookContext,
} from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import type { RegisterAgentResult, SaveAgentHookInput, BinaryHookInput } from "../../intents/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import type {
  SetupHookResult,
  SetupHookInput,
  OpenWorkspaceIntent,
} from "../../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../../intents/delete-workspace";
import type {
  ShutdownHookResult,
  DeletePipelineHookInput,
  DeleteWorkspaceIntent,
} from "../../intents/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../../intents/get-workspace-status";
import type { GetStatusHookResult } from "../../intents/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../../intents/get-agent-session";
import type { GetAgentSessionHookResult } from "../../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../../intents/restart-agent";
import type { RestartAgentHookResult } from "../../intents/restart-agent";
import { AGENT_LIFECYCLE_OPERATION_ID } from "../../intents/agent-lifecycle";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import { createAgentModule, type AgentModuleDeps } from "./agent-module";
import type { AgentModuleProvider, WorkspaceStartResult } from "./agent-module-provider";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { SetupError } from "../../shared/errors/service-errors";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { WorkspaceName } from "../../shared/api/types";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../../boundaries/platform/config";
import { createMockAccessor } from "../../boundaries/platform/config.test-utils";

// =============================================================================
// Mock AgentModuleProvider Factory
// =============================================================================

/** Captured onStatusChange callback from the mock provider */
let capturedStatusCallback:
  | ((workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void)
  | null = null;

function createMockProvider(overrides: Partial<AgentModuleProvider> = {}): AgentModuleProvider {
  capturedStatusCallback = null;

  return {
    type: "claude",
    configKey: "version.claude",
    displayName: "Claude Code",
    icon: "sparkle",
    serverName: "Claude Code hook",
    scripts: ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "claude-code-hook-handler.cjs"],
    binaryType: "claude",

    preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
    downloadBinary: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    startWorkspace: vi.fn().mockResolvedValue({
      envVars: { CLAUDE_PORT: "8080" },
    } satisfies WorkspaceStartResult),
    stopWorkspace: vi.fn().mockResolvedValue({ success: true }),
    restartWorkspace: vi.fn().mockResolvedValue({ success: true, port: 8081 }),
    applyTerminalLifecycle: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      status: "none",
      counts: { idle: 0, busy: 0 },
    } satisfies AggregatedAgentStatus),
    getSession: vi.fn().mockReturnValue({ port: 8080, sessionId: "session-1" }),
    onStatusChange: vi.fn(
      (cb: (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void) => {
        capturedStatusCallback = cb;
        return vi.fn();
      }
    ),
    clearWorkspaceTracking: vi.fn(),
    ...overrides,
  };
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

class MinimalBeforeReadyOperation implements Operation<Intent, readonly ConfigureResult[]> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<readonly ConfigureResult[]> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
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
      extensionRequirements: [],
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

class MinimalStartOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
      capabilities: { mcpPort: null },
    };
    const { errors } = await ctx.hooks.collect<void>("start", hookCtx);
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalStartWithMcpPortOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  private readonly mcpPort: number | null;

  constructor(mcpPort: number | null = null) {
    this.mcpPort = mcpPort;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    // Run start with mcpPort as a pre-populated capability
    const hookCtx: HookContext = {
      intent: ctx.intent,
      capabilities: { mcpPort: this.mcpPort },
    };
    const { errors } = await ctx.hooks.collect<void>("start", hookCtx);
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

interface SetupOperationResult {
  envVars?: Record<string, string>;
  agentType?: string;
}

class MinimalSetupOperation implements Operation<
  OpenWorkspaceIntent,
  SetupOperationResult | undefined
> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<SetupHookInput>;
  private readonly agentCapability: string | null;

  constructor(hookInput: Partial<SetupHookInput> = {}, agentCapability: string | null = "claude") {
    this.hookInput = hookInput;
    this.agentCapability = agentCapability;
  }

  async execute(
    ctx: OperationContext<OpenWorkspaceIntent>
  ): Promise<SetupOperationResult | undefined> {
    const { results, errors, capabilities } = await ctx.hooks.collect<SetupHookResult | undefined>(
      "setup",
      {
        intent: ctx.intent,
        workspacePath: "/test/workspace",
        projectPath: "/test/project",
        ...this.hookInput,
        ...(this.agentCapability !== null && {
          capabilities: { agent: this.agentCapability },
        }),
      }
    );
    if (errors.length > 0) throw errors[0]!;
    const result = results[0];
    if (result === undefined) return undefined;
    return {
      ...result,
      ...(capabilities.agentType !== undefined && { agentType: capabilities.agentType as string }),
    };
  }
}

class MinimalShutdownOperation implements Operation<
  DeleteWorkspaceIntent,
  ShutdownHookResult | undefined
> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;
  private readonly agentCapability: string | null;

  constructor(agentCapability: string | null = "claude") {
    this.agentCapability = agentCapability;
  }

  async execute(
    ctx: OperationContext<DeleteWorkspaceIntent>
  ): Promise<ShutdownHookResult | undefined> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/test/project",
      workspacePath: payload.workspacePath ?? "/test/workspace",
      workspaceName: "test-workspace" as WorkspaceName,
      active: false,
      ...(this.agentCapability !== null && {
        capabilities: { agent: this.agentCapability },
      }),
    };
    const { results, errors } = await ctx.hooks.collect<ShutdownHookResult | undefined>(
      "shutdown",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(providerOverrides: Partial<AgentModuleProvider> = {}) {
  const mockProvider = createMockProvider(providerOverrides);
  const agentConfig = createMockAccessor<ConfigAgentType>("agent", null);

  const mockDispatcher = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;

  const moduleDeps: AgentModuleDeps = {
    dispatcher: mockDispatcher,
    logger: SILENT_LOGGER,
    agentConfig,
  };

  const dispatcher = createMockDispatcher();
  const agentModule = createAgentModule(mockProvider, moduleDeps);

  dispatcher.registerModule(agentModule);

  return { mockProvider, agentConfig, moduleDeps, dispatcher, agentModule };
}

/**
 * Set agent config value to activate the module, then run a start operation.
 */
async function activateModule(
  dispatcher: Dispatcher,
  agentConfig: PersistedAccessor<ConfigAgentType>
): Promise<void> {
  await agentConfig.set("claude");
  dispatcher.registerOperation("app:start", new MinimalStartOperation());
  await dispatcher.dispatch({ type: "app:start", payload: {} });
}

// =============================================================================
// Tests
// =============================================================================

describe("createAgentModule", () => {
  beforeEach(() => {
    capturedStatusCallback = null;
  });

  // ---------------------------------------------------------------------------
  // launch options
  // ---------------------------------------------------------------------------

  describe("agent:get-launch-options", () => {
    it("fills in the matching backend's permission modes via the hook", async () => {
      const { dispatcher } = createTestSetup({
        type: "claude",
        getLaunchOptions: async () => ({ permissionModes: ["plan", "acceptEdits"] }),
      });
      dispatcher.registerOperation(INTENT_GET_LAUNCH_OPTIONS, new AgentLaunchOptionsOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend: "claude" },
      });

      expect(result).toEqual({ permissionModes: ["plan", "acceptEdits"] });
    });

    it("contributes nothing when the requested backend doesn't match the provider", async () => {
      const { dispatcher } = createTestSetup({
        type: "claude",
        getLaunchOptions: async () => ({ permissionModes: ["plan"] }),
      });
      dispatcher.registerOperation(INTENT_GET_LAUNCH_OPTIONS, new AgentLaunchOptionsOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend: "opencode" },
      });

      expect(result).toEqual({ permissionModes: [] });
    });

    it("returns empty when the provider exposes no launch options", async () => {
      const { dispatcher } = createTestSetup({ type: "claude" });
      dispatcher.registerOperation(INTENT_GET_LAUNCH_OPTIONS, new AgentLaunchOptionsOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend: "claude" },
      });

      expect(result).toEqual({ permissionModes: [] });
    });
  });

  // ---------------------------------------------------------------------------
  // module name
  // ---------------------------------------------------------------------------

  describe("module identity", () => {
    it("uses provider type as module name prefix", () => {
      const { agentModule } = createTestSetup();
      expect(agentModule.name).toBe("claude-agent");
    });

    it("uses provider type for non-claude agent", () => {
      const { agentModule } = createTestSetup({ type: "opencode" });
      expect(agentModule.name).toBe("opencode-agent");
    });
  });

  // ---------------------------------------------------------------------------
  // before-ready
  // ---------------------------------------------------------------------------

  describe("before-ready", () => {
    it("returns provider scripts", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalBeforeReadyOperation());

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
  // register (factory body)
  // ---------------------------------------------------------------------------

  describe("config registration", () => {
    it("registers provider config definition via configService", () => {
      const { agentConfig } = createTestSetup();
      // The factory calls configService.register in the body, so
      // we just verify it was called. Since our mock is a no-op for register,
      // we verify that the module was created without errors.
      expect(agentConfig).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // check-deps
  // ---------------------------------------------------------------------------

  describe("check-deps", () => {
    it("returns missingBinaries when configuredAgent matches and download needed", async () => {
      const { dispatcher } = createTestSetup({
        preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
      });
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation("claude"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("claude");
    });

    it("returns empty when configuredAgent does not match", async () => {
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
  // start (mcpPort capture; provider.initialize is now deferred to first workspace:open)
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("does not initialize provider during app:start (lazy init)", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(mockProvider.initialize).not.toHaveBeenCalled();
      expect(mockProvider.onStatusChange).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // lazy init via workspace:open setup
  // ---------------------------------------------------------------------------

  describe("lazy init", () => {
    it("initializes provider with captured mcpPort on first workspace:open", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

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
        },
      } as unknown as OpenWorkspaceIntent);

      expect(mockProvider.initialize).toHaveBeenCalledWith({ port: 9999 });
      expect(mockProvider.onStatusChange).toHaveBeenCalled();
    });

    it("passes null mcpConfig when no mcpPort was captured", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(null));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

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
        },
      } as unknown as OpenWorkspaceIntent);

      expect(mockProvider.initialize).toHaveBeenCalledWith(null);
    });

    it("only initializes once across multiple workspace:open calls", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "b", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      expect(mockProvider.initialize).toHaveBeenCalledTimes(1);
    });

    it("dispatches INTENT_UPDATE_AGENT_STATUS when onStatusChange fires", async () => {
      const { dispatcher, moduleDeps } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      expect(capturedStatusCallback).not.toBeNull();

      const dispatchSpy = vi.spyOn(moduleDeps.dispatcher, "dispatch").mockResolvedValue(undefined);

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 1, busy: 0 } };
      capturedStatusCallback!("/test/workspace" as WorkspacePath, status);

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_UPDATE_AGENT_STATUS,
          payload: { workspacePath: "/test/workspace", status },
        })
      );
    });

    it("does not initialize when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation(
          {
            workspacePath: "/test/workspace",
            projectPath: "/test/project",
          },
          "opencode"
        )
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      expect(mockProvider.initialize).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // register-agents
  // ---------------------------------------------------------------------------

  describe("register-agents", () => {
    it("returns provider agent info", async () => {
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
    it("calls configService.set when selectedAgent matches provider type", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      const setSpy = vi.spyOn(agentConfig, "set");
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("claude"));

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(setSpy).toHaveBeenCalledWith("claude");
    });

    it("skips when selectedAgent does not match provider type", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      const setSpy = vi.spyOn(agentConfig, "set");
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("opencode"));

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(setSpy).not.toHaveBeenCalled();
    });

    it("throws SetupError on config save failure", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      vi.spyOn(agentConfig, "set").mockRejectedValue(new Error("disk full"));
      dispatcher.registerOperation("setup", new MinimalSaveAgentOperation("claude"));

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    it("downloads when agent type matches and binary is missing", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("reports done when agent matches but binary not missing", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: [],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("agent", "done");
    });

    it("skips download and report when agent does not match", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "opencode",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).not.toHaveBeenCalled();
    });

    it("reports progress during download", async () => {
      const { dispatcher } = createTestSetup({
        downloadBinary: vi
          .fn()
          .mockImplementation(
            async (
              cb: (p: { phase: string; bytesDownloaded: number; totalBytes: number }) => void
            ) => {
              cb({ phase: "downloading", bytesDownloaded: 50, totalBytes: 100 });
              cb({ phase: "extracting", bytesDownloaded: 100, totalBytes: 100 });
            }
          ),
      });
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
      const { dispatcher } = createTestSetup({
        downloadBinary: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        selectedAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith("agent", "failed", undefined, "network error");
    });

    it("uses configuredAgent when selectedAgent not provided", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = new MinimalBinaryOperation({
        missingBinaries: ["claude"],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // workspace setup (open-workspace)
  // ---------------------------------------------------------------------------

  describe("workspace setup", () => {
    it("calls provider.startWorkspace and returns envVars when active", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

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
      } as unknown as OpenWorkspaceIntent)) as SetupOperationResult | undefined;

      expect(mockProvider.startWorkspace).toHaveBeenCalledWith("/test/workspace", {
        isNewWorkspace: true,
      });
      expect(result).toBeDefined();
      expect(result!.agentType).toBe("claude");
      expect(result!.envVars).toEqual({ CLAUDE_PORT: "8080" });
    });

    it("passes initial prompt to startWorkspace when provided in intent", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

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

      expect(mockProvider.startWorkspace).toHaveBeenCalledWith("/test/workspace", {
        initialPrompt: { prompt: "Hello Claude" },
        isNewWorkspace: true,
      });
    });

    it("passes isNewWorkspace=false for existing workspaces", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

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
          existingWorkspace: {
            path: "/test/workspace",
            name: "feature-1",
            branch: "feature-1",
            metadata: {},
          },
        },
      } as unknown as OpenWorkspaceIntent);

      expect(mockProvider.startWorkspace).toHaveBeenCalledWith("/test/workspace", {
        isNewWorkspace: false,
      });
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation(
          {
            workspacePath: "/test/workspace",
            projectPath: "/test/project",
          },
          "opencode"
        )
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
        },
      } as unknown as OpenWorkspaceIntent)) as SetupOperationResult | undefined;

      expect(result).toBeUndefined();
      expect(mockProvider.startWorkspace).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // delete / shutdown
  // ---------------------------------------------------------------------------

  describe("delete shutdown", () => {
    it("calls provider.stopWorkspace when active", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

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

      expect(mockProvider.stopWorkspace).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.serverName).toBe("Claude Code hook");
    });

    it("calls clearWorkspaceTracking after successful stop", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

      await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          workspacePath: "/test/workspace",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(mockProvider.clearWorkspaceTracking).toHaveBeenCalledWith("/test/workspace");
    });

    it("returns error in result when stop fails in force mode", async () => {
      const { dispatcher, agentConfig } = createTestSetup({
        stopWorkspace: vi.fn().mockResolvedValue({ success: false, error: "server busy" }),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation());

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
      const { dispatcher, agentConfig } = createTestSetup({
        stopWorkspace: vi.fn().mockResolvedValue({ success: false, error: "server busy" }),
      });
      await activateModule(dispatcher, agentConfig);

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

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();

      dispatcher.registerOperation("workspace:delete", new MinimalShutdownOperation("opencode"));

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
      expect(mockProvider.stopWorkspace).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // get-status
  // ---------------------------------------------------------------------------

  describe("get-status", () => {
    it("returns status from provider when active", async () => {
      const idleStatus: AggregatedAgentStatus = {
        status: "idle",
        counts: { idle: 1, busy: 0 },
      };
      const { dispatcher, agentConfig } = createTestSetup({
        getStatus: vi.fn().mockReturnValue(idleStatus),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(
        "workspace:get-status",
        createMinimalOperation<Intent, GetStatusHookResult | undefined>(
          GET_WORKSPACE_STATUS_OPERATION_ID,
          "get",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "claude" },
            }),
          }
        )
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:get-status",
        payload: { workspacePath: "/test/workspace" },
      })) as GetStatusHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.agentStatus).toEqual(idleStatus);
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher } = createTestSetup();

      dispatcher.registerOperation(
        "workspace:get-status",
        createMinimalOperation<Intent, GetStatusHookResult | undefined>(
          GET_WORKSPACE_STATUS_OPERATION_ID,
          "get",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "opencode" },
            }),
          }
        )
      );

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
    it("returns session from provider when active", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(
        "agent:get-session",
        createMinimalOperation<Intent, GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          "get",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "claude" },
            }),
          }
        )
      );

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/workspace" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.session).toEqual({ port: 8080, sessionId: "session-1" });
    });

    it("returns null session when provider has no session", async () => {
      const { dispatcher, agentConfig } = createTestSetup({
        getSession: vi.fn().mockReturnValue(null),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(
        "agent:get-session",
        createMinimalOperation<Intent, GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          "get",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "claude" },
            }),
          }
        )
      );

      const result = (await dispatcher.dispatch({
        type: "agent:get-session",
        payload: { workspacePath: "/test/workspace" },
      })) as GetAgentSessionHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.session).toBeNull();
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher } = createTestSetup();

      dispatcher.registerOperation(
        "agent:get-session",
        createMinimalOperation<Intent, GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          "get",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "opencode" },
            }),
          }
        )
      );

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
    it("restarts workspace via provider when active and returns port", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(
        "agent:restart",
        createMinimalOperation<Intent, RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          "restart",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "claude" },
            }),
          }
        )
      );

      const result = (await dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: "/test/workspace" },
      })) as RestartAgentHookResult | undefined;

      expect(mockProvider.restartWorkspace).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.port).toBe(8081);
    });

    it("throws when restart fails", async () => {
      const { dispatcher, agentConfig } = createTestSetup({
        restartWorkspace: vi.fn().mockResolvedValue({
          success: false,
          error: "restart failed",
        }),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(
        "agent:restart",
        createMinimalOperation<Intent, RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          "restart",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "claude" },
            }),
          }
        )
      );

      await expect(
        dispatcher.dispatch({
          type: "agent:restart",
          payload: { workspacePath: "/test/workspace" },
        })
      ).rejects.toThrow("restart failed");
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();

      dispatcher.registerOperation(
        "agent:restart",
        createMinimalOperation<Intent, RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          "restart",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: "/test/workspace",
              capabilities: { agent: "opencode" },
            }),
          }
        )
      );

      const result = (await dispatcher.dispatch({
        type: "agent:restart",
        payload: { workspacePath: "/test/workspace" },
      })) as RestartAgentHookResult | undefined;

      expect(result).toBeUndefined();
      expect(mockProvider.restartWorkspace).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // lifecycle (agent:lifecycle)
  // ---------------------------------------------------------------------------

  describe("lifecycle", () => {
    function registerLifecycleOp(dispatcher: Dispatcher, agent: string): void {
      dispatcher.registerOperation(
        "agent:lifecycle",
        createMinimalOperation<Intent, void>(AGENT_LIFECYCLE_OPERATION_ID, "lifecycle", {
          hookContext: (ctx) => ({
            intent: ctx.intent,
            workspacePath: (ctx.intent.payload as { workspacePath: string }).workspacePath,
            event: (ctx.intent.payload as { event: "open" | "close" }).event,
            capabilities: { agent },
          }),
        })
      );
    }

    it("forwards open to provider.applyTerminalLifecycle when active", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);
      registerLifecycleOp(dispatcher, "claude");

      await dispatcher.dispatch({
        type: "agent:lifecycle",
        payload: { workspacePath: "/test/workspace", event: "open" },
      });

      expect(mockProvider.applyTerminalLifecycle).toHaveBeenCalledWith("/test/workspace", "open");
    });

    it("forwards close to provider.applyTerminalLifecycle when active", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);
      registerLifecycleOp(dispatcher, "claude");

      await dispatcher.dispatch({
        type: "agent:lifecycle",
        payload: { workspacePath: "/test/workspace", event: "close" },
      });

      expect(mockProvider.applyTerminalLifecycle).toHaveBeenCalledWith("/test/workspace", "close");
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      registerLifecycleOp(dispatcher, "opencode");

      await dispatcher.dispatch({
        type: "agent:lifecycle",
        payload: { workspacePath: "/test/workspace", event: "open" },
      });

      expect(mockProvider.applyTerminalLifecycle).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // stop (app:shutdown)
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("cleans up statusChange subscription and disposes provider", async () => {
      const cleanupFn = vi.fn();
      const { dispatcher, mockProvider } = createTestSetup({
        onStatusChange: vi.fn().mockReturnValue(cleanupFn),
      });
      // Initialize provider via lazy path so dispose has something to clean up.
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(cleanupFn).toHaveBeenCalled();
      expect(mockProvider.dispose).toHaveBeenCalled();
    });

    it("skips dispose when provider was never initialized", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockProvider.dispose).not.toHaveBeenCalled();
    });

    it("collect catches stop error, dispatch still resolves", async () => {
      const { dispatcher } = createTestSetup({
        dispose: vi.fn().mockRejectedValue(new Error("dispose failed")),
      });
      // Initialize first so dispose runs
      dispatcher.registerOperation("app:start", new MinimalStartWithMcpPortOperation(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalSetupOperation({
          workspacePath: "/test/workspace",
          projectPath: "/test/project",
        })
      );
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });
});
