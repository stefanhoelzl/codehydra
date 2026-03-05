// @vitest-environment node
/**
 * Integration tests for CodeServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher, IntentHandle } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type { CheckDepsResult, ConfigureResult, StartHookResult } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import type {
  FinalizeHookInput,
  FinalizeHookResult,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../operations/delete-workspace";
import { createCodeServerModule, type CodeServerModuleDeps } from "./code-server-module";
import {
  CONFIG_SET_VALUES_OPERATION_ID,
  ConfigSetValuesOperation,
  INTENT_CONFIG_SET_VALUES,
} from "../operations/config-set-values";
import type {
  ConfigSetValuesIntent,
  ConfigSetHookInput,
  ConfigSetHookResult,
} from "../operations/config-set-values";
import type { IntentModule } from "../intents/infrastructure/module";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { SetupError } from "../../services/errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { ApiCallHandlers } from "../../services/plugin-server/plugin-server";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import { INTENT_RESOLVE_WORKSPACE } from "../operations/resolve-workspace";

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

  async execute(ctx: OperationContext<Intent>): Promise<CheckDepsResult> {
    const { results } = await ctx.hooks.collect<CheckDepsResult>("check-deps", {
      intent: ctx.intent,
    });
    // Merge all results
    const merged: CheckDepsResult = {};
    for (const r of results) {
      if (r.missingBinaries) {
        (merged as Record<string, unknown>).missingBinaries = [
          ...((merged.missingBinaries as string[]) ?? []),
          ...r.missingBinaries,
        ];
      }
      if (r.missingExtensions) {
        (merged as Record<string, unknown>).missingExtensions = r.missingExtensions;
      }
      if (r.outdatedExtensions) {
        (merged as Record<string, unknown>).outdatedExtensions = r.outdatedExtensions;
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
    // Merge results
    const merged: StartHookResult = {};
    for (const r of results) {
      if (r.codeServerPort !== undefined) {
        (merged as Record<string, unknown>).codeServerPort = r.codeServerPort;
      }
    }
    return merged;
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

class MinimalExtensionsOperation implements Operation<Intent, void> {
  readonly id = SETUP_OPERATION_ID;
  private readonly hookInput: Partial<ExtensionsHookInput>;
  readonly report: ReturnType<typeof vi.fn>;

  constructor(hookInput: Partial<ExtensionsHookInput> = {}) {
    this.report = (hookInput.report as ReturnType<typeof vi.fn>) ?? vi.fn();
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("extensions", {
      intent: ctx.intent,
      report: this.report,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalFinalizeOperation implements Operation<OpenWorkspaceIntent, FinalizeHookResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<FinalizeHookInput>;

  constructor(hookInput: Partial<FinalizeHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<FinalizeHookResult> {
    const { results, errors } = await ctx.hooks.collect<FinalizeHookResult>("finalize", {
      intent: ctx.intent,
      workspacePath: "/test/project/.worktrees/feature-1",
      envVars: { OPENCODE_PORT: "8080" },
      agentType: "opencode" as const,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, DeleteHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<DeleteHookResult> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/projects/test",
      workspacePath: payload.workspacePath ?? "",
    };
    const { results, errors } = await ctx.hooks.collect<DeleteHookResult>("delete", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

/**
 * Minimal config module stub: handles the "set" hook and returns all input values
 * as changed, so ConfigSetValuesOperation emits config:updated events.
 */
