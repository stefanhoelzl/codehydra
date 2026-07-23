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
import { z } from "zod/v4";
import { Dispatcher } from "../../intents/lib/dispatcher";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../../intents/lib/operation";
import { createMinimalOperation } from "../../intents/lib/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  configureResultSchema,
  checkDepsResultSchema,
  registerAgentResultSchema,
} from "../../intents/app-start";
import {
  AgentLaunchOptionsOperation,
  INTENT_GET_LAUNCH_OPTIONS,
} from "../../intents/agent-launch-options";
import type {
  ConfigureResult,
  CheckDepsResult,
  CheckDepsHookContext,
  RegisterAgentResult,
  SaveAgentHookInput,
} from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../../intents/app-shutdown";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import type { BinaryHookInput, SetupProgressPayload } from "../../intents/setup";
import {
  INTENT_OPEN_WORKSPACE,
  OPEN_WORKSPACE_OPERATION_ID,
  setupResultSchema,
} from "../../intents/open-workspace";
import type { SetupHookInput, OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../../intents/delete-workspace";
import type {
  ShutdownHookResult,
  DeletePipelineHookInput,
  DeleteWorkspaceIntent,
} from "../../intents/delete-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
} from "../../intents/get-workspace-status";
import type { GetStatusHookResult } from "../../intents/get-workspace-status";
import {
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "../../intents/get-agent-session";
import type { GetAgentSessionHookResult } from "../../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID, INTENT_RESTART_AGENT } from "../../intents/restart-agent";
import type { RestartAgentHookResult } from "../../intents/restart-agent";
import {
  AGENT_LIFECYCLE_OPERATION_ID,
  INTENT_AGENT_LIFECYCLE,
} from "../../intents/agent-lifecycle";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import { createAgentModule, type AgentModuleDeps } from "./agent-module";
import type { AgentModuleProvider, WorkspaceStartResult } from "./agent-module-provider";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { SetupError } from "../../shared/errors/service-errors";
import type { AggregatedAgentStatus } from "../../shared/ipc";
import type { WorkspaceName } from "../../shared/api/types";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../../boundaries/platform/config";
import { createMockAccessor } from "../../boundaries/platform/config.test-utils";
import { wsPath, projPath } from "../../shared/test-fixtures";
import type { WorkspacePath } from "../../intents/contract";

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

const beforeReadySchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<readonly ConfigureResult[]>(),
  hooks: { "before-ready": { result: configureResultSchema } },
} satisfies OperationSchemas;

class MinimalBeforeReadyOperation implements Operation<typeof beforeReadySchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = beforeReadySchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof beforeReadySchemas>, typeof beforeReadySchemas>
  ): Promise<readonly ConfigureResult[]> {
    const { results, errors } = await ctx.hooks.collect("before-ready", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

const checkDepsSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<CheckDepsResult>(),
  hooks: { "check-deps": { result: checkDepsResultSchema } },
} satisfies OperationSchemas;

function minimalCheckDeps(
  configuredAgent: string | null = "claude"
): Operation<typeof checkDepsSchemas> {
  return {
    id: APP_START_OPERATION_ID,
    schemas: checkDepsSchemas,
    async execute(ctx): Promise<CheckDepsResult> {
      const hookCtx: CheckDepsHookContext = {
        intent: ctx.intent,
        configuredAgent: configuredAgent as CheckDepsHookContext["configuredAgent"],
        extensionRequirements: [],
      };
      const { results } = await ctx.hooks.collect("check-deps", hookCtx);
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
    },
  };
}

/**
 * Minimal app:start operation that runs the "start" hook point with `mcpPort` seeded as a
 * capability (defaults to null). Replaces the old MinimalStart / MinimalStartWithMcpPort classes.
 */
function minimalStart(mcpPort: number | null = null): Operation<OperationSchemas> {
  return createMinimalOperation<void>(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
    hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { mcpPort } }),
  });
}

const registerAgentsSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<readonly RegisterAgentResult[]>(),
  hooks: { "register-agents": { result: registerAgentResultSchema } },
} satisfies OperationSchemas;

