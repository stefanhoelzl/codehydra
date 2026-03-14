/**
 * CodeServerModule - Manages code-server lifecycle, extensions, and per-workspace files.
 *
 * Consolidates these concerns into a single extracted module:
 * - Binary preflight (code-server part)
 * - Extension preflight
 * - Binary download (code-server part)
 * - Extension install
 * - Code-server lifecycle (start/stop)
 * - Per-workspace file creation (finalize hook)
 * - Per-workspace file deletion (delete hook)
 *
 * Internal state: code-server port set by `start` hook, read by `finalize` hook.
 */

import { join, delimiter } from "node:path";

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { ProcessRunner, SpawnedProcess } from "../../services/platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../../services/platform/process";
import type { HttpClient, PortManager } from "../../services/platform/network";
import type { PathProvider } from "../../services/platform/path-provider";
import type { IWorkspaceFileService } from "../../services/vscode-workspace/types";
import type { Logger } from "../../services/logging/types";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { SupportedPlatform, SupportedArch } from "../../agents/types";
import type { BuildInfo } from "../../services/platform/build-info";
import type {
  BinaryDownloadService,
  DownloadProgressCallback,
  DownloadRequest,
} from "../../services/binary-download";
import type { BinaryType } from "../../services/vscode-setup/types";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  RegisterConfigResult,
} from "../operations/app-start";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import type { FinalizeHookInput } from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrlForVersion,
  getCodeServerSubPathForVersion,
  getCodeServerExecutablePath,
} from "../../services/code-server/setup-info";
import { OPENCODE_VERSION } from "../../agents/opencode/setup-info";
import {
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "../../services/vscode-setup/extension-utils";
import { Path } from "../../services/platform/path";
import { encodePathForUrl } from "../../services/platform/paths";
import { configString, configCustom } from "../../services/config/config-definition";
import { CodeServerError, SetupError, getErrorMessage } from "../../services/errors";
import { waitForHealthy } from "../../services/platform/health-check";

// =============================================================================
// Internal Types
// =============================================================================

/** State of the code-server instance. */
type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

/** Internal configuration for code-server instance. */
interface CodeServerConfig {
  port: number;
  binaryPath: string;
  readonly runtimeDir: string;
  readonly extensionsDir: string;
  readonly userDataDir: string;
  readonly binDir: string;
  pluginPort: number | undefined;
  codeServerDir: string;
  readonly opencodeDir: string;
}

// =============================================================================
// Port Helpers
// =============================================================================

/** Fixed port for production to maintain consistent origin for IndexedDB storage */
const CODE_SERVER_PORT = 25448;

/**
 * Determine the code-server port based on build info.
 * - Production: Fixed port (25448) for IndexedDB persistence
 * - Development: Port derived from git branch for consistency across restarts
 */
function getCodeServerPort(buildInfo: Pick<BuildInfo, "isPackaged" | "gitBranch">): number {
  if (buildInfo.isPackaged) {
    return CODE_SERVER_PORT;
  }
  const input = buildInfo.gitBranch ?? "development";
  return derivePortFromString(input);
}

/**
 * Derive a port number from a string using a simple hash.
 * Returns a port in the range 30000-65000 to avoid conflicts.
 */
function derivePortFromString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const PORT_RANGE_START = 30000;
  const PORT_RANGE_SIZE = 35000;
  return PORT_RANGE_START + Math.abs(hash % PORT_RANGE_SIZE);
}

// =============================================================================
// URL Helpers
// =============================================================================

/**
 * Normalize a path for use in code-server URLs.
 * Handles Windows path conversion and URL encoding.
 */
function normalizePathForUrl(path: string): string {
  let normalizedPath = path;
  if (/^[A-Za-z]:/.test(path)) {
    normalizedPath = "/" + path.replace(/\\/g, "/");
  }
  return encodePathForUrl(normalizedPath).replace(/%3A/g, ":");
}

/**
 * Generate URL for opening a folder in code-server.
 */
function urlForFolder(port: number, folderPath: string): string {
  const encodedPath = normalizePathForUrl(folderPath);
  return `http://127.0.0.1:${port}/?folder=${encodedPath}`;
}

/**
 * Generate URL for opening a .code-workspace file in code-server.
 */
function urlForWorkspace(port: number, workspaceFilePath: string): string {
  const encodedPath = normalizePathForUrl(workspaceFilePath);
  return `http://127.0.0.1:${port}/?workspace=${encodedPath}`;
}

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * All dependencies for CodeServerModule.
 */