function createMockConfigModule(): IntentModule {
  return {
    name: "mock-config",
    hooks: {
      [CONFIG_SET_VALUES_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<ConfigSetHookResult> => {
            const { values } = ctx as ConfigSetHookInput;
            return { changedValues: values };
          },
        },
      },
    },
  };
}

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(overrides?: Partial<CodeServerModuleDeps>): CodeServerModuleDeps {
  return {
    codeServerManager: {
      preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
      downloadBinary: vi.fn().mockResolvedValue(undefined),
      ensureRunning: vi.fn().mockResolvedValue(9090),
      port: vi.fn().mockReturnValue(9090),
      getConfig: vi.fn().mockReturnValue({
        runtimeDir: new Path("/runtime"),
        extensionsDir: new Path("/extensions"),
        userDataDir: new Path("/user-data"),
      }),
      setPluginPort: vi.fn(),
      setCodeServerVersion: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    extensionManager: {
      preflight: vi.fn().mockResolvedValue({
        success: true,
        needsInstall: false,
        missingExtensions: [],
        outdatedExtensions: [],
      }),
      install: vi.fn().mockResolvedValue(undefined),
      cleanOutdated: vi.fn().mockResolvedValue(undefined),
      setCodeServerBinaryPath: vi.fn(),
    },
    pluginServer: {
      start: vi.fn().mockResolvedValue(3456),
      close: vi.fn().mockResolvedValue(undefined),
      setWorkspaceConfig: vi.fn(),
      removeWorkspaceConfig: vi.fn(),
      onApiCall: vi.fn(),
      sendCommand: vi.fn(),
    },
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    workspaceFileService: {
      ensureWorkspaceFile: vi
        .fn()
        .mockResolvedValue(new Path("/test/project/.worktrees/feature-1.code-workspace")),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      createWorkspaceFile: vi.fn(),
      getWorkspaceFilePath: vi.fn(),
    } as unknown as CodeServerModuleDeps["workspaceFileService"],
    pathProvider: {
      bundlePath: vi.fn().mockImplementation((subpath: string) => {
        return new Path(`/bundles/${subpath}`);
      }),
    },
    platform: "linux",
    arch: "x64",
    dispatcher: { dispatch: vi.fn() } as unknown as CodeServerModuleDeps["dispatcher"],
    wrapperPath: "/path/to/wrapper",
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDeps?: CodeServerModuleDeps) {
  const deps = mockDeps ?? createMockDeps();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const module = createCodeServerModule(deps);

  dispatcher.registerModule(module);

  return { deps, dispatcher, hookRegistry };
}

// =============================================================================
// Tests
// =============================================================================

describe("CodeServerModule", () => {
  // ---------------------------------------------------------------------------
  // before-ready
  // ---------------------------------------------------------------------------

  describe("before-ready", () => {
    it("declares code-server wrapper scripts", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalBeforeReadyOperation());

      const results = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as ConfigureResult[];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ scripts: ["code", "code.cmd"] });
    });
  });

  // ---------------------------------------------------------------------------
  // check-deps
  // ---------------------------------------------------------------------------

  describe("check-deps", () => {
    it("returns code-server in missingBinaries when download needed", async () => {
      const deps = createMockDeps();
      (deps.codeServerManager.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        needsDownload: true,
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("code-server");
    });

    it("returns empty missingBinaries when up-to-date", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).not.toContain("code-server");
    });

    it("returns missing extensions when extensions need install", async () => {
      const deps = createMockDeps();
      (deps.extensionManager.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        needsInstall: true,
        missingExtensions: ["ext.one"],
        outdatedExtensions: ["ext.two"],
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingExtensions).toEqual(["ext.one"]);
      expect(result.outdatedExtensions).toEqual(["ext.two"]);
    });

    it("returns empty extensions when preflight fails (graceful)", async () => {
      const deps = createMockDeps();
      (deps.extensionManager.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { type: "preflight-failed", message: "disk error" },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingExtensions).toBeUndefined();
      expect(result.outdatedExtensions).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("starts PluginServer and code-server, returns port", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      expect(result.codeServerPort).toBe(9090);
      expect(deps.pluginServer!.start).toHaveBeenCalled();
      expect(deps.codeServerManager.ensureRunning).toHaveBeenCalled();
    });

    it("ensures required directories exist", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.fileSystemLayer.mkdir).toHaveBeenCalledTimes(3);
    });

    it("does not call setWorkspaceConfig during start (config pushed during finalize)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.pluginServer!.setWorkspaceConfig).not.toHaveBeenCalled();
    });

    it("sets plugin port on CodeServerManager", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.codeServerManager.setPluginPort).toHaveBeenCalledWith(3456);
    });

    it("degrades gracefully when PluginServer fails", async () => {
      const deps = createMockDeps({
        pluginServer: {
          start: vi.fn().mockRejectedValue(new Error("bind failed")),
          close: vi.fn().mockResolvedValue(undefined),
          setWorkspaceConfig: vi.fn(),
          removeWorkspaceConfig: vi.fn(),
          onApiCall: vi.fn(),
          sendCommand: vi.fn(),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      // code-server should still start
      expect(result.codeServerPort).toBe(9090);
      expect(deps.codeServerManager.ensureRunning).toHaveBeenCalled();
    });

    it("works with null PluginServer", async () => {
      const deps = createMockDeps({ pluginServer: null });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      expect(result.codeServerPort).toBe(9090);
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("stops code-server then PluginServer", async () => {
      const callOrder: string[] = [];
      const deps = createMockDeps({
        codeServerManager: {
          ...createMockDeps().codeServerManager,
          stop: vi.fn().mockImplementation(async () => {
            callOrder.push("cs-stop");
          }),
        },
        pluginServer: {
          start: vi.fn().mockResolvedValue(3456),
          close: vi.fn().mockImplementation(async () => {
            callOrder.push("plugin-close");
          }),
          setWorkspaceConfig: vi.fn(),
          removeWorkspaceConfig: vi.fn(),
          onApiCall: vi.fn(),
          sendCommand: vi.fn(),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(callOrder).toEqual(["cs-stop", "plugin-close"]);
    });

    it("collect catches stop error, dispatch still resolves", async () => {
      const deps = createMockDeps({
        codeServerManager: {
          ...createMockDeps().codeServerManager,
          stop: vi.fn().mockRejectedValue(new Error("stop failed")),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      // Handler throws directly, but collect() catches the error
      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    it("downloads code-server when missing", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.codeServerManager.downloadBinary).toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("vscode", "done");
    });

    it("skips download when not missing", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: [] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.codeServerManager.downloadBinary).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("vscode", "done");
    });

    it("reports progress during download", async () => {
      const deps = createMockDeps();
      (deps.codeServerManager.downloadBinary as ReturnType<typeof vi.fn>).mockImplementation(
        async (cb: (p: { phase: string; bytesDownloaded: number; totalBytes: number }) => void) => {
          cb({ phase: "downloading", bytesDownloaded: 50, totalBytes: 100 });
          cb({ phase: "extracting", bytesDownloaded: 100, totalBytes: 100 });
        }
      );
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(op.report).toHaveBeenCalledWith("vscode", "running", "Downloading...", undefined, 50);
      expect(op.report).toHaveBeenCalledWith("vscode", "running", "Extracting...");
    });

    it("throws SetupError on download failure", async () => {
      const deps = createMockDeps();
      (deps.codeServerManager.downloadBinary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error")
      );
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith("vscode", "failed", undefined, "network error");
    });
  });

  // ---------------------------------------------------------------------------
  // extensions install
  // ---------------------------------------------------------------------------

  describe("extensions install", () => {
    it("installs missing extensions", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation({ missingExtensions: ["ext.one"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.extensionManager.install).toHaveBeenCalledWith(["ext.one"], expect.any(Function));
      expect(op.report).toHaveBeenCalledWith("setup", "done");
    });

    it("cleans and reinstalls outdated extensions", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation({ outdatedExtensions: ["ext.old"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.extensionManager.cleanOutdated).toHaveBeenCalledWith(["ext.old"]);
      expect(deps.extensionManager.install).toHaveBeenCalledWith(["ext.old"], expect.any(Function));
    });

    it("skips when no extensions need install", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation();
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.extensionManager.install).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("setup", "done");
    });

    it("throws SetupError on install failure", async () => {
      const deps = createMockDeps();
      (deps.extensionManager.install as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("install failed")
      );
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation({ missingExtensions: ["ext.one"] });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith("setup", "failed", undefined, "install failed");
    });

    it("throws SetupError on clean failure", async () => {
      const deps = createMockDeps();
      (deps.extensionManager.cleanOutdated as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("clean failed")
      );
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation({ outdatedExtensions: ["ext.old"] });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
    });
  });

  // ---------------------------------------------------------------------------
  // finalize
  // ---------------------------------------------------------------------------

  describe("finalize", () => {
    it("creates workspace file and returns URL using port from start", async () => {
      const deps = createMockDeps();

      // Create single setup with both operations
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);

      // Register start operation and run it to set port
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now register finalize operation and test it
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as FinalizeHookResult;

      expect(result.workspaceUrl).toContain("9090");
      expect(result.workspaceUrl).toContain("workspace=");
      expect(deps.workspaceFileService.ensureWorkspaceFile).toHaveBeenCalledWith(
        new Path("/test/project/.worktrees/feature-1"),
        new Path("/test/project/.worktrees"),
        expect.objectContaining({
          "claudeCode.useTerminal": true,
          "claudeCode.claudeProcessWrapper": "/path/to/wrapper",
        })
      );
    });

    it("falls back to folder URL on workspace file error", async () => {
      const deps = createMockDeps({
        workspaceFileService: {
          ensureWorkspaceFile: vi.fn().mockRejectedValue(new Error("disk full")),
          deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
          createWorkspaceFile: vi.fn(),
          getWorkspaceFilePath: vi.fn(),
        } as unknown as CodeServerModuleDeps["workspaceFileService"],
      });

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);

      // Start to set port
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Finalize
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: {},
        })
      );

      const result = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as FinalizeHookResult;

      expect(result.workspaceUrl).toContain("9090");
      expect(result.workspaceUrl).toContain("folder=");
    });

    it("calls setWorkspaceConfig on PluginServer during finalize", async () => {
      const deps = createMockDeps();

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);

      // Start to set port
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Finalize with agentType
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent);

      expect(deps.pluginServer!.setWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        { OPENCODE_PORT: "8080" },
        "opencode",
        true
      );
    });

    it("passes resetWorkspace=false for existing (reopened) workspaces", async () => {
      const deps = createMockDeps();

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);

      // Start to set port
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Finalize with agentType
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
          existingWorkspace: {
            path: "/test/project/.worktrees/feature-1",
            name: "feature-1",
            branch: "feature-1",
            metadata: {},
          },
        },
      } as OpenWorkspaceIntent);

      expect(deps.pluginServer!.setWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        { OPENCODE_PORT: "8080" },
        "opencode",
        false
      );
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("deletes workspace file", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

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

      expect(deps.workspaceFileService.deleteWorkspaceFile).toHaveBeenCalledWith(
        "feature-1",
        new Path("/test/project/.worktrees")
      );
    });

    it("suppresses errors in force mode", async () => {
      const deps = createMockDeps({
        workspaceFileService: {
          ensureWorkspaceFile: vi.fn(),
          deleteWorkspaceFile: vi.fn().mockRejectedValue(new Error("permission denied")),
          createWorkspaceFile: vi.fn(),
          getWorkspaceFilePath: vi.fn(),
        } as unknown as CodeServerModuleDeps["workspaceFileService"],
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

      // Should not throw
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
      } as DeleteWorkspaceIntent)) as DeleteHookResult;

      expect(result).toEqual({});
    });

    it("throws on non-force error", async () => {
      const deps = createMockDeps({
        workspaceFileService: {
          ensureWorkspaceFile: vi.fn(),
          deleteWorkspaceFile: vi.fn().mockRejectedValue(new Error("permission denied")),
          createWorkspaceFile: vi.fn(),
          getWorkspaceFilePath: vi.fn(),
        } as unknown as CodeServerModuleDeps["workspaceFileService"],
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

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
      ).rejects.toThrow("permission denied");
    });

    it("calls removeWorkspaceConfig on PluginServer during delete", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

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

      expect(deps.pluginServer!.removeWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // config:updated event
  // ---------------------------------------------------------------------------

  describe("config:updated event", () => {
    it("propagates version override to managers", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createCodeServerModule(deps));
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "version.code-server": "4.200.0" }, persist: false },
      } as ConfigSetValuesIntent);

      expect(deps.codeServerManager.setCodeServerVersion).toHaveBeenCalledWith(
        expect.stringContaining("4.200.0"),
        expect.stringContaining("4.200.0"),
        expect.objectContaining({
          name: "code-server",
          url: expect.stringContaining("4.200.0"),
          destDir: expect.stringContaining("4.200.0"),
        })
      );
      expect(deps.extensionManager.setCodeServerBinaryPath).toHaveBeenCalledWith(
        expect.stringContaining("4.200.0")
      );
    });

    it("falls back to built-in version when config value is null", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createCodeServerModule(deps));
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "version.code-server": null }, persist: false },
      } as ConfigSetValuesIntent);

      // Should use built-in CODE_SERVER_VERSION, not "null"
      const call = (deps.codeServerManager.setCodeServerVersion as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call).toBeDefined();
      expect(call![0]).not.toContain("null");
      expect(call![1]).not.toContain("null");
    });

    it("does not propagate when version.code-server is not in changed values", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createCodeServerModule(deps));
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "claude" }, persist: false },
      } as ConfigSetValuesIntent);

      expect(deps.codeServerManager.setCodeServerVersion).not.toHaveBeenCalled();
      expect(deps.extensionManager.setCodeServerBinaryPath).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Plugin API handlers
  // ---------------------------------------------------------------------------

  describe("plugin API handlers", () => {
    const testWorkspacePath = "/home/user/.codehydra/workspaces/my-feature";

    /**
     * Helper: run the start hook to register handlers, then extract them from
     * the onApiCall mock. Returns the captured handlers and mock dispatcher.
     */
    async function setupPluginHandlers(
      resolveWith?: unknown,
      options?: { accepted?: boolean }
    ): Promise<{
      handlers: ApiCallHandlers;
      mockDispatch: ReturnType<typeof vi.fn>;
      deps: CodeServerModuleDeps;
    }> {
      const mockDispatch = vi.fn().mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(options?.accepted ?? true);
        if (resolveWith instanceof Error) {
          handle.reject(resolveWith);
        } else {
          handle.resolve(resolveWith);
        }
        return handle;
      });

      const deps = createMockDeps({
        dispatcher: { dispatch: mockDispatch } as unknown as CodeServerModuleDeps["dispatcher"],
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      // Dispatch app:start to trigger handler registration
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Extract registered handlers
      const onApiCallMock = deps.pluginServer!.onApiCall as ReturnType<typeof vi.fn>;
      expect(onApiCallMock).toHaveBeenCalledTimes(1);
      const handlers = onApiCallMock.mock.calls[0]![0] as ApiCallHandlers;

      return { handlers, mockDispatch, deps };
    }

    it("registers handlers on app:start when pluginServer is available", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.pluginServer!.onApiCall).toHaveBeenCalled();
    });

    it("getStatus dispatches correct intent", async () => {
      const status = { isDirty: false, unmergedCommits: 0, agent: { type: "none" as const } };
      const { handlers, mockDispatch } = await setupPluginHandlers(status);

      const result = await handlers.getStatus(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(status);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_WORKSPACE_STATUS,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("getAgentSession dispatches correct intent", async () => {
      const session = { port: 12345, sessionId: "ses-123" };
      const { handlers, mockDispatch } = await setupPluginHandlers(session);

      const result = await handlers.getAgentSession(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(session);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("restartAgentServer dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(14001);

      const result = await handlers.restartAgentServer(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(14001);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_RESTART_AGENT,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("getMetadata dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers({ base: "main" });

      const result = await handlers.getMetadata(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ base: "main" });
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_METADATA,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("setMetadata dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(undefined);

      const result = await handlers.setMetadata(testWorkspacePath, {
        key: "my-key",
        value: "my-value",
      });

      expect(result.success).toBe(true);
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_SET_METADATA,
          payload: { workspacePath: testWorkspacePath, key: "my-key", value: "my-value" },
        })
      );
    });

    it("delete returns started:true when accepted", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(undefined, { accepted: true });

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: true });
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_DELETE_WORKSPACE,
          payload: expect.objectContaining({
            workspacePath: testWorkspacePath,
            keepBranch: true,
            force: false,
            removeWorktree: true,
          }),
        })
      );
    });

    it("delete returns started:false when rejected by interceptor", async () => {
      const { handlers } = await setupPluginHandlers(undefined, { accepted: false });

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: false });
      }
    });

    it("executeCommand calls pluginServer.sendCommand directly", async () => {
      const { handlers, deps } = await setupPluginHandlers();
      vi.mocked(deps.pluginServer!.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: "command result",
      });

      const result = await handlers.executeCommand(testWorkspacePath, {
        command: "test.command",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("command result");
      }
      expect(deps.pluginServer!.sendCommand).toHaveBeenCalledWith(
        testWorkspacePath,
        "test.command",
        undefined
      );
    });

    it("create dispatches correct intent with optional fields", async () => {
      const workspace = {
        projectId: "proj-1",
        name: "my-ws",
        branch: "my-ws",
        metadata: {},
        path: "/workspaces/my-ws",
      };
      const resolvedProject = { projectPath: "/project/path", workspaceName: "caller-ws" };
      const { handlers, mockDispatch } = await setupPluginHandlers(workspace);
      // Mock: first dispatch (workspace:resolve) returns resolvedProject,
      // second dispatch (workspace:open) returns workspace
      mockDispatch.mockImplementation((intent: Intent) => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        if (intent.type === INTENT_RESOLVE_WORKSPACE) {
          handle.resolve(resolvedProject);
        } else {
          handle.resolve(workspace);
        }
        return handle;
      });

      const result = await handlers.create(testWorkspacePath, {
        name: "my-ws",
        base: "main",
        initialPrompt: "Do something",
        stealFocus: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(workspace);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_OPEN_WORKSPACE,
          payload: expect.objectContaining({
            projectPath: "/project/path",
            workspaceName: "my-ws",
            base: "main",
            initialPrompt: "Do something",
            stealFocus: false,
          }),
        })
      );
    });

    it("create does not include optional fields when undefined", async () => {
      const workspace = {
        projectId: "p",
        name: "ws",
        branch: "ws",
        metadata: {},
        path: "/ws",
      };
      const resolvedProject = { projectPath: "/project/path", workspaceName: "caller-ws" };
      const { handlers, mockDispatch } = await setupPluginHandlers(workspace);
      mockDispatch.mockImplementation((intent: Intent) => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        if (intent.type === INTENT_RESOLVE_WORKSPACE) {
          handle.resolve(resolvedProject);
        } else {
          handle.resolve(workspace);
        }
        return handle;
      });

      await handlers.create(testWorkspacePath, { name: "my-ws", base: "main" });

      // Second call is workspace:open (first is workspace:resolve)
      const dispatchedIntent = mockDispatch.mock.calls[1]![0];
      expect(dispatchedIntent.payload).not.toHaveProperty("initialPrompt");
      expect(dispatchedIntent.payload).not.toHaveProperty("stealFocus");
    });

    it("returns error result when dispatch throws", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers();
      mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.reject(new Error("Workspace not found"));
        return handle;
      });

      const result = await handlers.getStatus(testWorkspacePath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });
  });
});
