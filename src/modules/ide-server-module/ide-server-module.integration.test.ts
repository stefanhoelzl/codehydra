// @vitest-environment node
/**
 * Integration tests for CodeServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * The module now owns all code-server lifecycle logic (previously in CodeServerManager),
 * so tests use processRunner/httpClient/portManager mocks directly.
 */

import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The watcher shim's own behavior is covered in watcher-shim.integration.test.ts;
// here we only assert the download step wires it in (and gates it to Windows).
vi.mock("./watcher-shim", () => ({ applyWatcherShim: vi.fn().mockResolvedValue(1) }));
import { delimiter, join } from "node:path";

import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../../intents/lib/operation";
import type { IntentModule } from "../../intents/lib/module";
import { createMinimalOperation } from "../../intents/lib/operation.test-utils";
import { APP_START_OPERATION_ID, INTENT_APP_START } from "../../intents/app-start";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
} from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../../intents/app-shutdown";
import {
  AppResumeOperation,
  INTENT_APP_RESUME,
  EVENT_APP_RESUMED,
  EVENT_APP_RESUME_FAILED,
  EVENT_IDE_SERVER_RESTARTED,
} from "../../intents/app-resume";
import type { DomainEvent } from "../../intents/lib/types";
import { SETUP_OPERATION_ID, INTENT_SETUP } from "../../intents/setup";
import type {
  BinaryHookInput,
  ExtensionsHookInput,
  SetupProgressPayload,
} from "../../intents/setup";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../../intents/open-workspace";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../../intents/delete-workspace";
import { createIdeServerModule, type IdeServerModuleDeps } from "./ide-server-module";
import { applyWatcherShim } from "./watcher-shim";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import type { ExtensionRequirement, ExtensionInstallEntry } from "../../intents/app-start";
import type { DirEntry } from "../../boundaries/platform/filesystem";
import {
  createMockProcessRunner,
  type MockProcessRunner,
  type SpawnConfig,
} from "../../boundaries/platform/process.state-mock";
import { createArchiveExtractorMock } from "../../boundaries/platform/archive-extractor.state-mock";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { Path } from "../../utils/path/path";
import { FileSystemError, SetupError } from "../../shared/errors/service-errors";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Minimal Test Operations
// =============================================================================

const beforeReadySchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<readonly ConfigureResult[]>(),
} satisfies OperationSchemas;

class MinimalBeforeReadyOperation implements Operation<typeof beforeReadySchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = beforeReadySchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof beforeReadySchemas>>
  ): Promise<readonly ConfigureResult[]> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
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
} satisfies OperationSchemas;

class MinimalCheckDepsOperation implements Operation<typeof checkDepsSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = checkDepsSchemas;
  private readonly extensionRequirements: readonly ExtensionRequirement[];

  constructor(extensionRequirements: readonly ExtensionRequirement[] = []) {
    this.extensionRequirements = extensionRequirements;
  }

  async execute(
    ctx: OperationContext<IntentOf<typeof checkDepsSchemas>>
  ): Promise<CheckDepsResult> {
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

const startSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<number | undefined>(),
} satisfies OperationSchemas;

class MinimalStartOperation implements Operation<typeof startSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = startSchemas;

  async execute(ctx: OperationContext<IntentOf<typeof startSchemas>>): Promise<number | undefined> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return capabilities.codeServerPort as number | undefined;
  }
}

const binarySchemas = {
  type: INTENT_SETUP,
  payload: z.unknown(),
  result: z.custom<void>(),
} satisfies OperationSchemas;

class MinimalBinaryOperation implements Operation<typeof binarySchemas> {
  readonly id = SETUP_OPERATION_ID;
  readonly schemas = binarySchemas;
  private readonly hookInput: Partial<BinaryHookInput>;
  /** Progress frames yielded by the streaming binary handler. */
  readonly frames: SetupProgressPayload[] = [];