export interface CodeServerModuleDeps {
  readonly processRunner: Pick<ProcessRunner, "run">;
  readonly httpClient: Pick<HttpClient, "fetch">;
  readonly portManager: Pick<PortManager, "isPortAvailable">;
  readonly fileSystemLayer: Pick<
    FileSystemLayer,
    "mkdir" | "readdir" | "rm" | "readFile" | "writeFile"
  >;
  readonly workspaceFileService: IWorkspaceFileService;
  readonly pathProvider: Pick<PathProvider, "bundlePath" | "dataPath">;
  readonly buildInfo: Pick<BuildInfo, "isPackaged" | "gitBranch">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly wrapperPath: string;
  readonly logger: Logger;
  readonly binaryDownloadService?: BinaryDownloadService;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a CodeServerModule that manages code-server lifecycle, extensions,
 * and per-workspace .code-workspace files.
 *
 * Returns the intent module plus a setPluginPort function for external callers.
 */
export function createCodeServerModule(deps: CodeServerModuleDeps): {
  module: IntentModule;
  setPluginPort: (port: number) => void;
} {
  const { processRunner, fileSystemLayer, logger } = deps;

  // -------------------------------------------------------------------------
  // Compute config from deps
  // -------------------------------------------------------------------------

  const config: CodeServerConfig = {
    port: getCodeServerPort(deps.buildInfo),
    binaryPath: new Path(
      deps.pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`),
      getCodeServerExecutablePath(deps.platform)
    ).toNative(),
    runtimeDir: deps.pathProvider.dataPath("runtime").toNative(),
    extensionsDir: deps.pathProvider.dataPath("vscode/extensions").toNative(),
    userDataDir: deps.pathProvider.dataPath("vscode/user-data").toNative(),
    binDir: deps.pathProvider.dataPath("bin").toNative(),
    pluginPort: undefined,
    codeServerDir: deps.pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toNative(),
    opencodeDir: deps.pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative(),
  };

  // -------------------------------------------------------------------------
  // Binary download state
  // -------------------------------------------------------------------------

  let binaryDownload: { service: BinaryDownloadService; request: DownloadRequest } | null =
    deps.binaryDownloadService
      ? {
          service: deps.binaryDownloadService,
          request: {
            name: "code-server" as const,
            url: getCodeServerUrlForVersion(CODE_SERVER_VERSION, deps.platform, deps.arch),
            destDir: deps.pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toNative(),
            executablePath: getCodeServerExecutablePath(deps.platform),
            subPath: getCodeServerSubPathForVersion(CODE_SERVER_VERSION, deps.platform, deps.arch),
          },
        }
      : null;

  // -------------------------------------------------------------------------
  // Process lifecycle closure state
  // -------------------------------------------------------------------------

  let state: InstanceState = "stopped";
  let currentPort: number | null = null;
  let currentPid: number | null = null;
  let serverProcess: SpawnedProcess | null = null;
  let startPromise: Promise<number> | null = null;

  // Internal state: port set by start hook, read by finalize hook
  let codeServerPort = 0;
  // Binary path tracked in closure -- updated by config:updated events
  let codeServerBinaryPath = config.binaryPath;

  // -------------------------------------------------------------------------
  // Process lifecycle functions
  // -------------------------------------------------------------------------

  async function checkHealth(port: number): Promise<boolean> {
    if (!serverProcess || currentPid === null) {
      logger.warn("Health check failed: process not available");
      return false;
    }

    const processCheck = await serverProcess.wait(0);
    if (!processCheck.running) {
      logger.warn("Health check failed: process exited", {
        exitCode: processCheck.exitCode,
      });
      return false;
    }

    try {
      const response = await deps.httpClient.fetch(`http://127.0.0.1:${port}/healthz`, {
        timeout: 1000,
      });
      const healthy = response.status === 200;
      logger.debug("Health check", { status: healthy ? "ok" : "failed" });
      return healthy;
    } catch (error) {
      logger.silly("Health check failed", { error: getErrorMessage(error) });
      return false;
    }
  }

  async function waitForServerHealthy(port: number): Promise<void> {
    await waitForHealthy({
      checkFn: () => checkHealth(port),
      timeoutMs: 30000,
      intervalMs: 100,
      errorMessage: "Health check timed out after 30 seconds",
    });
  }

  async function doStart(): Promise<number> {
    logger.info("Starting code-server");

    const port = config.port;

    const portAvailable = await deps.portManager.isPortAvailable(port);
    if (!portAvailable) {
      throw new CodeServerError(
        `Port ${port} is already in use. Another code-server or application may be running on this port.`
      );
    }

    currentPort = port;

    const args = [
      "--bind-addr",
      `127.0.0.1:${port}`,
      "--auth",
      "none",
      "--disable-workspace-trust",
      "--disable-update-check",
      "--disable-telemetry",
      "--extensions-dir",
      config.extensionsDir,
      "--user-data-dir",
      config.userDataDir,
    ];

    try {
      // Create clean environment without VS Code/code-server variables
      const cleanEnv = { ...process.env };

      // Remove all VSCODE_* variables
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("VSCODE_")) {
          delete cleanEnv[key];
        }
      }

      // Prepend binDir to PATH
      const existingPath = cleanEnv.PATH ?? cleanEnv.Path ?? "";
      cleanEnv.PATH = config.binDir + delimiter + existingPath;
      delete cleanEnv.Path;

      // Set EDITOR and GIT_SEQUENCE_EDITOR
      const isWindows = process.platform === "win32";
      const codeCmd = isWindows
        ? `"${join(config.binDir, "code.cmd")}"`
        : join(config.binDir, "code");
      const editorValue = `${codeCmd} --wait --reuse-window`;
      cleanEnv.EDITOR = editorValue;
      cleanEnv.GIT_SEQUENCE_EDITOR = editorValue;

      // Disable code-server's localhost URL rewriting
      cleanEnv.VSCODE_PROXY_URI = "";

      // Set plugin port for VS Code extension communication
      if (config.pluginPort !== undefined) {
        cleanEnv._CH_PLUGIN_PORT = String(config.pluginPort);
      }

      // Set code-server and opencode directories for wrapper scripts
      cleanEnv._CH_CODE_SERVER_DIR = config.codeServerDir;
      cleanEnv._CH_OPENCODE_DIR = config.opencodeDir;

      serverProcess = processRunner.run(config.binaryPath, args, {
        cwd: config.runtimeDir,
        env: cleanEnv,
      });

      currentPid = serverProcess.pid ?? null;

      await waitForServerHealthy(port);

      logger.info("Started", { port, pid: currentPid ?? 0 });
      return port;
    } catch (error: unknown) {
      const proc = serverProcess;
      currentPort = null;
      currentPid = null;
      serverProcess = null;

      // Kill the orphaned process to release the port
      if (proc) {
        try {
          await proc.kill(PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS);
        } catch {
          logger.warn("Failed to kill code-server after start failure");
        }
      }

      const errorMsg = getErrorMessage(error);
      throw new CodeServerError(`Failed to start code-server: ${errorMsg}`);
    }
  }

  async function ensureRunning(): Promise<number> {
    if (state === "running" && currentPort !== null) {
      return currentPort;
    }

    if (state === "starting" && startPromise !== null) {
      return startPromise;
    }

    state = "starting";
    startPromise = doStart();

    try {
      const port = await startPromise;
      state = "running";
      return port;
    } catch (error: unknown) {
      state = "failed";
      startPromise = null;
      throw error;
    }
  }

  async function stop(): Promise<void> {
    const proc = serverProcess;
    const pid = currentPid;
    if (state === "stopped" || proc === null) {
      return;
    }

    logger.info("Stopping", { pid: pid ?? 0 });
    state = "stopping";

    try {
      const result = await proc.kill(
        PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
        PROCESS_KILL_FORCE_TIMEOUT_MS
      );

      if (!result.success) {
        logger.warn("Failed to kill code-server", { pid: pid ?? 0 });
      }

      logger.info("Stopped", {
        pid: pid ?? 0,
        success: result.success,
        reason: result.reason ?? "none",
      });
    } finally {
      state = "stopped";
      currentPort = null;
      currentPid = null;
      serverProcess = null;
      startPromise = null;
    }
  }

  async function preflight(): Promise<
    | { readonly success: true; readonly needsDownload: boolean }
    | {
        readonly success: false;
        readonly error: { readonly type: string; readonly message: string };
      }
  > {
    if (!binaryDownload) {
      return { success: true, needsDownload: false };
    }

    try {
      const isInstalled = await binaryDownload.service.isInstalled(binaryDownload.request.destDir);

      logger.debug("Code-server binary preflight", {
        isInstalled,
        needsDownload: !isInstalled,
      });

      return { success: true, needsDownload: !isInstalled };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Code-server binary preflight failed", { error: message });
      return {
        success: false,
        error: { type: "preflight-failed", message },
      };
    }
  }

  async function downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
    if (!binaryDownload) {
      throw new CodeServerError(
        "Cannot download code-server binary: BinaryDownloadService not available"
      );
    }

    logger.info("Downloading code-server binary");

    try {
      await binaryDownload.service.download(binaryDownload.request, onProgress);
      logger.info("Code-server binary download complete");
    } catch (error) {
      const message = getErrorMessage(error);
      throw new CodeServerError(`Failed to download code-server: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function setPluginPort(port: number): void {
    config.pluginPort = port;
  }

  /** Capability: workspaceUrl provided by finalize handler. */
  let capWorkspaceUrl: string | undefined;

  // -------------------------------------------------------------------------
  // Module definition
  // -------------------------------------------------------------------------

  const module: IntentModule = {
    name: "code-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        // -------------------------------------------------------------------
        // app-start -> register-config: declare version.code-server key
        // -------------------------------------------------------------------
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "version.code-server",
                default: null,
                description: "Code-server version override (null = built-in)",
                ...configString({ nullable: true }),
              },
              {
                name: "code-server.port",
                default: config.port,
                description: "Code-server port",
                ...configCustom<number>({
                  parse: (raw) => {
                    const n = Number(raw);
                    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : undefined;
                  },
                  validate: (v) =>
                    typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535
                      ? v
                      : undefined,
                  validValues: "1024-65535",
                }),
              },
            ],
          }),
        },

        // -------------------------------------------------------------------
        // app-start -> before-ready: declare required scripts
        // -------------------------------------------------------------------
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            return { scripts: ["code", "code.cmd"] };
          },
        },

        // -------------------------------------------------------------------
        // app-start -> check-deps: preflight code-server binary + extensions
        // -------------------------------------------------------------------
        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { extensionRequirements } = ctx as CheckDepsHookContext;
            const missingBinaries: BinaryType[] = [];

            // Check code-server binary
            const codeServerResult = await preflight();
            if (codeServerResult.success && codeServerResult.needsDownload) {
              missingBinaries.push("code-server");
            }

            // Compare requirements against installed extensions
            if (extensionRequirements.length === 0) {
              return { missingBinaries };
            }

            try {
              const extensionsDir = deps.pathProvider.dataPath("vscode/extensions");
              const installed = await listInstalledExtensions(fileSystemLayer, extensionsDir);
              const extensionInstallPlan = extensionRequirements
                .filter((req) => {
                  const installedVersion = installed.get(req.id);
                  return !installedVersion || installedVersion !== req.version;
                })
                .map((req) => ({ id: req.id, vsixPath: req.vsixPath }));

              logger.debug("Extension check completed", {
                installPlanCount: extensionInstallPlan.length,
              });

              return { missingBinaries, extensionInstallPlan };
            } catch (error) {
              logger.warn("Extension check failed", { error: getErrorMessage(error) });
              return { missingBinaries };
            }
          },
        },

        // -------------------------------------------------------------------
        // app-start -> start: start code-server, update port
        // -------------------------------------------------------------------
        start: {
          provides: () => ({ codeServerPort }),
          handler: async (): Promise<void> => {
            // Ensure required directories exist
            await Promise.all([
              fileSystemLayer.mkdir(config.runtimeDir),
              fileSystemLayer.mkdir(config.extensionsDir),
              fileSystemLayer.mkdir(config.userDataDir),
            ]);

            // Start code-server
            await ensureRunning();
            const port = currentPort!;

            // Update internal port (consumed by finalize hook for workspace URLs)
            codeServerPort = port;
          },
        },
      },

      // -------------------------------------------------------------------
      // app-shutdown -> stop: stop code-server
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await stop();
          },
        },
      },

      // -------------------------------------------------------------------
      // setup -> binary: download code-server if missing
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        binary: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];
            const { report } = hookCtx;

            if (missingBinaries.includes("code-server")) {
              report("vscode", "running", "Downloading...");
              try {
                await downloadBinary((p) => {
                  if (p.phase === "downloading" && p.totalBytes) {
                    const pct = Math.floor((p.bytesDownloaded / p.totalBytes) * 100);
                    report("vscode", "running", "Downloading...", undefined, pct);
                  } else if (p.phase === "extracting") {
                    report("vscode", "running", "Extracting...");
                  }
                });
                report("vscode", "done");
              } catch (error) {
                report("vscode", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to download code-server: ${getErrorMessage(error)}`,
                  "BINARY_DOWNLOAD_FAILED"
                );
              }
            } else {
              report("vscode", "done");
            }
          },
        },

        // -------------------------------------------------------------------
        // setup -> extensions: install extensions from install plan
        // -------------------------------------------------------------------
        extensions: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as ExtensionsHookInput;
            const installPlan = hookCtx.extensionInstallPlan ?? [];
            const { report } = hookCtx;

            if (installPlan.length === 0) {
              report("setup", "done");
              return;
            }

            report("setup", "running", "Installing extensions...");

            const extensionsDir = deps.pathProvider.dataPath("vscode/extensions");

            try {
              // Scan installed to find old dirs to remove
              const installed = await listInstalledExtensions(fileSystemLayer, extensionsDir);

              for (const entry of installPlan) {
                report("setup", "running", `Installing ${entry.id}...`);

                // Remove old directory if present
                const oldVersion = installed.get(entry.id);
                if (oldVersion) {
                  const oldDirName = `${entry.id}-${oldVersion}`;
                  const oldPath = new Path(extensionsDir, oldDirName);
                  logger.debug("Cleaning extension", {
                    extId: entry.id,
                    path: oldPath.toString(),
                  });
                  await fileSystemLayer.rm(oldPath, { recursive: true, force: true });
                }

                // Clean stale entry from extensions.json
                await removeFromExtensionsJson(fileSystemLayer, extensionsDir, [entry.id]);

                // Install via code-server
                const proc = processRunner.run(codeServerBinaryPath, [
                  "--install-extension",
                  entry.vsixPath,
                  "--extensions-dir",
                  extensionsDir.toNative(),
                ]);
                const result = await proc.wait();
                if (result.exitCode !== 0) {
                  throw new Error(
                    result.stderr.includes("ENOENT") || result.stderr.includes("spawn")
                      ? `Failed to run code-server: ${result.stderr || "Binary not found"}`
                      : `Failed to install extension: ${entry.id}`
                  );
                }
                logger.info("Extension installed", { extId: entry.id });
              }
              report("setup", "done");
            } catch (error) {
              report("setup", "failed", undefined, getErrorMessage(error));
              throw new SetupError(
                `Failed to install extensions: ${getErrorMessage(error)}`,
                "EXTENSION_INSTALL_FAILED"
              );
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // open-workspace -> finalize: create .code-workspace file, return URL
      // -------------------------------------------------------------------
      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          provides: () => ({
            ...(capWorkspaceUrl !== undefined && { workspaceUrl: capWorkspaceUrl }),
          }),
          handler: async (ctx: HookContext): Promise<void> => {
            capWorkspaceUrl = undefined;
            const finalizeCtx = ctx as FinalizeHookInput;

            try {
              const workspacePathObj = new Path(finalizeCtx.workspacePath);
              const projectWorkspacesDir = workspacePathObj.dirname;
              const envVarsArray = Object.entries(finalizeCtx.envVars).map(([name, value]) => ({
                name,
                value,
              }));
              const agentSettings: Record<string, unknown> = {
                "claudeCode.useTerminal": true,
                "claudeCode.claudeProcessWrapper": deps.wrapperPath,
                "claudeCode.environmentVariables": envVarsArray,
              };
              const workspaceFilePath = await deps.workspaceFileService.ensureWorkspaceFile(
                workspacePathObj,
                projectWorkspacesDir,
                agentSettings
              );
              capWorkspaceUrl = urlForWorkspace(codeServerPort, workspaceFilePath.toString());
            } catch (error) {
              logger.warn("Failed to ensure workspace file, using folder URL", {
                workspacePath: finalizeCtx.workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              capWorkspaceUrl = urlForFolder(codeServerPort, finalizeCtx.workspacePath);
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace -> delete: delete .code-workspace file
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const workspacePath = new Path(wsPath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await deps.workspaceFileService.deleteWorkspaceFile(
                workspaceName,
                projectWorkspacesDir
              );
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {};
              }
              throw error;
            }
          },
        },
      },
    },
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        if (values["code-server.port"] !== undefined) {
          config.port = values["code-server.port"] as number;
        }
        if (values["version.code-server"] !== undefined) {
          const version = (values["version.code-server"] as string | null) ?? CODE_SERVER_VERSION;
          const codeServerDir = deps.pathProvider.bundlePath(`code-server/${version}`);
          const execPath = getCodeServerExecutablePath(deps.platform);
          const binaryPath = new Path(codeServerDir, execPath).toNative();
          const downloadRequest: DownloadRequest = {
            name: "code-server",
            url: getCodeServerUrlForVersion(version, deps.platform, deps.arch),
            destDir: codeServerDir.toNative(),
            executablePath: execPath,
            subPath: getCodeServerSubPathForVersion(version, deps.platform, deps.arch),
          };
          config.binaryPath = binaryPath;
          config.codeServerDir = codeServerDir.toNative();
          if (binaryDownload) {
            binaryDownload = { ...binaryDownload, request: downloadRequest };
          }
          codeServerBinaryPath = binaryPath;
        }
      },
    },
  };

  return { module, setPluginPort };
}
