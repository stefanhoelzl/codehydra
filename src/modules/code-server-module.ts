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

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import { ANY_VALUE } from "../intents/lib/operation";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { ProcessRunner, SpawnedProcess } from "../boundaries/platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../boundaries/platform/process";
import type { HttpClient, PortManager } from "../boundaries/platform/network";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { Logger } from "../boundaries/platform/logging-types";
import type { SupportedPlatform, SupportedArch } from "../boundaries/platform/platform-info";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { DownloadProgressCallback, DownloadRequest } from "../utils/binary-download";
import { downloadBinary, isBinaryInstalled } from "../utils/binary-download";
import type { ArchiveExtractor } from "../boundaries/platform/archive-extractor";
import type { BinaryType } from "../utils/binary-resolution/types";
import type { CheckDepsHookContext, CheckDepsResult, ConfigureResult } from "../intents/app-start";
import type { BinaryHookInput, ExtensionsHookInput, SetupProgressPayload } from "../intents/setup";
import type { FinalizeHookInput } from "../intents/open-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../intents/delete-workspace";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import {
  APP_RESUME_OPERATION_ID,
  APP_RESUME_HOOK_RESUME,
  type ResumeHookResult,
} from "../intents/app-resume";
import { SETUP_OPERATION_ID } from "../intents/setup";
import { streamProgress } from "../intents/lib/hook-helpers";
import { OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { listInstalledExtensions, removeFromExtensionsJson } from "../utils/extension";
import { Path } from "../utils/path/path";
import { encodePathForUrl } from "../boundaries/platform/paths";
import { storeString, storeNumber } from "../boundaries/platform/store-definition";
import type { Config } from "../boundaries/platform/config";
import { CodeServerError, SetupError, getErrorMessage } from "../shared/errors/service-errors";
import { waitForHealthy } from "../utils/health-check";

// =============================================================================
// Code-Server Setup Info (inlined from services/code-server/setup-info.ts)
// =============================================================================

/**
 * Current version of code-server to download.
 */
export const CODE_SERVER_VERSION = "4.127.0";

/**
 * GitHub repository for Windows code-server builds.
 * Windows builds are not provided by the official code-server repo.
 */
const CODEHYDRA_REPO = "stefanhoelzl/codehydra";

/**
 * Architecture name mappings for code-server releases.
 */
const CODE_SERVER_ARCH = {
  x64: "amd64",
  arm64: "arm64",
} as const;

/**
 * Get the download URL for a specific code-server version.
 *
 * @param version - Code-server version string
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the code-server release
 * @throws Error if platform/arch combination is not supported
 */
export function getCodeServerUrlForVersion(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows code-server builds only support x64, got: ${arch}`);
    }
    return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${version}/code-server-${version}-win32-x64.tar.gz`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-${os}-${archName}.tar.gz`;
}

/** Get the download URL using the built-in version (for scripts/tests). */
export function getCodeServerUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  return getCodeServerUrlForVersion(CODE_SERVER_VERSION, platform, arch);
}

/**
 * Get the subpath within the extracted archive for a specific code-server version.
 *
 * @param version - Code-server version string
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Subpath prefix within the archive
 */
function getCodeServerSubPathForVersion(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  if (platform === "win32") {
    return `code-server-${version}-win32-x64`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `code-server-${version}-${os}-${archName}`;
}

/** Get the subpath using the built-in version (for scripts/tests). */
export function getCodeServerSubPath(platform: SupportedPlatform, arch: SupportedArch): string {
  return getCodeServerSubPathForVersion(CODE_SERVER_VERSION, platform, arch);
}

/**
 * Get the relative path to the code-server executable within the extracted directory.
 *
 * @param platform - Operating system platform
 * @returns Relative path to the executable
 */
export function getCodeServerExecutablePath(platform: SupportedPlatform): string {
  return platform === "win32" ? "bin/code-server.cmd" : "bin/code-server";
}

// =============================================================================
// Internal Types
// =============================================================================

/** State of the code-server instance. */
type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

/** Internal configuration for code-server instance. */
interface CodeServerConfig {
  readonly runtimeDir: string;
  readonly extensionsDir: string;
  readonly userDataDir: string;
  readonly binDir: string;
  pluginPort: number | undefined;
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
    FileSystemBoundary,
    | "mkdir"
    | "readdir"
    | "rm"
    | "readFile"
    | "writeFile"
    | "unlink"
    | "rename"
    | "writeFileBuffer"
    | "makeExecutable"
  >;
  readonly pathProvider: Pick<PathProvider, "bundlePath" | "dataPath">;
  readonly buildInfo: Pick<BuildInfo, "isPackaged" | "gitBranch">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly wrapperPath: string;
  readonly logger: Logger;
  readonly archiveExtractor?: ArchiveExtractor;
  readonly configService: Config;
  /**
   * Resolve the native path to the bundled OpenCode binary directory, injected
   * into the code-server environment as `_CH_OPENCODE_DIR`. Owned by the
   * OpenCode layer so code-server doesn't reach into agent-owned config.
   */
  readonly resolveOpencodeBundleDir: () => string;
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
export function createCodeServerModule(deps: CodeServerModuleDeps): IntentModule {
  const { processRunner, fileSystemLayer, logger } = deps;

  // Register config keys
  const codeServerVersionConfig = deps.configService.register("version.code-server", {
    default: CODE_SERVER_VERSION,
    description: "Code-server version",
    ...storeString(),
  });
  const codeServerPortConfig = deps.configService.register("code-server.port", {
    default: getCodeServerPort(deps.buildInfo),
    description: "Code-server port",
    ...storeNumber({ min: 1, max: 65535, integer: true }),
  });

  // -------------------------------------------------------------------------
  // Compute config from deps
  // -------------------------------------------------------------------------

  const config: CodeServerConfig = {
    runtimeDir: deps.pathProvider.dataPath("runtime").toNative(),
    extensionsDir: deps.pathProvider.dataPath("vscode/extensions").toNative(),
    userDataDir: deps.pathProvider.dataPath("vscode/user-data").toNative(),
    binDir: deps.pathProvider.dataPath("bin").toNative(),
    pluginPort: undefined,
  };

  /** Resolve version-derived paths from configService (call only after load()). */
  function resolveCodeServerPaths() {
    const version = codeServerVersionConfig.get();
    return {
      binaryPath: new Path(
        deps.pathProvider.bundlePath(`code-server/${version}`),
        getCodeServerExecutablePath(deps.platform)
      ).toNative(),
      codeServerDir: deps.pathProvider.bundlePath(`code-server/${version}`).toNative(),
    };
  }

  // -------------------------------------------------------------------------
  // Workspace file helpers (inline — only used by this module)
  // -------------------------------------------------------------------------

  function workspaceFilePath(workspaceName: string, projectWorkspacesDir: Path): Path {
    return new Path(projectWorkspacesDir, `${workspaceName}.code-workspace`);
  }

  async function writeWorkspaceFile(
    workspacePath: Path,
    agentSettings?: Readonly<Record<string, unknown>>
  ): Promise<Path> {
    const workspaceName = workspacePath.basename;
    const projectWorkspacesDir = workspacePath.dirname;
    const filePath = workspaceFilePath(workspaceName, projectWorkspacesDir);
    const content = {
      folders: [{ path: workspacePath.toString() }],
      settings: { ...agentSettings },
    };
    await fileSystemLayer.writeFile(filePath, JSON.stringify(content, null, 2));
    logger.debug("Created workspace file", { workspaceName, path: filePath.toString() });
    return filePath;
  }

  async function removeWorkspaceFile(
    workspaceName: string,
    projectWorkspacesDir: Path
  ): Promise<void> {
    const filePath = workspaceFilePath(workspaceName, projectWorkspacesDir);
    await fileSystemLayer.rm(filePath, { force: true });
    logger.debug("Deleted workspace file", { workspaceName, path: filePath.toString() });
  }

  // -------------------------------------------------------------------------
  // Binary download state
  // -------------------------------------------------------------------------

  /** Build download request from configService (call only after load()). */
  function getDownloadRequest(): DownloadRequest | null {
    if (!deps.archiveExtractor) return null;
    const version = codeServerVersionConfig.get();
    return {
      name: "code-server" as const,
      url: getCodeServerUrlForVersion(version, deps.platform, deps.arch),
      destDir: deps.pathProvider.bundlePath(`code-server/${version}`).toNative(),
      archiveExtension: ".tar.gz" as const,
      executablePath: getCodeServerExecutablePath(deps.platform),
      subPath: getCodeServerSubPathForVersion(version, deps.platform, deps.arch),
    };
  }

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

    const port = codeServerPortConfig.get();

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
      const { binaryPath, codeServerDir } = resolveCodeServerPaths();
      cleanEnv._CH_CODE_SERVER_DIR = codeServerDir;
      cleanEnv._CH_OPENCODE_DIR = deps.resolveOpencodeBundleDir();

      serverProcess = processRunner.run(binaryPath, args, {
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
    const request = getDownloadRequest();
    if (!request) {
      return { success: true, needsDownload: false };
    }

    try {
      const isInstalled = await isBinaryInstalled(request.destDir, {
        fileSystemLayer: deps.fileSystemLayer,
      });

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

  async function downloadCodeServer(onProgress?: DownloadProgressCallback): Promise<void> {
    const request = getDownloadRequest();
    if (!request || !deps.archiveExtractor) {
      throw new CodeServerError(
        "Cannot download code-server binary: ArchiveExtractor not available"
      );
    }

    logger.info("Downloading code-server binary");

    try {
      await downloadBinary(
        request,
        {
          httpClient: deps.httpClient,
          fileSystemLayer: deps.fileSystemLayer,
          archiveExtractor: deps.archiveExtractor,
          logger,
        },
        onProgress
      );
      logger.info("Code-server binary download complete");
    } catch (error) {
      const message = getErrorMessage(error);
      throw new CodeServerError(`Failed to download code-server: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Module definition
  // -------------------------------------------------------------------------

  const module: IntentModule = {
    name: "code-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        // -------------------------------------------------------------------
        // app-start -> before-ready: declare required scripts
        // -------------------------------------------------------------------
        "before-ready": {
          handler: async (): Promise<HookOutput<ConfigureResult>> => {
            return { result: { scripts: ["code", "code.cmd"] } };
          },
        },

        // -------------------------------------------------------------------
        // app-start -> check-deps: preflight code-server binary + extensions
        // -------------------------------------------------------------------
        "check-deps": {
          handler: async (ctx: HookContext): Promise<HookOutput<CheckDepsResult>> => {
            const { extensionRequirements } = ctx as CheckDepsHookContext;
            const missingBinaries: BinaryType[] = [];

            // Check code-server binary
            const codeServerResult = await preflight();
            if (codeServerResult.success && codeServerResult.needsDownload) {
              missingBinaries.push("code-server");
            }

            // Compare requirements against installed extensions
            if (extensionRequirements.length === 0) {
              return { result: { missingBinaries } };
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

              return { result: { missingBinaries, extensionInstallPlan } };
            } catch (error) {
              logger.warn("Extension check failed", { error: getErrorMessage(error) });
              return { result: { missingBinaries } };
            }
          },
        },

        // -------------------------------------------------------------------
        // app-start -> start: start code-server, update port
        // -------------------------------------------------------------------
        start: {
          requires: { pluginPort: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<HookOutput> => {
            // Read pluginPort from capabilities (provided by plugin-server-module)
            const pluginPort = ctx.capabilities?.pluginPort as number | null;
            if (pluginPort !== null) {
              config.pluginPort = pluginPort;
            }

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

            return { provides: { codeServerPort: port } };
          },
        },
      },

      // -------------------------------------------------------------------
      // app-resume -> resume: probe /healthz, restart on failure
      // -------------------------------------------------------------------
      [APP_RESUME_OPERATION_ID]: {
        [APP_RESUME_HOOK_RESUME]: {
          handler: async (): Promise<HookOutput<ResumeHookResult>> => {
            const port = currentPort;
            if (port === null) {
              // Never started — nothing to probe or restart.
              return {};
            }

            try {
              await waitForHealthy({
                checkFn: () => checkHealth(port),
                timeoutMs: 5000,
                intervalMs: 500,
                errorMessage: "Code-server health check timed out after 5s",
              });
              return {};
            } catch {
              // Fall through to restart
            }

            logger.warn("Code-server unhealthy after resume, restarting");
            try {
              await stop();
              await ensureRunning();
              logger.info("Code-server restarted after resume");
            } catch (error) {
              const message = getErrorMessage(error);
              logger.error("Code-server restart failed after resume", { error: message });
              // Report the failure as data; the operation emits app:resume-failed.
              return { result: { failed: { error: message } } };
            }

            // The fresh process invalidates every workspace iframe's connection
            // to the old server. The operation emits code-server:restarted so
            // view-module reloads them before code-server surfaces its own
            // "Reload" dialog.
            return { result: { restarted: true } };
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
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (
            ctx: HookContext
          ): AsyncGenerator<SetupProgressPayload, void, void> {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];

            if (!missingBinaries.includes("code-server")) {
              yield { id: "vscode", status: "done" };
              return;
            }

            yield { id: "vscode", status: "running", message: "Downloading..." };
            try {
              yield* streamProgress<SetupProgressPayload>(async (emit) => {
                let lastKey = "";
                await downloadCodeServer((p) => {
                  const pct = p.totalBytes
                    ? Math.floor((p.bytesDownloaded / p.totalBytes) * 100)
                    : undefined;
                  // Throttle: only forward when the phase or integer % changes.
                  const key = `${p.phase}:${pct ?? "x"}`;
                  if (key === lastKey) return;
                  lastKey = key;
                  const message = p.phase === "downloading" ? "Downloading..." : "Extracting...";
                  emit({
                    id: "vscode",
                    status: "running",
                    message,
                    ...(pct !== undefined && { progress: pct }),
                  });
                });
              });
              yield { id: "vscode", status: "done" };
            } catch (error) {
              yield { id: "vscode", status: "failed", error: getErrorMessage(error) };
              throw new SetupError(
                `Failed to download code-server: ${getErrorMessage(error)}`,
                "BINARY_DOWNLOAD_FAILED"
              );
            }
          },
        },

        // -------------------------------------------------------------------
        // setup -> extensions: install extensions from install plan
        // -------------------------------------------------------------------
        extensions: {
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (
            ctx: HookContext
          ): AsyncGenerator<SetupProgressPayload, void, void> {
            const hookCtx = ctx as ExtensionsHookInput;
            const installPlan = hookCtx.extensionInstallPlan ?? [];

            if (installPlan.length === 0) {
              yield { id: "setup", status: "done" };
              return;
            }

            yield { id: "setup", status: "running", message: "Installing extensions..." };

            const extensionsDir = deps.pathProvider.dataPath("vscode/extensions");

            try {
              // Scan installed to find old dirs to remove
              const installed = await listInstalledExtensions(fileSystemLayer, extensionsDir);

              for (const entry of installPlan) {
                yield { id: "setup", status: "running", message: `Installing ${entry.id}...` };

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
                const proc = processRunner.run(resolveCodeServerPaths().binaryPath, [
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
              yield { id: "setup", status: "done" };
            } catch (error) {
              yield { id: "setup", status: "failed", error: getErrorMessage(error) };
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
          handler: async (ctx: HookContext): Promise<HookOutput<string>> => {
            let workspaceUrl: string;
            const finalizeCtx = ctx as FinalizeHookInput;

            try {
              const workspacePathObj = new Path(finalizeCtx.workspacePath);
              const envVarsArray = Object.entries(finalizeCtx.envVars).map(([name, value]) => ({
                name,
                value,
              }));
              const agentSettings: Record<string, unknown> = {
                "claudeCode.useTerminal": true,
                "claudeCode.claudeProcessWrapper": deps.wrapperPath,
                "claudeCode.environmentVariables": envVarsArray,
                "chat.agent.enabled": false,
                "extensions.autoUpdate": false,
                "extensions.autoCheckUpdates": false,
              };
              const wsFilePath = await writeWorkspaceFile(workspacePathObj, agentSettings);
              workspaceUrl = urlForWorkspace(codeServerPort, wsFilePath.toString());
            } catch (error) {
              logger.warn("Failed to ensure workspace file, using folder URL", {
                workspacePath: finalizeCtx.workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              workspaceUrl = urlForFolder(codeServerPort, finalizeCtx.workspacePath);
            }

            return { result: workspaceUrl };
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace -> delete: delete .code-workspace file
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<HookOutput<DeleteHookResult>> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const workspacePath = new Path(wsPath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await removeWorkspaceFile(workspaceName, projectWorkspacesDir);
              return { result: {} };
            } catch (error) {
              if (payload.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { result: {} };
              }
              throw error;
            }
          },
        },
      },
    },
  };

  return module;
}
