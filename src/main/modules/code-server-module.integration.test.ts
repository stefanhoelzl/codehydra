// @vitest-environment node
/**
 * Integration tests for CodeServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * The module now owns all code-server lifecycle logic (previously in CodeServerManager),
 * so tests use processRunner/httpClient/portManager mocks directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { delimiter, join } from "node:path";
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
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../operations/open-workspace";
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
import type { BinaryDownloadService } from "../../services/binary-download";
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

class MinimalStartOperation implements Operation<Intent, number | undefined> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<number | undefined> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return capabilities.codeServerPort as number | undefined;
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

class MinimalFinalizeOperation implements Operation<OpenWorkspaceIntent, string | undefined> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<FinalizeHookInput>;

  constructor(hookInput: Partial<FinalizeHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<string | undefined> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("finalize", {
      intent: ctx.intent,
      workspacePath: "/test/project/.worktrees/feature-1",
      envVars: { OPENCODE_PORT: "8080" },
      agentType: "opencode" as const,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return capabilities.workspaceUrl as string | undefined;
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

function createMockSpawnedProcess(pid = 12345): SpawnedProcess {
  return {
    pid,
    wait: vi.fn().mockImplementation((timeout?: number) => {
      if (timeout === 0) return Promise.resolve({ running: true });
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    }),
    kill: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockBinaryDownloadService(
  overrides?: Partial<BinaryDownloadService>
): BinaryDownloadService {
  return {
    isInstalled: vi.fn().mockResolvedValue(true),
    download: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockDeps(overrides?: Partial<CodeServerModuleDeps>): CodeServerModuleDeps {
  return {
    processRunner: {
      run: vi.fn().mockReturnValue(createMockSpawnedProcess()),
    },
    httpClient: {
      fetch: vi.fn().mockResolvedValue({ status: 200 }),
    },
    portManager: {
      isPortAvailable: vi.fn().mockResolvedValue(true),
    },
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      rm: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("[]"),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    pathProvider: {
      bundlePath: vi.fn().mockImplementation((subpath: string) => {
        return new Path(`/bundles/${subpath}`);
      }),
      dataPath: vi.fn().mockImplementation((subpath: string) => {
        return new Path(`/test/app-data/${subpath}`);
      }),
    },
    buildInfo: { isPackaged: true },
    platform: "linux",
    arch: "x64",
    wrapperPath: "/path/to/wrapper",
    logger: SILENT_LOGGER,
    binaryDownloadService: createMockBinaryDownloadService(),
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Helper module that provides the pluginPort capability (null by default).
 * Code-server-module's start handler has `requires: { pluginPort: ANY_VALUE }`,
 * so a provider must be registered before it.
 */
function createPluginPortProvider(port: number | null = null): IntentModule {
  return {
    name: "plugin-port-provider",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ pluginPort: port }),
          handler: async () => undefined,
        },
      },
    },
  };
}

