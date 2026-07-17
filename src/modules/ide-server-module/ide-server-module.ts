/**
 * IdeServerModule - Manages IDE server lifecycle, extensions, and per-workspace files.
 *
 * Owns the distribution-agnostic concerns for the embedded IDE server:
 * - Binary preflight + download
 * - Extension preflight + install
 * - Server lifecycle (start/stop/resume)
 * - Per-workspace `.code-workspace` file creation (finalize hook) and deletion
 *
 * Everything distribution-specific (download coordinates, serve args, readiness
 * probe, URL scheme) is delegated to an `IdeServer` descriptor (see `./types`).
 *
 * Internal state: server port set by `start` hook, read by `finalize` hook.
 */

import { join, delimiter } from "node:path";

import type { IntentModule } from "../../intents/lib/module";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import { ANY_VALUE } from "../../intents/lib/operation";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner, SpawnedProcess } from "../../boundaries/platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../../boundaries/platform/process";
import type { HttpClient, PortManager } from "../../boundaries/platform/network";
import type { SessionBoundary, InterceptedAsset } from "../../boundaries/shell/session";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";
import type { BuildInfo } from "../../boundaries/platform/build-info";
import type { DownloadProgressCallback, DownloadRequest } from "../../utils/binary-download";
import { downloadBinary, isBinaryInstalled } from "../../utils/binary-download";
import type { ArchiveExtractor } from "../../boundaries/platform/archive-extractor";
import type { BinaryType } from "../../utils/binary-resolution/types";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
} from "../../intents/app-start";
import type {
  BinaryHookInput,
  ExtensionsHookInput,
  SetupProgressPayload,
} from "../../intents/setup";
import type { FinalizeHookInput } from "../../intents/open-workspace";
import type { DeleteWorkspaceIntent } from "../../intents/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../../intents/delete-workspace";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import {
  APP_RESUME_OPERATION_ID,
  APP_RESUME_HOOK_RESUME,
  type ResumeHookResult,
} from "../../intents/app-resume";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import { streamProgress } from "../../intents/lib/hook-helpers";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../../intents/delete-workspace";
import { listInstalledExtensions, removeFromExtensionsJson } from "../../utils/extension";
import { Path } from "../../utils/path/path";
import { storeString, storeNumber } from "../../boundaries/platform/store-definition";
import type { Config } from "../../boundaries/platform/config";
import { IdeServerError, SetupError, getErrorMessage } from "../../shared/errors/service-errors";
import { waitForHealthy } from "../../utils/health-check";
import { createVscodiumIdeServer, VSCODIUM_VERSION } from "./vscodium";
import { applyBundlePatches } from "./bundle-patches";
import type { IdeServer } from "./types";

// =============================================================================
// Internal Types
// =============================================================================

/** State of the IDE server instance. */
type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

/** Internal configuration for the IDE server instance. */
interface IdeServerConfig {
  readonly runtimeDir: string;
  readonly extensionsDir: string;
  readonly userDataDir: string;
  readonly binDir: string;
  pluginPort: number | undefined;
}

// =============================================================================
// Port Helpers
// =============================================================================

/** Fixed production port for the embedded IDE server (stable IndexedDB origin). */
const IDE_SERVER_PORT = 25448;

/**
 * Determine the IDE server port from build info.
 * - Production: the fixed port (stable IndexedDB origin)
 * - Development: derived from the git branch for stability across restarts
 */
function getIdeServerPort(buildInfo: Pick<BuildInfo, "isPackaged" | "gitBranch">): number {
  if (buildInfo.isPackaged) {
    return IDE_SERVER_PORT;
  }
  return derivePortFromString(buildInfo.gitBranch ?? "development");
}

/**
 * Format a remote-cli's leading arguments for the platform's wrapper script.
 * Windows re-parses the expanded `%VAR%`, so each token is quoted; POSIX passes
 * them through unquoted (current distributions use no leading arguments there).
 */