  constructor(hookInput: Partial<BinaryHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<IntentOf<typeof binarySchemas>>): Promise<void> {
    const { errors } = await ctx.hooks.collect(
      "binary",
      { intent: ctx.intent, ...this.hookInput },
      {
        onYield: (frame) => {
          this.frames.push(frame as SetupProgressPayload);
        },
      }
    );
    if (errors.length > 0) throw errors[0]!;
  }
}

const extensionsSchemas = {
  type: INTENT_SETUP,
  payload: z.unknown(),
  result: z.custom<void>(),
} satisfies OperationSchemas;

class MinimalExtensionsOperation implements Operation<typeof extensionsSchemas> {
  readonly id = SETUP_OPERATION_ID;
  readonly schemas = extensionsSchemas;
  private readonly hookInput: Partial<ExtensionsHookInput>;
  /** Progress frames yielded by the streaming extensions handler. */
  readonly frames: SetupProgressPayload[] = [];

  constructor(hookInput: Partial<ExtensionsHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<IntentOf<typeof extensionsSchemas>>): Promise<void> {
    const { errors } = await ctx.hooks.collect(
      "extensions",
      { intent: ctx.intent, ...this.hookInput },
      {
        onYield: (frame) => {
          this.frames.push(frame as SetupProgressPayload);
        },
      }
    );
    if (errors.length > 0) throw errors[0]!;
  }
}

const finalizeSchemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: z.unknown(),
  result: z.custom<string | undefined>(),
} satisfies OperationSchemas;

class MinimalFinalizeOperation implements Operation<typeof finalizeSchemas> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  readonly schemas = finalizeSchemas;
  private readonly hookInput: Partial<FinalizeHookInput>;

  constructor(hookInput: Partial<FinalizeHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(
    ctx: OperationContext<IntentOf<typeof finalizeSchemas>>
  ): Promise<string | undefined> {
    const { errors, results } = await ctx.hooks.collect<string>("finalize", {
      intent: ctx.intent,
      workspacePath: "/test/project/.worktrees/feature-1",
      envVars: { OPENCODE_PORT: "8080" },
      agentType: "opencode" as const,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
    return results[0];
  }
}

/** Runs the "delete" hook point with a canned delete-pipeline context. */
function createMinimalDeleteOperation() {
  return createMinimalOperation<DeleteHookResult>(
    DELETE_WORKSPACE_OPERATION_ID,
    INTENT_DELETE_WORKSPACE,
    "delete",
    {
      hookContext: (ctx): DeletePipelineHookInput => ({
        intent: ctx.intent,
        projectPath: "/projects/test",
        workspacePath: (ctx.intent as DeleteWorkspaceIntent).payload.workspacePath ?? "",
        workspaceName: "test-workspace" as WorkspaceName,
        active: false,
      }),
      defaultResult: {},
    }
  );
}

// =============================================================================
// Mock Factories
// =============================================================================

/**
 * Per-spawn configuration helper. By default, processes report exitCode 0
 * (clean exit), success on kill, and the standard test pid.
 */
/**
 * Default spawn config: process is healthy (still running) and accepts kill
 * cleanly. Tests that need an exited-with-error process override exitCode/
 * stderr explicitly.
 */
function defaultSpawnConfig(): SpawnConfig {
  return { pid: 12345, running: true, killResult: { success: true, reason: "SIGTERM" } };
}

/** Access deps.processRunner as the state-mock for behavioral assertions. */
function asMockRunner(deps: IdeServerModuleDeps): MockProcessRunner {
  return deps.processRunner as MockProcessRunner;
}

function createMockDeps(overrides?: Partial<IdeServerModuleDeps>): IdeServerModuleDeps {
  return {
    processRunner: createMockProcessRunner({ onSpawn: () => defaultSpawnConfig() }),
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
      writeFileBuffer: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      makeExecutable: vi.fn().mockResolvedValue(undefined),
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
    archiveExtractor: createArchiveExtractorMock(),
    configService: createMockConfig({ defaults: { "version.opencode": "1.0.223" } }),
    resolveOpencodeBundleDir: () => "/bundles/opencode/1.0.223",
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
          handler: async () => ({ provides: { pluginPort: port } }),
        },
      },
    },
  };
}