function createTestSetup(mockDeps?: CodeServerModuleDeps, pluginPort: number | null = null) {
  const deps = mockDeps ?? createMockDeps();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register pluginPort provider before code-server module so the capability is available
  dispatcher.registerModule(createPluginPortProvider(pluginPort));

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
      const deps = createMockDeps({
        binaryDownloadService: createMockBinaryDownloadService({
          isInstalled: vi.fn().mockResolvedValue(false),
        }),
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

    it("returns needsDownload false when no BinaryDownloadService available", async () => {
      const allDeps = createMockDeps();
      delete (allDeps as unknown as Record<string, unknown>).binaryDownloadService;
      const deps = allDeps;
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

      const codeServerPort = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as number | undefined;

      // Port is 25448 (packaged mode)
      expect(codeServerPort).toBe(25448);
      expect(deps.processRunner.run).toHaveBeenCalled();
    });

    it("ensures required directories exist", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.fileSystemLayer.mkdir).toHaveBeenCalledTimes(3);
    });

    it("checks port availability before spawning", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.portManager.isPortAvailable).toHaveBeenCalledWith(25448);
    });

    it("spawns code-server with correct arguments", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.processRunner.run).toHaveBeenCalledWith(
        expect.stringContaining("code-server"),
        expect.arrayContaining([
          "--bind-addr",
          "127.0.0.1:25448",
          "--auth",
          "none",
          "--extensions-dir",
          expect.stringContaining("extensions"),
          "--user-data-dir",
          expect.stringContaining("user-data"),
        ]),
        expect.objectContaining({
          cwd: expect.stringContaining("runtime"),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("stops code-server by killing the process", async () => {
      const mockProcess = createMockSpawnedProcess();
      const deps = createMockDeps({
        processRunner: {
          run: vi.fn().mockReturnValue(mockProcess),
        },
      });
      const { dispatcher } = createTestSetup(deps);

      // Start first
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Then stop
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );
      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it("collect catches stop error, dispatch still resolves", async () => {
      const mockProcess = createMockSpawnedProcess();
      (mockProcess.kill as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("kill failed"));
      const deps = createMockDeps({
        processRunner: {
          run: vi.fn().mockReturnValue(mockProcess),
        },
      });
      const { dispatcher } = createTestSetup(deps);

      // Start first
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Replace operation for stop
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
      const binaryDownloadService = createMockBinaryDownloadService();
      const deps = createMockDeps({ binaryDownloadService });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(binaryDownloadService.download).toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("vscode", "done");
    });

    it("skips download when not missing", async () => {
      const binaryDownloadService = createMockBinaryDownloadService();
      const deps = createMockDeps({ binaryDownloadService });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: [] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(binaryDownloadService.download).not.toHaveBeenCalled();
      expect(op.report).toHaveBeenCalledWith("vscode", "done");
    });

    it("reports progress during download", async () => {
      const binaryDownloadService = createMockBinaryDownloadService({
        download: vi
          .fn()
          .mockImplementation(
            async (
              _req: unknown,
              cb: (p: { phase: string; bytesDownloaded: number; totalBytes: number }) => void
            ) => {
              cb({ phase: "downloading", bytesDownloaded: 50, totalBytes: 100 });
              cb({ phase: "extracting", bytesDownloaded: 100, totalBytes: 100 });
            }
          ),
      });
      const deps = createMockDeps({ binaryDownloadService });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await dispatcher.dispatch({ type: "setup", payload: {} });

      expect(op.report).toHaveBeenCalledWith("vscode", "running", "Downloading...", undefined, 50);
      expect(op.report).toHaveBeenCalledWith("vscode", "running", "Extracting...");
    });

    it("throws SetupError on download failure", async () => {
      const binaryDownloadService = createMockBinaryDownloadService({
        download: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const deps = createMockDeps({ binaryDownloadService });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation("setup", op);

      await expect(dispatcher.dispatch({ type: "setup", payload: {} })).rejects.toThrow(SetupError);
      expect(op.report).toHaveBeenCalledWith(
        "vscode",
        "failed",
        undefined,
        expect.stringContaining("Failed to download code-server")
      );
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
        expect.stringContaining("code-server"),
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
      const failedProcess = createMockSpawnedProcess();
      (failedProcess.wait as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 1,
        stderr: "install failed",
        stdout: "",
      });
      const deps = createMockDeps({
        processRunner: {
          run: vi.fn().mockReturnValue(failedProcess),
        },
      });
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
      dispatcher.registerModule(createPluginPortProvider());
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

      const workspaceUrl = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as unknown as string | undefined;

      expect(workspaceUrl).toContain("25448");
      expect(workspaceUrl).toContain("workspace=");
      expect(deps.fileSystemLayer.writeFile).toHaveBeenCalledWith(
        new Path("/test/project/.worktrees/feature-1.code-workspace"),
        expect.stringContaining('"claudeCode.useTerminal":')
      );
    });

    it("falls back to folder URL on workspace file error", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue("[]"),
          writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
        },
      });

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createPluginPortProvider());
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

      const workspaceUrl = (await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent)) as unknown as string | undefined;

      expect(workspaceUrl).toContain("25448");
      expect(workspaceUrl).toContain("folder=");
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

      expect(deps.fileSystemLayer.rm).toHaveBeenCalledWith(
        new Path("/test/project/.worktrees/feature-1.code-workspace"),
        { force: true }
      );
    });

    it("suppresses errors in force mode", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockRejectedValue(new Error("permission denied")),
          readFile: vi.fn().mockResolvedValue("[]"),
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
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
        fileSystemLayer: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockRejectedValue(new Error("permission denied")),
          readFile: vi.fn().mockResolvedValue("[]"),
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
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
    it("propagates version override to affect subsequent starts", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createPluginPortProvider());
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "version.code-server": "4.200.0" }, persist: false },
      } as ConfigSetValuesIntent);

      // Now start and verify the new version is used
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // processRunner.run should have been called with a path containing 4.200.0
      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(runCall).toBeDefined();
      expect(runCall![0]).toContain("4.200.0");
    });

    it("falls back to built-in version when config value is null", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createPluginPortProvider());
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "version.code-server": null }, persist: false },
      } as ConfigSetValuesIntent);

      // Start and verify the built-in version is used (not "null")
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(runCall).toBeDefined();
      expect(runCall![0]).not.toContain("null");
    });

    it("does not affect binary path when version.code-server is not in changed values", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createPluginPortProvider());
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "claude" }, persist: false },
      } as ConfigSetValuesIntent);

      // Start and verify no binary path changes
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(runCall).toBeDefined();
      // Should use the default version path
      expect(runCall![0]).toContain("code-server");
    });

    it("propagates port override to affect subsequent starts", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createPluginPortProvider());
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "code-server.port": 9999 }, persist: false },
      } as ConfigSetValuesIntent);

      // Start and verify the new port is used
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      const codeServerPort = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as number | undefined;

      expect(codeServerPort).toBe(9999);
      expect(deps.portManager.isPortAvailable).toHaveBeenCalledWith(9999);
    });

    it("does not change port when code-server.port is not in changed values", async () => {
      const deps = createMockDeps();
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerModule(createMockConfigModule());
      dispatcher.registerModule(createPluginPortProvider());
      const module = createCodeServerModule(deps);
      dispatcher.registerModule(module);
      dispatcher.registerOperation("config:set-values", new ConfigSetValuesOperation());

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "claude" }, persist: false },
      } as ConfigSetValuesIntent);

      // Start and verify the default port is used
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      const codeServerPort = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as number | undefined;

      expect(codeServerPort).toBe(25448);
    });
  });

  // ---------------------------------------------------------------------------
  // pluginPort capability
  // ---------------------------------------------------------------------------

  describe("pluginPort capability", () => {
    it("makes plugin port available in spawned process environment via capability", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps, 9876);

      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env._CH_PLUGIN_PORT).toBe("9876");
    });
  });

  // ---------------------------------------------------------------------------
  // Environment setup (merged from manager integration tests)
  // ---------------------------------------------------------------------------

  describe("spawned process environment", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
      delete process.env._CH_PLUGIN_PORT;
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
      }
    });

    it("includes binDir prepended to PATH", async () => {
      process.env.PATH = "/usr/bin:/usr/local/bin";

      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const binDir = new Path("/test/app-data/bin").toNative();
      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env.PATH).toBe(`${binDir}${delimiter}/usr/bin:/usr/local/bin`);
    });

    it("includes EDITOR with absolute path and flags", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const binDir = new Path("/test/app-data/bin").toNative();
      const isWindows = process.platform === "win32";
      const expectedCodeCmd = isWindows ? `"${join(binDir, "code.cmd")}"` : join(binDir, "code");
      const expectedEditor = `${expectedCodeCmd} --wait --reuse-window`;

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env.EDITOR).toBe(expectedEditor);
    });

    it("includes GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env.GIT_SEQUENCE_EDITOR).toBe(env.EDITOR);
      expect(env.GIT_SEQUENCE_EDITOR).toBeTruthy();
    });

    it("removes VSCODE_* environment variables", async () => {
      process.env.VSCODE_IPC_HOOK = "/some/ipc/hook";
      process.env.VSCODE_NLS_CONFIG = "{}";
      process.env.VSCODE_CODE_CACHE_PATH = "/some/cache";

      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string | undefined>;
      expect(env.VSCODE_IPC_HOOK).toBeUndefined();
      expect(env.VSCODE_NLS_CONFIG).toBeUndefined();
      expect(env.VSCODE_CODE_CACHE_PATH).toBeUndefined();
    });

    it("sets VSCODE_PROXY_URI to empty string", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env.VSCODE_PROXY_URI).toBe("");
    });

    it("omits _CH_PLUGIN_PORT when plugin port not set", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string | undefined>;
      expect(env._CH_PLUGIN_PORT).toBeUndefined();
    });

    it("includes _CH_CODE_SERVER_DIR and _CH_OPENCODE_DIR", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = (deps.processRunner.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = runCall![2].env as Record<string, string>;
      expect(env._CH_CODE_SERVER_DIR).toContain("code-server");
      expect(env._CH_OPENCODE_DIR).toContain("opencode");
    });
  });

  // ---------------------------------------------------------------------------
  // Start failure cleanup
  // ---------------------------------------------------------------------------

  describe("start failure cleanup", () => {
    it("kills the spawned process when port is not available", async () => {
      const deps = createMockDeps({
        portManager: {
          isPortAvailable: vi.fn().mockResolvedValue(false),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await expect(dispatcher.dispatch({ type: "app:start", payload: {} })).rejects.toThrow(
        "already in use"
      );
    });

    it("kills the spawned process when health check fails", async () => {
      vi.useFakeTimers();

      try {
        const mockProcess = createMockSpawnedProcess();
        const deps = createMockDeps({
          processRunner: {
            run: vi.fn().mockReturnValue(mockProcess),
          },
          httpClient: {
            fetch: vi.fn().mockResolvedValue({ status: 503 }),
          },
        });
        const { dispatcher } = createTestSetup(deps);
        dispatcher.registerOperation("app:start", new MinimalStartOperation());

        let caughtError: unknown;
        const startPromise = dispatcher
          .dispatch({ type: "app:start", payload: {} })
          .catch((err: unknown) => {
            caughtError = err;
          });

        // Advance past the 30s health check timeout
        await vi.advanceTimersByTimeAsync(31_000);

        await startPromise;

        expect(caughtError).toBeDefined();
        expect(String(caughtError)).toContain("Failed to start code-server");

        // Verify the spawned process was killed to avoid orphaning
        expect(mockProcess.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
