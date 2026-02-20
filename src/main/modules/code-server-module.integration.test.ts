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
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type { CheckDepsResult, ConfigureResult, StartHookResult } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type {
  FinalizeHookInput,
  FinalizeHookResult,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../operations/delete-workspace";
import {
  createCodeServerModule,
  type CodeServerModuleDeps,
  type CodeServerLifecycleDeps,
  type CodeServerWorkspaceDeps,
} from "./code-server-module";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { SetupError } from "../../services/errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Minimal Test Operations
// =============================================================================

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

class MinimalStopOperation implements Operation<Intent, void> {
  readonly id = APP_SHUTDOWN_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect("stop", { intent: ctx.intent });
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

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLifecycleDeps(): CodeServerLifecycleDeps {
  return {
    pluginServer: {
      start: vi.fn().mockResolvedValue(3456),
      close: vi.fn().mockResolvedValue(undefined),
      setWorkspaceConfig: vi.fn(),
      removeWorkspaceConfig: vi.fn(),
    } as unknown as CodeServerLifecycleDeps["pluginServer"],
    codeServerManager: {
      ensureRunning: vi.fn().mockResolvedValue(9090),
      port: vi.fn().mockReturnValue(9090),
      getConfig: vi.fn().mockReturnValue({
        runtimeDir: new Path("/runtime"),
        extensionsDir: new Path("/extensions"),
        userDataDir: new Path("/user-data"),
      }),
      setPluginPort: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    onPortChanged: vi.fn(),
  };
}

function createMockWorkspaceDeps(): CodeServerWorkspaceDeps {
  return {
    workspaceFileService: {
      ensureWorkspaceFile: vi
        .fn()
        .mockResolvedValue(new Path("/test/project/.worktrees/feature-1.code-workspace")),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      createWorkspaceFile: vi.fn(),
      getWorkspaceFilePath: vi.fn(),
    },
    wrapperPath: "/path/to/wrapper",
  };
}

function createMockDeps(overrides?: {
  lifecycleDeps?: CodeServerLifecycleDeps;
  workspaceDeps?: CodeServerWorkspaceDeps;
}): CodeServerModuleDeps {
  const lifecycleDeps = overrides?.lifecycleDeps ?? createMockLifecycleDeps();
  const workspaceDeps = overrides?.workspaceDeps ?? createMockWorkspaceDeps();

  return {
    codeServerManager: {
      preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
      downloadBinary: vi.fn().mockResolvedValue(undefined),
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
    },
    logger: SILENT_LOGGER,
    getLifecycleDeps: () => lifecycleDeps,
    getWorkspaceDeps: () => workspaceDeps,
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

  wireModules([module], hookRegistry, dispatcher);

  return { deps, dispatcher, hookRegistry };
}

// =============================================================================
// Tests
// =============================================================================

describe("CodeServerModule", () => {
  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  describe("configure", () => {
    it("declares code-server wrapper scripts", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalConfigureOperation());

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
    it("starts PluginServer and code-server, updates port", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      expect(result.codeServerPort).toBe(9090);
      expect(lifecycleDeps.pluginServer!.start).toHaveBeenCalled();
      expect(lifecycleDeps.codeServerManager.ensureRunning).toHaveBeenCalled();
      expect(lifecycleDeps.onPortChanged).toHaveBeenCalledWith(9090);
    });

    it("ensures required directories exist", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(lifecycleDeps.fileSystemLayer.mkdir).toHaveBeenCalledTimes(3);
    });

    it("does not call setWorkspaceConfig during start (config pushed during finalize)", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(lifecycleDeps.pluginServer!.setWorkspaceConfig).not.toHaveBeenCalled();
    });

    it("sets plugin port on CodeServerManager", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(lifecycleDeps.codeServerManager.setPluginPort).toHaveBeenCalledWith(3456);
    });

    it("degrades gracefully when PluginServer fails", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      (lifecycleDeps.pluginServer!.start as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("bind failed")
      );
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      // code-server should still start
      expect(result.codeServerPort).toBe(9090);
      expect(lifecycleDeps.codeServerManager.ensureRunning).toHaveBeenCalled();
    });

    it("works with null PluginServer", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      (lifecycleDeps as unknown as Record<string, unknown>).pluginServer = null;
      const deps = createMockDeps({ lifecycleDeps });
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
      const lifecycleDeps = createMockLifecycleDeps();
      const callOrder: string[] = [];
      (lifecycleDeps.codeServerManager.stop as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          callOrder.push("cs-stop");
        }
      );
      (lifecycleDeps.pluginServer!.close as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          callOrder.push("plugin-close");
        }
      );
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(callOrder).toEqual(["cs-stop", "plugin-close"]);
    });

    it("handles non-fatal stop errors", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      (lifecycleDeps.codeServerManager.stop as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("stop failed")
      );
      const deps = createMockDeps({ lifecycleDeps });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:shutdown", new MinimalStopOperation());

      // Should not throw
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
      // Create deps that will be shared
      const lifecycleDeps = createMockLifecycleDeps();
      const workspaceDeps = createMockWorkspaceDeps();
      const deps = createMockDeps({ lifecycleDeps, workspaceDeps });

      // Create single setup with both operations
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      wireModules([module], hookRegistry, dispatcher);

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
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as FinalizeHookResult;

      expect(result.workspaceUrl).toContain("9090");
      expect(result.workspaceUrl).toContain("workspace=");
      expect(workspaceDeps.workspaceFileService.ensureWorkspaceFile).toHaveBeenCalledWith(
        new Path("/test/project/.worktrees/feature-1"),
        new Path("/test/project/.worktrees"),
        expect.objectContaining({
          "claudeCode.useTerminal": true,
          "claudeCode.claudeProcessWrapper": "/path/to/wrapper",
        })
      );
    });

    it("falls back to folder URL on workspace file error", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const workspaceDeps = createMockWorkspaceDeps();
      (
        workspaceDeps.workspaceFileService.ensureWorkspaceFile as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("disk full"));
      const deps = createMockDeps({ lifecycleDeps, workspaceDeps });

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      wireModules([module], hookRegistry, dispatcher);

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
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as FinalizeHookResult;

      expect(result.workspaceUrl).toContain("9090");
      expect(result.workspaceUrl).toContain("folder=");
    });

    it("calls setWorkspaceConfig on PluginServer during finalize", async () => {
      const lifecycleDeps = createMockLifecycleDeps();
      const workspaceDeps = createMockWorkspaceDeps();
      const deps = createMockDeps({ lifecycleDeps, workspaceDeps });

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const module = createCodeServerModule(deps);
      wireModules([module], hookRegistry, dispatcher);

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
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent);

      expect(lifecycleDeps.pluginServer!.setWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        { OPENCODE_PORT: "8080" },
        "opencode"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("deletes workspace file", async () => {
      const workspaceDeps = createMockWorkspaceDeps();
      const deps = createMockDeps({ workspaceDeps });
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

      expect(workspaceDeps.workspaceFileService.deleteWorkspaceFile).toHaveBeenCalledWith(
        "feature-1",
        new Path("/test/project/.worktrees")
      );
    });

    it("suppresses errors in force mode", async () => {
      const workspaceDeps = createMockWorkspaceDeps();
      (
        workspaceDeps.workspaceFileService.deleteWorkspaceFile as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("permission denied"));
      const deps = createMockDeps({ workspaceDeps });
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
      const workspaceDeps = createMockWorkspaceDeps();
      (
        workspaceDeps.workspaceFileService.deleteWorkspaceFile as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("permission denied"));
      const deps = createMockDeps({ workspaceDeps });
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
      const lifecycleDeps = createMockLifecycleDeps();
      const workspaceDeps = createMockWorkspaceDeps();
      const deps = createMockDeps({ lifecycleDeps, workspaceDeps });
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

      expect(lifecycleDeps.pluginServer!.removeWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1"
      );
    });
  });
});