function formatRemoteCliArgs(args: readonly string[], platform: SupportedPlatform): string {
  if (platform === "win32") {
    return args.map((arg) => `"${arg}"`).join(" ");
  }
  return args.join(" ");
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
// Dependency Interfaces
// =============================================================================

/**
 * All dependencies for IdeServerModule.
 */
export interface IdeServerModuleDeps {
  readonly processRunner: Pick<ProcessRunner, "run">;
  readonly httpClient: Pick<HttpClient, "fetch">;
  readonly portManager: Pick<PortManager, "isPortAvailable">;
  readonly fileSystemLayer: Pick<
    FileSystemBoundary,
    | "mkdir"
    | "readdir"
    | "rm"
    | "readFile"
    | "readFileBuffer"
    | "writeFile"
    | "unlink"
    | "rename"
    | "writeFileBuffer"
    | "makeExecutable"
  >;
  /**
   * Session the workspace iframes load in. The module intercepts the webview
   * shell requests on it (see `IdeServer.webviewAsset`).
   */
  readonly sessionLayer: Pick<
    SessionBoundary,
    "fromPartition" | "setProtocolHandler" | "clearCache"
  >;
  /** Partition name of that session. */
  readonly sessionPartition: string;
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
   * into the IDE server environment as `_CH_OPENCODE_DIR`. Owned by the
   * OpenCode layer so the IDE server doesn't reach into agent-owned config.
   */
  readonly resolveOpencodeBundleDir: () => string;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an IdeServerModule that manages the embedded IDE server lifecycle,
 * extensions, and per-workspace .code-workspace files.
 */
export function createIdeServerModule(deps: IdeServerModuleDeps): IntentModule {
  const { processRunner, fileSystemLayer, logger } = deps;

  // Register config keys
  const vscodiumVersionConfig = deps.configService.register("version.vscodium", {
    default: VSCODIUM_VERSION,
    description: "VSCodium version",
    ...storeString(),
  });
  // `ide-server.port` is the rename of the retired `code-server.port`: a config
  // file still carrying the old key is translated to this one at load (env/CLI
  // legacy names honored too). The legacy value shares this key's validation.
  // Min 1024: the server binds an unprivileged loopback port, so reject the
  // privileged range (<1024, which needs root on Unix) at config-validation time.
  const portType = storeNumber({ min: 1024, max: 65535, integer: true });
  const ideServerPortConfig = deps.configService.register("ide-server.port", {
    default: getIdeServerPort(deps.buildInfo),
    description: "IDE server port",
    legacyNames: { "code-server.port": (value) => portType.validate(value) },
    ...portType,
  });

  /** Resolve the IdeServer descriptor (call only after config load()). */
  function getIdeServer(): IdeServer {
    return createVscodiumIdeServer(vscodiumVersionConfig.get());
  }

  /** The port the IDE server serves on (call only after load()). */
  function getPort(): number {
    return ideServerPortConfig.get();
  }

  // -------------------------------------------------------------------------
  // Compute config from deps
  // -------------------------------------------------------------------------

  const config: IdeServerConfig = {
    runtimeDir: deps.pathProvider.dataPath("runtime").toNative(),
    extensionsDir: deps.pathProvider.dataPath("vscode/extensions").toNative(),
    userDataDir: deps.pathProvider.dataPath("vscode/user-data").toNative(),
    binDir: deps.pathProvider.dataPath("bin").toNative(),
    pluginPort: undefined,
  };

  /** Resolve version-derived paths (call only after load()). */
  function resolveIdeServerPaths() {
    const ide = getIdeServer();
    const bundleDir = deps.pathProvider.bundlePath(ide.bundleSubdir());
    return {
      binaryPath: new Path(bundleDir, ide.executablePath(deps.platform)).toNative(),
      // Resolved against the bundle, so they survive any cwd.
      prefixArgs: ide.entryArgs().map((relative) => new Path(bundleDir, relative).toNative()),
      ideServerDir: bundleDir.toNative(),
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

  /** Build download request from the active descriptor (call only after load()). */
  function getDownloadRequest(): DownloadRequest | null {
    if (!deps.archiveExtractor) return null;
    const ide = getIdeServer();
    const subPath = ide.archiveSubPath(deps.platform, deps.arch);
    return {
      name: ide.id,
      url: ide.downloadUrl(deps.platform, deps.arch),
      destDir: deps.pathProvider.bundlePath(ide.bundleSubdir()).toNative(),
      archiveExtension: ".tar.gz" as const,
      executablePath: ide.executablePath(deps.platform),
      ...(subPath !== undefined ? { subPath } : {}),
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
  let ideServerPort = 0;

  // -------------------------------------------------------------------------
  // Webview shell interception
  // -------------------------------------------------------------------------

  /** Content type for the flat webview shell files (html + the service worker). */
  function webviewContentType(assetPath: string): string {
    return assetPath.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
  }

  /**
   * Serve the webview shell from the bundle instead of the CDN the distribution
   * bakes in (see `IdeServer.webviewAsset` for why). Registered on the session
   * the workspace iframes load in; every other https request passes through.
   */
  function registerWebviewInterceptor(): void {
    const ide = getIdeServer();
    const bundleDir = deps.pathProvider.bundlePath(ide.bundleSubdir());
    const handle = deps.sessionLayer.fromPartition(deps.sessionPartition);

    deps.sessionLayer.setProtocolHandler(
      handle,
      "https",
      async (url): Promise<InterceptedAsset | null> => {
        const assetPath = ide.webviewAsset(url);
        if (assetPath === null) return null;

        try {
          const body = await fileSystemLayer.readFileBuffer(new Path(bundleDir, assetPath));
          return {
            body,
            contentType: webviewContentType(assetPath),
            headers: {
              // The shell is cheap to re-read and must never pin a stale
              // service-worker version the way the CDN's immutable assets did.
              "cache-control": "no-cache",
              // The worker's scope sits above its own directory.
              "service-worker-allowed": "/",
            },
          };
        } catch (error) {
          // Fall through to the network rather than fail the frame outright.
          logger.warn("Failed to serve webview asset from bundle", {
            assetPath,
            error: getErrorMessage(error),
          });
          return null;
        }
      }
    );

    logger.debug("Webview interceptor registered", { partition: deps.sessionPartition });
  }

  /**
   * Drop what the workspace iframes have cached of the bundle, so a freshly
   * patched file is the one they actually load (see the `start` hook).
   *
   * Caches only: the session's cookies, localStorage and IndexedDB are left
   * alone, so extension `globalState` and `secretStorage` — including the GitHub
   * sign-in — survive. Best-effort, because a cache that refuses to clear is not
   * worth failing every workspace over; the patch simply stays dormant until the
   * next startup, which is where it already was.
   */
  async function clearIdeCaches(): Promise<void> {
    try {
      const handle = deps.sessionLayer.fromPartition(deps.sessionPartition);
      await deps.sessionLayer.clearCache(handle);
      logger.info("Cleared IDE caches after patching the bundle", {
        partition: deps.sessionPartition,
      });
    } catch (error) {
      logger.error("Failed to clear IDE caches; bundle patches may not take effect", {
        error: getErrorMessage(error),
      });
    }
  }

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
      const response = await deps.httpClient.fetch(getIdeServer().healthUrl(port), {
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
    logger.info("Starting IDE server");

    const port = getPort();

    const portAvailable = await deps.portManager.isPortAvailable(port);
    if (!portAvailable) {
      throw new IdeServerError(
        `Port ${port} is already in use. Another IDE server or application may be running on this port.`
      );
    }

    currentPort = port;

    const ide = getIdeServer();
    const args = [
      ...ide.buildServeArgs({
        port,
        extensionsDir: config.extensionsDir,
        userDataDir: config.userDataDir,
      }),
    ];

    try {
      // Create clean environment without VS Code/IDE-server variables
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

      // Distribution-specific environment (from the active IdeServer descriptor)
      Object.assign(cleanEnv, ide.serveEnv());

      // Set plugin port for VS Code extension communication
      if (config.pluginPort !== undefined) {
        cleanEnv._CH_PLUGIN_PORT = String(config.pluginPort);
      }

      // Concrete wrapper invocations resolved from the active descriptor, so
      // the wrapper scripts stay distribution-agnostic. Plus the opencode dir
      // for the agent wrappers.
      const { binaryPath, prefixArgs, ideServerDir } = resolveIdeServerPaths();
      const remoteCli = ide.remoteCli(ideServerDir, deps.platform);
      cleanEnv._CH_IDE_REMOTE_CLI = remoteCli.exe;
      cleanEnv._CH_IDE_REMOTE_CLI_ARGS = formatRemoteCliArgs(remoteCli.args, deps.platform);
      cleanEnv._CH_IDE_NODE = ide.nodeBinary(ideServerDir, deps.platform);
      cleanEnv._CH_OPENCODE_DIR = deps.resolveOpencodeBundleDir();

      serverProcess = processRunner.run(binaryPath, [...prefixArgs, ...args], {
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
          logger.warn("Failed to kill IDE server after start failure");
        }
      }

      const errorMsg = getErrorMessage(error);
      throw new IdeServerError(`Failed to start IDE server: ${errorMsg}`);
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
        logger.warn("Failed to kill IDE server", { pid: pid ?? 0 });
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

      logger.debug("IDE server binary preflight", {
        isInstalled,
        needsDownload: !isInstalled,
      });

      return { success: true, needsDownload: !isInstalled };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("IDE server binary preflight failed", { error: message });
      return {
        success: false,
        error: { type: "preflight-failed", message },
      };
    }
  }

  async function downloadIdeServer(onProgress?: DownloadProgressCallback): Promise<void> {
    const request = getDownloadRequest();
    if (!request || !deps.archiveExtractor) {
      throw new IdeServerError("Cannot download IDE server binary: ArchiveExtractor not available");
    }

    logger.info("Downloading IDE server binary");

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
      logger.info("IDE server binary download complete");
    } catch (error) {
      const message = getErrorMessage(error);
      throw new IdeServerError(`Failed to download IDE server: ${message}`);
    }
    // The freshly extracted bundle is patched by the "start" hook, which always
    // follows setup in the same app:start dispatch (see bundle-patches.ts).
  }

  // -------------------------------------------------------------------------
  // Module definition
  // -------------------------------------------------------------------------

  const module: IntentModule = {
    name: "ide-server",
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
        // app-start -> check-deps: preflight IDE server binary + extensions
        // -------------------------------------------------------------------
        "check-deps": {
          handler: async (ctx: HookContext): Promise<HookOutput<CheckDepsResult>> => {
            const { extensionRequirements } = ctx as CheckDepsHookContext;
            const missingBinaries: BinaryType[] = [];

            // Check IDE server binary
            const ideServerResult = await preflight();
            if (ideServerResult.success && ideServerResult.needsDownload) {
              missingBinaries.push(getIdeServer().id);
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
        // app-start -> start: start the IDE server, update port
        // -------------------------------------------------------------------
        start: {
          requires: { pluginPort: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<HookOutput> => {
            // Read pluginPort from capabilities (provided by plugin-server-module)
            const pluginPort = ctx.capabilities?.pluginPort as number | null;
            if (pluginPort !== null) {
              config.pluginPort = pluginPort;
            }

            // Before any workspace iframe loads, so the first webview already
            // resolves to the bundle's shell rather than the baked-in CDN.
            registerWebviewInterceptor();

            // Fix the vendored bundle's upstream bugs before the server can serve
            // a single byte of it. Setup has already downloaded it if it was
            // missing; patches are idempotent, so installs that predate a patch
            // are fixed here too. Throws in dev if a patch no longer matches the
            // bundle, so a version bump can't silently un-fix it (bundle-patches.ts).
            const rewroteBundle = await applyBundlePatches(
              {
                fileSystemLayer: deps.fileSystemLayer,
                logger,
                platform: deps.platform,
                isPackaged: deps.buildInfo.isPackaged,
              },
              resolveIdeServerPaths().ideServerDir
            );

            // A patched file on disk is not a patched workbench in the iframe.
            // The distribution serves its static assets with `Cache-Control:
            // public, max-age=31536000` and no ETag, under a URL keyed on the
            // VSCodium commit — which a patch does not change. So the session
            // holds a year-long, never-revalidated copy of the *unpatched*
            // workbench, and every patch we apply is inert until that copy goes.
            // Dropping the caches here — before the server can serve a request
            // and long before the first iframe loads — is what makes a patch
            // reach the user. Only when a patch actually rewrote something:
            // steady state is "already-applied", and re-fetching 17 MB on every
            // startup would be a real cost for no gain.
            if (rewroteBundle) {
              await clearIdeCaches();
            }

            // Ensure required directories exist
            await Promise.all([
              fileSystemLayer.mkdir(config.runtimeDir),
              fileSystemLayer.mkdir(config.extensionsDir),
              fileSystemLayer.mkdir(config.userDataDir),
            ]);

            // Start the IDE server
            await ensureRunning();
            const port = currentPort!;

            // Update internal port (consumed by finalize hook for workspace URLs)
            ideServerPort = port;

            return { provides: { ideServerPort: port } };
          },
        },
      },

      // -------------------------------------------------------------------
      // app-resume -> resume: probe health, restart on failure
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
                errorMessage: "IDE server health check timed out after 5s",
              });
              return {};
            } catch {
              // Fall through to restart
            }

            logger.warn("IDE server unhealthy after resume, restarting");
            try {
              await stop();
              await ensureRunning();
              logger.info("IDE server restarted after resume");
            } catch (error) {
              const message = getErrorMessage(error);
              logger.error("IDE server restart failed after resume", { error: message });
              // Report the failure as data; the operation emits app:resume-failed.
              return { result: { failed: { error: message } } };
            }

            // The fresh process invalidates every workspace iframe's connection
            // to the old server. The operation emits ide-server:restarted so
            // view-module reloads them before the IDE server surfaces its own
            // "Reload" dialog.
            return { result: { restarted: true } };
          },
        },
      },

      // -------------------------------------------------------------------
      // app-shutdown -> stop: stop the IDE server
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await stop();
          },
        },
      },

      // -------------------------------------------------------------------
      // setup -> binary: download the IDE server if missing
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        binary: {
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (
            ctx: HookContext
          ): AsyncGenerator<SetupProgressPayload, void, void> {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];

            if (!missingBinaries.includes(getIdeServer().id)) {
              yield { id: "vscode", status: "done" };
              return;
            }

            yield { id: "vscode", status: "running", message: "Downloading..." };
            try {
              yield* streamProgress<SetupProgressPayload>(async (emit) => {
                let lastKey = "";
                await downloadIdeServer((p) => {
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
                `Failed to download IDE server: ${getErrorMessage(error)}`,
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

                // Install via the IDE server CLI
                const { binaryPath, prefixArgs } = resolveIdeServerPaths();
                const proc = processRunner.run(binaryPath, [
                  ...prefixArgs,
                  "--install-extension",
                  entry.vsixPath,
                  "--extensions-dir",
                  extensionsDir.toNative(),
                ]);
                const result = await proc.wait();
                if (result.exitCode !== 0) {
                  throw new Error(
                    result.stderr.includes("ENOENT") || result.stderr.includes("spawn")
                      ? `Failed to run IDE server: ${result.stderr || "Binary not found"}`
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
            const ide = getIdeServer();

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
              };
              const wsFilePath = await writeWorkspaceFile(workspacePathObj, agentSettings);
              workspaceUrl = ide.urlForWorkspace(ideServerPort, wsFilePath.toString());
            } catch (error) {
              logger.warn("Failed to ensure workspace file, using folder URL", {
                workspacePath: finalizeCtx.workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              workspaceUrl = ide.urlForFolder(ideServerPort, finalizeCtx.workspacePath);
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
                logger.warn("IdeServerModule: error in force mode (ignored)", {
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