function createTestSetup(mockDeps?: IdeServerModuleDeps, pluginPort: number | null = null) {
  const deps = mockDeps ?? createMockDeps();
  const dispatcher = createMockDispatcher();

  // Register pluginPort provider before code-server module so the capability is available
  dispatcher.registerModule(createPluginPortProvider(pluginPort));

  const module = createIdeServerModule(deps);
  dispatcher.registerModule(module);

  return { deps, dispatcher };
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
      dispatcher.registerOperation(new MinimalBeforeReadyOperation());

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
      // isBinaryInstalled calls readdir(destDir) - throw ENOENT to simulate not installed
      (deps.fileSystemLayer.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new FileSystemError("ENOENT", "/bundles/code-server", "not found")
      );
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries).toContain("code-server");
    });

    it("returns empty missingBinaries when up-to-date", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalCheckDepsOperation());

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.missingBinaries ?? []).not.toContain("code-server");
    });

    it("returns needsDownload false when no ArchiveExtractor available", async () => {
      const allDeps = createMockDeps();
      delete (allDeps as unknown as Record<string, unknown>).archiveExtractor;
      const deps = allDeps;
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalCheckDepsOperation());

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
      dispatcher.registerOperation(new MinimalCheckDepsOperation(requirements));

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
      dispatcher.registerOperation(new MinimalCheckDepsOperation(requirements));

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
      dispatcher.registerOperation(new MinimalCheckDepsOperation(requirements));

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as CheckDepsResult;

      expect(result.extensionInstallPlan).toEqual([]);
    });

    it("returns empty install plan when no requirements provided", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalCheckDepsOperation([]));

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
      dispatcher.registerOperation(new MinimalStartOperation());

      const codeServerPort = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as number | undefined;

      // Port is 25448 (packaged mode)
      expect(codeServerPort).toBe(25448);
      expect(() => asMockRunner(deps).$.spawned(0)).not.toThrow();
    });

    it("ensures required directories exist", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.fileSystemLayer.mkdir).toHaveBeenCalledTimes(3);
    });

    it("checks port availability before spawning", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.portManager.isPortAvailable).toHaveBeenCalledWith(25448);
    });

    it("spawns code-server with correct arguments", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(asMockRunner(deps)).toHaveSpawned([
        {
          command: expect.stringContaining("code-server") as string,
          args: expect.arrayContaining([
            "--bind-addr",
            "127.0.0.1:25448",
            "--auth",
            "none",
            "--extensions-dir",
            expect.stringContaining("extensions"),
            "--user-data-dir",
            expect.stringContaining("user-data"),
          ]) as unknown as string[],
          cwd: expect.stringContaining("runtime") as unknown as string,
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // IDE server selection (vscodium)
  // ---------------------------------------------------------------------------

  describe("IDE server selection", () => {
    function vscodiumDeps(): IdeServerModuleDeps {
      return createMockDeps({
        configService: createMockConfig({
          defaults: { "ide-server": "vscodium", "version.opencode": "1.0.223" },
        }),
      });
    }

    it("spawns codium-server with reh-web arguments on the vscodium port", async () => {
      const deps = vscodiumDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.portManager.isPortAvailable).toHaveBeenCalledWith(25449);
      expect(asMockRunner(deps)).toHaveSpawned([
        {
          command: expect.stringContaining("codium-server") as string,
          args: expect.arrayContaining([
            "--host",
            "127.0.0.1",
            "--port",
            "25449",
            "--without-connection-token",
            "--accept-server-license-terms",
            "--telemetry-level",
            "off",
          ]) as unknown as string[],
          cwd: expect.stringContaining("runtime") as unknown as string,
        },
      ]);
    });

    it("points the wrappers at the vscodium remote-cli and root-level node", async () => {
      const deps = vscodiumDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const env = asMockRunner(deps).$.spawned(0).$.env as Record<string, string>;
      expect(env._CH_IDE_REMOTE_CLI).toContain("vscodium");
      expect(env._CH_IDE_REMOTE_CLI).toContain("bin/remote-cli/codium");
      expect(env._CH_IDE_NODE).toContain("vscodium");
      expect(env._CH_IDE_NODE).toMatch(/\/node$/);
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("stops code-server by killing the process", async () => {
      const processRunner = createMockProcessRunner({ onSpawn: () => defaultSpawnConfig() });
      const deps = createMockDeps({ processRunner });
      const { dispatcher } = createTestSetup(deps);

      // Start first
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Then stop
      dispatcher.registerOperation(
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
      );
      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(processRunner.$.spawned(0)).toHaveBeenKilled();
    });
  });

  // ---------------------------------------------------------------------------
  // binary download
  // ---------------------------------------------------------------------------

  describe("binary download", () => {
    /** Create a mock Response suitable for downloadBinary's streaming read. */
    function createMockFetchResponse(
      data: Uint8Array = new Uint8Array([1, 2, 3]),
      contentLength?: number
    ): Response {
      let read = false;
      return {
        ok: true,
        status: 200,
        headers: new Headers(
          contentLength !== undefined ? { "content-length": String(contentLength) } : {}
        ),
        body: {
          getReader: () => ({
            read: async () => {
              if (!read) {
                read = true;
                return { done: false, value: data };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      } as unknown as Response;
    }

    /** Create deps with additional fileSystemLayer methods needed by downloadBinary. */
    function createDownloadDeps(overrides?: Partial<IdeServerModuleDeps>): IdeServerModuleDeps {
      const base = createMockDeps(overrides);
      // Add methods that downloadBinary needs but createMockDeps doesn't provide
      const fs = base.fileSystemLayer as Record<string, unknown>;
      if (!fs.writeFileBuffer) fs.writeFileBuffer = vi.fn().mockResolvedValue(undefined);
      if (!fs.unlink) fs.unlink = vi.fn().mockResolvedValue(undefined);
      if (!fs.rename) fs.rename = vi.fn().mockResolvedValue(undefined);
      if (!fs.makeExecutable) fs.makeExecutable = vi.fn().mockResolvedValue(undefined);
      // httpClient.fetch must return a proper Response for downloadBinary
      if (!overrides?.httpClient) {
        (base.httpClient.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
          createMockFetchResponse()
        );
      }
      return base;
    }

    it("downloads code-server when missing", async () => {
      const archiveExtractor = createArchiveExtractorMock();
      const deps = createDownloadDeps({ archiveExtractor });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(archiveExtractor.$.extractions.length).toBeGreaterThan(0);
      expect(op.frames).toContainEqual({ id: "vscode", status: "done" });
    });

    it("skips download when not missing", async () => {
      const archiveExtractor = createArchiveExtractorMock();
      const deps = createDownloadDeps({ archiveExtractor });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: [] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(archiveExtractor).toHaveNoExtractions();
      expect(op.frames).toContainEqual({ id: "vscode", status: "done" });
    });

    it("reports progress during download", async () => {
      const archiveExtractor = createArchiveExtractorMock();
      const data = new Uint8Array(50);
      const deps = createDownloadDeps({
        archiveExtractor,
        httpClient: {
          fetch: vi.fn().mockResolvedValue(createMockFetchResponse(data, 100)),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(op.frames).toContainEqual({
        id: "vscode",
        status: "running",
        message: "Downloading...",
        progress: 50,
      });
      expect(op.frames).toContainEqual({
        id: "vscode",
        status: "running",
        message: "Extracting...",
      });
    });

    it("reports extraction progress on the vscode row", async () => {
      const archiveExtractor = createArchiveExtractorMock({
        defaultResult: {
          progressFrames: [
            [50, 100],
            [100, 100],
          ],
        },
      });
      const deps = createDownloadDeps({ archiveExtractor });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(op.frames).toContainEqual({
        id: "vscode",
        status: "running",
        message: "Extracting...",
        progress: 50,
      });
      expect(op.frames).toContainEqual({
        id: "vscode",
        status: "running",
        message: "Extracting...",
        progress: 100,
      });
    });

    it("throws SetupError on download failure", async () => {
      const archiveExtractor = createArchiveExtractorMock({
        defaultResult: { error: { message: "corrupt archive", code: "INVALID_ARCHIVE" } },
      });
      const deps = createDownloadDeps({ archiveExtractor });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await expect(dispatcher.dispatch({ type: INTENT_SETUP, payload: {} })).rejects.toThrow(
        SetupError
      );
      expect(op.frames).toContainEqual(
        expect.objectContaining({
          id: "vscode",
          status: "failed",
          error: expect.stringContaining("Failed to download code-server"),
        })
      );
    });

    it("applies the watcher shim to the downloaded bundle on Windows", async () => {
      vi.mocked(applyWatcherShim).mockClear();
      const deps = createDownloadDeps({
        platform: "win32",
        arch: "x64",
        archiveExtractor: createArchiveExtractorMock(),
      });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(applyWatcherShim).toHaveBeenCalledWith(
        expect.objectContaining({ fileSystemLayer: deps.fileSystemLayer }),
        expect.stringContaining("code-server")
      );
    });

    it("does not apply the watcher shim on non-Windows platforms", async () => {
      vi.mocked(applyWatcherShim).mockClear();
      const deps = createDownloadDeps({ archiveExtractor: createArchiveExtractorMock() });
      const { dispatcher } = createTestSetup(deps);
      const op = new MinimalBinaryOperation({ missingBinaries: ["code-server"] });
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(applyWatcherShim).not.toHaveBeenCalled();
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
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(asMockRunner(deps)).toHaveSpawned([
        {
          command: expect.stringContaining("code-server") as string,
          args: expect.arrayContaining([
            "--install-extension",
            "/path/ext-one.vsix",
          ]) as unknown as string[],
        },
      ]);
      expect(op.frames).toContainEqual({ id: "setup", status: "done" });
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
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

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
      dispatcher.registerOperation(op);

      await dispatcher.dispatch({ type: INTENT_SETUP, payload: {} });

      expect(() => asMockRunner(deps).$.spawned(0)).toThrow();
      expect(op.frames).toContainEqual({ id: "setup", status: "done" });
    });

    it("throws SetupError on install failure", async () => {
      // Process exits with non-zero — explicitly clear `running` so wait()
      // reports the exit result instead of "still alive".
      const deps = createMockDeps({
        processRunner: createMockProcessRunner({
          onSpawn: () => ({
            pid: 12345,
            exitCode: 1,
            stderr: "install failed",
            killResult: { success: true, reason: "SIGTERM" },
          }),
        }),
      });
      const { dispatcher } = createTestSetup(deps);
      const installPlan: ExtensionInstallEntry[] = [
        { id: "ext.one", vsixPath: "/path/ext-one.vsix" },
      ];
      const op = new MinimalExtensionsOperation({ extensionInstallPlan: installPlan });
      dispatcher.registerOperation(op);

      await expect(dispatcher.dispatch({ type: INTENT_SETUP, payload: {} })).rejects.toThrow(
        SetupError
      );
      expect(op.frames).toContainEqual(
        expect.objectContaining({
          id: "setup",
          status: "failed",
          error: expect.stringContaining("Failed to install extension"),
        })
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
      const dispatcher = createMockDispatcher();
      dispatcher.registerModule(createPluginPortProvider());
      const module = createIdeServerModule(deps);
      dispatcher.registerModule(module);

      // Register start operation and run it to set port
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Now register finalize operation and test it
      dispatcher.registerOperation(
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
      const writeCall = vi
        .mocked(deps.fileSystemLayer.writeFile)
        .mock.calls.find(
          ([p]) => p.toString() === "/test/project/.worktrees/feature-1.code-workspace"
        );
      expect(writeCall).toBeDefined();
      const written = writeCall![1] as string;
      expect(written).toContain('"chat.agent.enabled": false');
    });

    it("falls back to folder URL on workspace file error", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          readdir: vi.fn().mockResolvedValue([]),
          rm: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockResolvedValue("[]"),
          writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
          writeFileBuffer: vi.fn().mockResolvedValue(undefined),
          unlink: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockResolvedValue(undefined),
          makeExecutable: vi.fn().mockResolvedValue(undefined),
        },
      });

      const dispatcher = createMockDispatcher();
      dispatcher.registerModule(createPluginPortProvider());
      const module = createIdeServerModule(deps);
      dispatcher.registerModule(module);

      // Start to set port
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Finalize
      dispatcher.registerOperation(
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
      dispatcher.registerOperation(createMinimalDeleteOperation());

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
          writeFileBuffer: vi.fn().mockResolvedValue(undefined),
          unlink: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockResolvedValue(undefined),
          makeExecutable: vi.fn().mockResolvedValue(undefined),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalDeleteOperation());

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
          writeFileBuffer: vi.fn().mockResolvedValue(undefined),
          unlink: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockResolvedValue(undefined),
          makeExecutable: vi.fn().mockResolvedValue(undefined),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalDeleteOperation());

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
  // pluginPort capability
  // ---------------------------------------------------------------------------

  describe("pluginPort capability", () => {
    it("makes plugin port available in spawned process environment via capability", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps, 9876);

      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
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
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const binDir = new Path("/test/app-data/bin").toNative();
      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
      expect(env.PATH).toBe(`${binDir}${delimiter}/usr/bin:/usr/local/bin`);
    });

    it("includes EDITOR with absolute path and flags", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const binDir = new Path("/test/app-data/bin").toNative();
      const isWindows = process.platform === "win32";
      const expectedCodeCmd = isWindows ? `"${join(binDir, "code.cmd")}"` : join(binDir, "code");
      const expectedEditor = `${expectedCodeCmd} --wait --reuse-window`;

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
      expect(env.EDITOR).toBe(expectedEditor);
    });

    it("includes GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
      expect(env.GIT_SEQUENCE_EDITOR).toBe(env.EDITOR);
      expect(env.GIT_SEQUENCE_EDITOR).toBeTruthy();
    });

    it("removes VSCODE_* environment variables", async () => {
      process.env.VSCODE_IPC_HOOK = "/some/ipc/hook";
      process.env.VSCODE_NLS_CONFIG = "{}";
      process.env.VSCODE_CODE_CACHE_PATH = "/some/cache";

      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string | undefined>;
      expect(env.VSCODE_IPC_HOOK).toBeUndefined();
      expect(env.VSCODE_NLS_CONFIG).toBeUndefined();
      expect(env.VSCODE_CODE_CACHE_PATH).toBeUndefined();
    });

    it("sets VSCODE_PROXY_URI to empty string", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
      expect(env.VSCODE_PROXY_URI).toBe("");
    });

    it("omits _CH_PLUGIN_PORT when plugin port not set", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string | undefined>;
      expect(env._CH_PLUGIN_PORT).toBeUndefined();
    });

    it("points the wrappers at the code-server remote-cli/node, plus opencode dir", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      const runCall = asMockRunner(deps).$.spawned(0).$;
      const env = runCall.env as Record<string, string>;
      expect(env._CH_IDE_REMOTE_CLI).toContain("lib/vscode/bin/remote-cli/code-linux.sh");
      expect(env._CH_IDE_NODE).toContain("code-server");
      expect(env._CH_IDE_NODE).toMatch(/\/lib\/node$/);
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
      dispatcher.registerOperation(new MinimalStartOperation());

      await expect(dispatcher.dispatch({ type: "app:start", payload: {} })).rejects.toThrow(
        "already in use"
      );
    });

    it("kills the spawned process when health check fails", async () => {
      vi.useFakeTimers();

      try {
        const processRunner = createMockProcessRunner({ onSpawn: () => defaultSpawnConfig() });
        const deps = createMockDeps({
          processRunner,
          httpClient: {
            fetch: vi.fn().mockResolvedValue({ status: 503 }),
          },
        });
        const { dispatcher } = createTestSetup(deps);
        dispatcher.registerOperation(new MinimalStartOperation());

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
        expect(processRunner.$.spawned(0)).toHaveBeenKilled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // app-resume: probe + restart
  // ---------------------------------------------------------------------------

  describe("app-resume probe + restart", () => {
    async function startCodeServer(
      deps: IdeServerModuleDeps
    ): Promise<{ dispatcher: ReturnType<typeof createTestSetup>["dispatcher"] }> {
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });
      dispatcher.registerOperation(new AppResumeOperation());
      return { dispatcher };
    }

    it("passes through without restart when /healthz succeeds", async () => {
      const deps = createMockDeps();
      const { dispatcher } = await startCodeServer(deps);

      const initialRunCount = asMockRunner(deps).$.spawnedCount;

      await dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });

      // No additional process spawned (no restart)
      expect(asMockRunner(deps).$.spawnedCount).toBe(initialRunCount);
    });

    it("restarts code-server when probe fails (unhealthy response)", async () => {
      vi.useFakeTimers();

      try {
        const deps = createMockDeps();
        const { dispatcher } = await startCodeServer(deps);

        const initialProcess = asMockRunner(deps).$.spawned(0);

        // Flip /healthz to 503 for the probe, then back to 200 for the restart
        const fetch = deps.httpClient.fetch as ReturnType<typeof vi.fn>;
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValueOnce({ status: 503 });
        fetch.mockResolvedValue({ status: 200 });

        const restartedEvents: DomainEvent[] = [];
        dispatcher.subscribe(EVENT_IDE_SERVER_RESTARTED, (e) => restartedEvents.push(e));

        const resumePromise = dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });

        // Drive the 5s probe timeout + any intervals
        await vi.advanceTimersByTimeAsync(6000);
        await resumePromise;

        // Old process killed, new process spawned
        expect(initialProcess).toHaveBeenKilled();
        expect(asMockRunner(deps).$.spawnedCount).toBe(2);
        // A successful restart signals the renderer to reload its frames
        expect(restartedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit ide-server:restarted when the restart fails", async () => {
      vi.useFakeTimers();

      try {
        const deps = createMockDeps();
        const { dispatcher } = await startCodeServer(deps);

        // Force probe to keep returning unhealthy
        (deps.httpClient.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 503 });
        // Force restart failure: next isPortAvailable returns false
        (deps.portManager.isPortAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

        const failureEvents: DomainEvent[] = [];
        const restartedEvents: DomainEvent[] = [];
        dispatcher.subscribe(EVENT_APP_RESUME_FAILED, (e) => failureEvents.push(e));
        dispatcher.subscribe(EVENT_IDE_SERVER_RESTARTED, (e) => restartedEvents.push(e));

        const resumePromise = dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });
        await vi.advanceTimersByTimeAsync(6000);
        await resumePromise;

        expect(failureEvents).toHaveLength(1);
        const payload = failureEvents[0]!.payload as { error: string };
        expect(payload.error).toContain("already in use");
        // No restart succeeded, so frames must not be told to reload
        expect(restartedEvents).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits app:resumed without restarting when healthy", async () => {
      const deps = createMockDeps();
      const { dispatcher } = await startCodeServer(deps);

      const resumedEvents: DomainEvent[] = [];
      const restartedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_APP_RESUMED, (e) => resumedEvents.push(e));
      dispatcher.subscribe(EVENT_IDE_SERVER_RESTARTED, (e) => restartedEvents.push(e));

      await dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });

      expect(resumedEvents).toHaveLength(1);
      // Healthy probe → no restart → no frame reload
      expect(restartedEvents).toHaveLength(0);
    });

    it("skips probe when code-server was never started", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(new AppResumeOperation());

      const fetchMock = deps.httpClient.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      await dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });

      // No /healthz called — currentPort is null
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