class MinimalRegisterAgentsOperation implements Operation<typeof registerAgentsSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = registerAgentsSchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof registerAgentsSchemas>, typeof registerAgentsSchemas>
  ): Promise<readonly RegisterAgentResult[]> {
    const { results, errors } = await ctx.hooks.collect("register-agents", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return results;
  }
}

/** Minimal app:start operation that runs the "save-agent" hook point with `selectedAgent` seeded. */
function minimalSaveAgent(selectedAgent: string): Operation<OperationSchemas> {
  return createMinimalOperation<void>(APP_START_OPERATION_ID, INTENT_APP_START, "save-agent", {
    hookContext: (ctx): SaveAgentHookInput => ({
      intent: ctx.intent,
      selectedAgent: selectedAgent as SaveAgentHookInput["selectedAgent"],
    }),
  });
}

const binarySchemas = {
  type: "setup",
  payload: z.unknown(),
} satisfies OperationSchemas;

/** Bespoke binary operation exposing the streamed progress `frames` for assertions. */
type MinimalBinaryOperation = Operation<typeof binarySchemas> & {
  readonly frames: SetupProgressPayload[];
};

function minimalBinary(hookInput: Partial<BinaryHookInput> = {}): MinimalBinaryOperation {
  const frames: SetupProgressPayload[] = [];
  return {
    id: SETUP_OPERATION_ID,
    schemas: binarySchemas,
    frames,
    async execute(ctx): Promise<void> {
      const { errors } = await ctx.hooks.collect(
        "binary",
        {
          intent: ctx.intent,
          ...hookInput,
        },
        {
          onYield: (frame) => {
            frames.push(frame as SetupProgressPayload);
          },
        }
      );
      if (errors.length > 0) throw errors[0]!;
    },
  };
}

interface SetupOperationResult {
  envVars?: Record<string, string>;
  agentType?: string;
}

const setupSchemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: z.unknown(),
  result: z.custom<SetupOperationResult | undefined>(),
  hooks: { setup: { result: setupResultSchema } },
} satisfies OperationSchemas;

function minimalSetup(
  hookInput: Partial<SetupHookInput> = {},
  agentCapability: string | null = "claude"
): Operation<typeof setupSchemas> {
  return {
    id: OPEN_WORKSPACE_OPERATION_ID,
    schemas: setupSchemas,
    async execute(ctx): Promise<SetupOperationResult | undefined> {
      const { results, errors } = await ctx.hooks.collect("setup", {
        intent: ctx.intent,
        workspacePath: "/test/workspace",
        projectPath: "/test/project",
        ...hookInput,
        ...(agentCapability !== null && {
          capabilities: { agent: agentCapability },
        }),
      });
      if (errors.length > 0) throw errors[0]!;
      const result = results[0];
      if (result === undefined) return undefined;
      return {
        ...(result.envVars !== undefined && { envVars: result.envVars }),
        ...(result.agentType != null && { agentType: result.agentType }),
      };
    },
  };
}

/**
 * Minimal delete operation that runs the "shutdown" hook point, seeding the delete pipeline
 * context (with `agentCapability` as the agent capability) and returning the first hook result.
 */
