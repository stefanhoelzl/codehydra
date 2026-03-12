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

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  StartHookResult,
} from "../operations/app-start";
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
import type {
  ExtensionRequirement,
  ExtensionInstallEntry,
} from "../../services/vscode-setup/types";
import type { DirEntry } from "../../services/platform/filesystem";
import type { SpawnedProcess } from "../../services/platform/process";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { SetupError } from "../../services/errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

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
  private readonly extensionRequirements: readonly ExtensionRequirement[];

  constructor(extensionRequirements: readonly ExtensionRequirement[] = []) {
    this.extensionRequirements = extensionRequirements;
  }

  async execute(ctx: OperationContext<Intent>): Promise<CheckDepsResult> {
    const hookCtx: CheckDepsHookContext = {
      intent: ctx.intent,
      configuredAgent: "claude",
      extensionRequirements: this.extensionRequirements,
    };
    const { results } = await ctx.hooks.collect<CheckDepsResult>("check-deps", hookCtx);
    // Merge all results
    const merged: CheckDepsResult = {};
    for (const r of results) {
      if (r.missingBinaries) {
        (merged as Record<string, unknown>).missingBinaries = [
          ...((merged.missingBinaries as string[]) ?? []),
          ...r.missingBinaries,
        ];
      }
      if (r.extensionInstallPlan) {
        (merged as Record<string, unknown>).extensionInstallPlan = [
          ...((merged.extensionInstallPlan as ExtensionInstallEntry[]) ?? []),
          ...r.extensionInstallPlan,
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

function createMockProcess(exitCode = 0, stderr = ""): SpawnedProcess {
  return {
    wait: vi.fn().mockResolvedValue({ exitCode, stderr, stdout: "" }),
    kill: vi.fn(),
    pid: 12345,
  };
}

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
      setCodeServerVersion: vi.fn(),
      setPort: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    processRunner: {
      run: vi.fn().mockReturnValue(createMockProcess()),
    },
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      rm: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("[]"),
      writeFile: vi.fn().mockResolvedValue(undefined),
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
      dataPath: vi.fn().mockImplementation((subpath: string) => {
        return new Path(`/test/app-data/${subpath}`);
      }),
    },
    platform: "linux",
    arch: "x64",
    codeServerBinaryPath: "/test/code-server/bin/code-server",
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

    it("builds install plan for missing extensions", async () => {
      const deps = createMockDeps();
      // No extensions installed
      (deps.fileSystemLayer.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { dispatcher } = createTestSetup(deps);

      const requirements: ExtensionRequirement[] = [
        { id: "ext.one", version: "1.0.0", vsixPath: "/path/ext-one.vsix" },
        { id: "ext.two", version: "2.0.0", vsixPath: "/path/ext-two.vsix" },
      ];
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation(requirements));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.extensionInstallPlan).toEqual([
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
        { id: "ext.two", vsixPath: "/path/ext-two.vsix" },
      ]);
    });

    it("builds install plan for outdated extensions", async () => {
      const deps = createMockDeps();
      const installedEntries: DirEntry[] = [
        { name: "ext.one-0.9.0", isDirectory: true, isFile: false, isSymbolicLink: false },
      ];
      (deps.fileSystemLayer.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
        installedEntries
      );
      const { dispatcher } = createTestSetup(deps);

      const requirements: ExtensionRequirement[] = [
        { id: "ext.one", version: "1.0.0", vsixPath: "/path/ext-one.vsix" },
      ];
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation(requirements));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.extensionInstallPlan).toEqual([
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
      ]);
    });

    it("returns empty install plan when all extensions up-to-date", async () => {
      const deps = createMockDeps();
      const installedEntries: DirEntry[] = [
        { name: "ext.one-1.0.0", isDirectory: true, isFile: false, isSymbolicLink: false },
      ];
      (deps.fileSystemLayer.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
        installedEntries
      );
      const { dispatcher } = createTestSetup(deps);

      const requirements: ExtensionRequirement[] = [
        { id: "ext.one", version: "1.0.0", vsixPath: "/path/ext-one.vsix" },
      ];
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation(requirements));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.extensionInstallPlan).toEqual([]);
    });

    it("returns empty install plan when no requirements provided", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalCheckDepsOperation([]));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.extensionInstallPlan).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("starts code-server and returns port", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as StartHookResult;

      expect(result.codeServerPort).toBe(9090);
      expect(deps.codeServerManager.ensureRunning).toHaveBeenCalled();
    });

    it("ensures required directories exist", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.fileSystemLayer.mkdir).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("stops code-server", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(deps.codeServerManager.stop).toHaveBeenCalled();
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
    it("installs extensions from install plan via processRunner", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const installPlan: ExtensionInstallEntry[] = [
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
      ];
      const op = new MinimalExtensionsOperation({ extensionInstallPlan: installPlan });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.processRunner.run).toHaveBeenCalledWith(
        "/test/code-server/bin/code-server",
        expect.arrayContaining(["--install-extension", "/path/ext-one.vsix"])
      );
      expect(op.report).toHaveBeenCalledWith("setup", "done");
    });

    it("removes old extension dir before reinstalling", async () => {
      const deps = createMockDeps();
      // Simulate installed old version
      const installedEntries: DirEntry[] = [
        { name: "ext.one-0.9.0", isDirectory: true, isFile: false, isSymbolicLink: false },
      ];
      (deps.fileSystemLayer.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
        installedEntries
      );
      const { dispatcher } = createTestSetup(deps);

      const installPlan: ExtensionInstallEntry[] = [
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
      ];
      const op = new MinimalExtensionsOperation({ extensionInstallPlan: installPlan });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      // Should remove old directory
      expect(deps.fileSystemLayer.rm).toHaveBeenCalledWith(
        expect.objectContaining({ toString: expect.any(Function) }),
        { recursive: true, force: true }
      );
    });

    it("skips when no extensions need install", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalExtensionsOperation();
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(deps.processRunner.run).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("setup", "done");
    });

    it("throws SetupError on install failure", async () => {
      const deps = createMockDeps();
      (deps.processRunner.run as ReturnType<typeof vi.fn>).mockReturnValue(
        createMockProcess(1, "install failed")
      );
      const { dispatcher } = createTestSetup(deps);
      const installPlan: ExtensionInstallEntry[] = [
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
      ];
      const op = new MinimalExtensionsOperation({ extensionInstallPlan: installPlan });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith(
        "setup",
        "failed",
        undefined,
        expect.stringContaining("Failed to install extension")
      );
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
  });

  // ---------------------------------------------------------------------------
  // config:updated event
  // ---------------------------------------------------------------------------

  describe("config:updated event", () => {
    it("propagates version override to code-server manager", async () => {
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
    });

    it("propagates port override to manager", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createCodeServerModule(deps));
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "code-server.port": 9999 }, persist: false },
      } as ConfigSetValuesIntent);

      expect(deps.codeServerManager.setPort).toHaveBeenCalledWith(9999);
    });

    it("propagates default port value to manager", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createCodeServerModule(deps));
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "code-server.port": 9090 }, persist: false },
      } as ConfigSetValuesIntent);

      expect(deps.codeServerManager.setPort).toHaveBeenCalledWith(9090);
    });

    it("does not call setPort when code-server.port is not in changed values", async () => {
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

      expect(deps.codeServerManager.setPort).not.toHaveBeenCalled();
    });
  });
});