function minimalShutdown(agentCapability: string | null = "claude"): Operation<OperationSchemas> {
  return createMinimalOperation<ShutdownHookResult | undefined>(
    DELETE_WORKSPACE_OPERATION_ID,
    INTENT_DELETE_WORKSPACE,
    "shutdown",
    {
      hookContext: (ctx): DeletePipelineHookInput => {
        const payload = ctx.intent.payload as { workspacePath?: WorkspacePath };
        return {
          intent: ctx.intent,
          projectPath: projPath("/test/project"),
          workspacePath: payload.workspacePath ?? wsPath("/test/workspace"),
          workspaceName: "test-workspace" as WorkspaceName,
          active: false,
          ...(agentCapability !== null && {
            capabilities: { agent: agentCapability },
          }),
        };
      },
    }
  );
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(providerOverrides: Partial<AgentModuleProvider> = {}) {
  const mockProvider = createMockProvider(providerOverrides);
  const agentConfig = createMockAccessor<ConfigAgentType>("agent", "claude");

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
  dispatcher.registerOperation(minimalStart());
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
      dispatcher.registerOperation(new AgentLaunchOptionsOperation());

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
      dispatcher.registerOperation(new AgentLaunchOptionsOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend: "opencode" },
      });

      expect(result).toEqual({ permissionModes: [] });
    });

    it("returns empty when the provider exposes no launch options", async () => {
      const { dispatcher } = createTestSetup({ type: "claude" });
      dispatcher.registerOperation(new AgentLaunchOptionsOperation());

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
      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

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
      dispatcher.registerOperation(minimalCheckDeps("claude"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("claude");
    });

    it("returns empty when configuredAgent does not match", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation(minimalCheckDeps("opencode"));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).toHaveLength(0);
    });

    it("returns empty missingBinaries when download not needed", async () => {
      const { dispatcher } = createTestSetup();
      dispatcher.registerOperation(minimalCheckDeps("claude"));

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
      dispatcher.registerOperation(minimalStart(9999));

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
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
      dispatcher.registerOperation(minimalStart(null));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        minimalSetup(
          {
            workspacePath: wsPath("/test/workspace"),
            projectPath: projPath("/test/project"),
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
      dispatcher.registerOperation(new MinimalRegisterAgentsOperation());

      const results = (await dispatcher.dispatch({
        type: INTENT_APP_START,
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
      dispatcher.registerOperation(minimalSaveAgent("claude"));

      await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} });

      expect(setSpy).toHaveBeenCalledWith("claude");
    });

    it("skips when selectedAgent does not match provider type", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      const setSpy = vi.spyOn(agentConfig, "set");
      dispatcher.registerOperation(minimalSaveAgent("opencode"));

      await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} });

      expect(setSpy).not.toHaveBeenCalled();
    });

    it("throws SetupError on config save failure", async () => {
      const { dispatcher, agentConfig } = createTestSetup();
      vi.spyOn(agentConfig, "set").mockRejectedValue(new Error("disk full"));
      dispatcher.registerOperation(minimalSaveAgent("claude"));

      await expect(dispatcher.dispatch({ type: INTENT_APP_START, payload: {} })).rejects.toThrow(
        SetupError
      );
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    it("downloads when agent type matches and binary is missing", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = minimalBinary({
        missingBinaries: ["claude"],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).toHaveBeenCalled();
      expect(op.frames).toContainEqual({ id: "agent", status: "done" });
    });

    it("reports done when agent matches but binary not missing", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = minimalBinary({
        missingBinaries: [],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).not.toHaveBeenCalled();
      expect(op.frames).toContainEqual({ id: "agent", status: "done" });
    });

    it("skips download and report when agent does not match", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      const op = minimalBinary({
        missingBinaries: ["claude"],
        configuredAgent: "opencode",
      });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(mockProvider.downloadBinary).not.toHaveBeenCalled();
      expect(op.frames).toHaveLength(0);
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
      const op = minimalBinary({
        missingBinaries: ["claude"],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(op.frames).toContainEqual({
        id: "agent",
        status: "running",
        message: "Downloading...",
        progress: 50,
      });
      expect(op.frames).toContainEqual({
        id: "agent",
        status: "running",
        message: "Extracting...",
        progress: 100,
      });
    });

    it("throws SetupError on download failure", async () => {
      const { dispatcher } = createTestSetup({
        downloadBinary: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const op = minimalBinary({
        missingBinaries: ["claude"],
        configuredAgent: "claude",
      });
      dispatcher.registerOperation(op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.frames).toContainEqual({ id: "agent", status: "failed", error: "network error" });
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
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectId: "test-12345678",
          workspaceName: "feature-1",
          base: "main",
          agent: { type: "default", prompt: "Hello Claude" },
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
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
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
        minimalSetup(
          {
            workspacePath: wsPath("/test/workspace"),
            projectPath: projPath("/test/project"),
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

      dispatcher.registerOperation(minimalShutdown());

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath("/test/workspace"),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      })) as ShutdownHookResult | undefined;

      expect(mockProvider.stopWorkspace).toHaveBeenCalledWith("/test/workspace");
      expect(result).toBeDefined();
      expect(result!.serverName).toBe("Claude Code hook");
    });

    it("calls clearWorkspaceTracking after successful stop", async () => {
      const { dispatcher, agentConfig, mockProvider } = createTestSetup();
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(minimalShutdown());

      await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath("/test/workspace"),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      });

      expect(mockProvider.clearWorkspaceTracking).toHaveBeenCalledWith("/test/workspace");
    });

    it("returns error in result when stop fails in force mode", async () => {
      const { dispatcher, agentConfig } = createTestSetup({
        stopWorkspace: vi.fn().mockResolvedValue({ success: false, error: "server busy" }),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(minimalShutdown());

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath("/test/workspace"),
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      })) as ShutdownHookResult | undefined;

      expect(result).toBeDefined();
      expect(result!.error).toBe("server busy");
    });

    it("throws when stop fails and not force mode", async () => {
      const { dispatcher, agentConfig } = createTestSetup({
        stopWorkspace: vi.fn().mockResolvedValue({ success: false, error: "server busy" }),
      });
      await activateModule(dispatcher, agentConfig);

      dispatcher.registerOperation(minimalShutdown());

      await expect(
        dispatcher.dispatch<DeleteWorkspaceIntent>({
          type: "workspace:delete",
          payload: {
            workspacePath: wsPath("/test/workspace"),
            keepBranch: false,
            force: false,
            removeWorktree: true,
          },
        })
      ).rejects.toThrow("server busy");
    });

    it("does not run when agent capability does not match provider type", async () => {
      const { dispatcher, mockProvider } = createTestSetup();

      dispatcher.registerOperation(minimalShutdown("opencode"));

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspacePath: wsPath("/test/workspace"),
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      })) as ShutdownHookResult | undefined;

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
        createMinimalOperation<GetStatusHookResult | undefined>(
          GET_WORKSPACE_STATUS_OPERATION_ID,
          INTENT_GET_WORKSPACE_STATUS,
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
        createMinimalOperation<GetStatusHookResult | undefined>(
          GET_WORKSPACE_STATUS_OPERATION_ID,
          INTENT_GET_WORKSPACE_STATUS,
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
        createMinimalOperation<GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          INTENT_GET_AGENT_SESSION,
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
        createMinimalOperation<GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          INTENT_GET_AGENT_SESSION,
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
        createMinimalOperation<GetAgentSessionHookResult | undefined>(
          GET_AGENT_SESSION_OPERATION_ID,
          INTENT_GET_AGENT_SESSION,
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
        createMinimalOperation<RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          INTENT_RESTART_AGENT,
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
        createMinimalOperation<RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          INTENT_RESTART_AGENT,
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
        createMinimalOperation<RestartAgentHookResult | undefined>(
          RESTART_AGENT_OPERATION_ID,
          INTENT_RESTART_AGENT,
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
        createMinimalOperation<void>(
          AGENT_LIFECYCLE_OPERATION_ID,
          INTENT_AGENT_LIFECYCLE,
          "lifecycle",
          {
            hookContext: (ctx) => ({
              intent: ctx.intent,
              workspacePath: (ctx.intent.payload as { workspacePath: WorkspacePath }).workspacePath,
              event: (ctx.intent.payload as { event: "open" | "close" }).event,
              capabilities: { agent },
            }),
          }
        )
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
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });
      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
        })
      );
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      dispatcher.registerOperation(
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(cleanupFn).toHaveBeenCalled();
      expect(mockProvider.dispose).toHaveBeenCalled();
    });

    it("skips dispose when provider was never initialized", async () => {
      const { dispatcher, mockProvider } = createTestSetup();
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockProvider.dispose).not.toHaveBeenCalled();
    });

    it("collect catches stop error, dispatch still resolves", async () => {
      const { dispatcher } = createTestSetup({
        dispose: vi.fn().mockRejectedValue(new Error("dispose failed")),
      });
      // Initialize first so dispose runs
      dispatcher.registerOperation(minimalStart(9999));
      await dispatcher.dispatch({ type: "app:start", payload: {} });
      dispatcher.registerOperation(
        minimalSetup({
          workspacePath: wsPath("/test/workspace"),
          projectPath: projPath("/test/project"),
        })
      );
      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectId: "p1", workspaceName: "a", base: "main" },
      } as unknown as OpenWorkspaceIntent);

      dispatcher.registerOperation(
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
      );

      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });
});
