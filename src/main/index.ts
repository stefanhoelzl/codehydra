/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 */

// Fix fontconfig for AppImage builds.
// Must be set BEFORE any Electron/Chromium code runs.
// AppImage sets APPIMAGE or APPDIR environment variables.
if (process.env.APPIMAGE || process.env.APPDIR) {
  // Point fontconfig to system fonts instead of any bundled config
  process.env.FONTCONFIG_PATH = "/etc/fonts";
}

import { app } from "electron";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import {
  CodeServerManager,
  ProjectStore,
  DefaultPathProvider,
  DefaultNetworkLayer,
  DefaultFileSystemLayer,
  ElectronLogService,
  createWorkspaceLockHandler,
  WorkspaceFileService,
  createWorkspaceFileConfig,
  getCodeServerPort,
  GitWorktreeProvider,
  SimpleGitClient,
  KeepFilesService,
  type CodeServerConfig,
  type PathProvider,
  type BuildInfo,
  type LoggingService,
} from "../services";
import { setupBinDirectory } from "../services/vscode-setup/bin-setup";
import { ConfigService } from "../services/config/config-service";
import { PostHogTelemetryService } from "../services/telemetry";
import { AutoUpdater } from "../services/auto-updater";
import { ExecaProcessRunner } from "../services/platform/process";
import { DefaultIpcLayer } from "../services/platform/ipc";
import { DefaultAppLayer } from "../services/platform/app";
import { DefaultImageLayer } from "../services/platform/image";
import { DefaultDialogLayer } from "../services/platform/dialog";
import { DefaultMenuLayer } from "../services/platform/menu";
import { DefaultWindowLayer } from "../services/shell/window";
import { DefaultViewLayer } from "../services/shell/view";
import { DefaultSessionLayer } from "../services/shell/session";
import {
  DefaultBinaryDownloadService,
  DefaultArchiveExtractor,
  AgentBinaryManager,
  type BinaryDownloadService,
  CODE_SERVER_VERSION,
  OPENCODE_VERSION,
} from "../services/binary-download";
import { ExtensionManager } from "../services/vscode-setup/extension-manager";
import { AgentStatusManager, createAgentServerManager } from "../agents";
import { PluginServer } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { registerLogHandlers } from "./ipc";
import { initializeBootstrap } from "./bootstrap";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent } from "./operations/set-mode";
import { INTENT_APP_SHUTDOWN } from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import { INTENT_APP_START } from "./operations/app-start";
import type { AppStartIntent } from "./operations/app-start";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { ConfigAgentType } from "../shared/api/types";
import { ApiIpcChannels } from "../shared/ipc";
import { ElectronBuildInfo } from "./build-info";
import { NodePlatformInfo } from "./platform-info";
import { getErrorMessage } from "../shared/error-utils";

/**
 * Parses Electron command-line flags from a string.
 * @param flags - Space-separated flags string (e.g., "--disable-gpu --use-gl=swiftshader")
 * @returns Array of parsed flags
 * @throws Error if quotes are detected (not supported)
 */
function parseElectronFlags(flags: string | undefined): { name: string; value?: string }[] {
  if (!flags || !flags.trim()) {
    return [];
  }

  if (flags.includes('"') || flags.includes("'")) {
    throw new Error(
      "Quoted values are not supported in CODEHYDRA_ELECTRON_FLAGS. " +
        'Use --flag=value instead of --flag="value".'
    );
  }

  const result: { name: string; value?: string }[] = [];
  const parts = flags.trim().split(/\s+/);

  for (const part of parts) {
    const withoutDashes = part.replace(/^--?/, "");
    const eqIndex = withoutDashes.indexOf("=");
    if (eqIndex !== -1) {
      result.push({
        name: withoutDashes.substring(0, eqIndex),
        value: withoutDashes.substring(eqIndex + 1),
      });
    } else {
      result.push({ name: withoutDashes });
    }
  }

  return result;
}

// Module-level instances - created IMMEDIATELY after imports.
// These are created early because:
// 1. applyElectronFlags() needs to log
// 2. redirectElectronDataPaths() needs pathProvider
const buildInfo: BuildInfo = new ElectronBuildInfo();

// Disable ASAR virtual filesystem when not packaged.
// Prevents file handle issues on Windows when deleting workspaces
// that contain node_modules/electron directories.
if (!buildInfo.isPackaged) {
  process.noAsar = true;
}

const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);

// Create logging service - must be before any code that needs to log
const loggingService: LoggingService = new ElectronLogService(buildInfo, pathProvider);
const appLogger = loggingService.createLogger("app");

/**
 * Applies Electron command-line flags from environment variable.
 * Must be called BEFORE app.whenReady().
 *
 * Environment variable: CODEHYDRA_ELECTRON_FLAGS
 * Example: "--disable-gpu --use-gl=swiftshader"
 */
function applyElectronFlags(): void {
  const flags = process.env.CODEHYDRA_ELECTRON_FLAGS;
  if (!flags) {
    return;
  }

  const parsed = parseElectronFlags(flags);

  for (const flag of parsed) {
    if (flag.value !== undefined) {
      app.commandLine.appendSwitch(flag.name, flag.value);
      appLogger.info("Applied Electron flag", { flag: flag.name, value: flag.value });
    } else {
      app.commandLine.appendSwitch(flag.name);
      appLogger.info("Applied Electron flag", { flag: flag.name });
    }
  }
}

// Apply Electron command-line flags IMMEDIATELY after logging is available.
// CRITICAL: Must be before app.whenReady() and any code that might trigger GPU initialization.
applyElectronFlags();

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

const fileSystemLayer = new DefaultFileSystemLayer(loggingService.createLogger("fs"));

/**
 * Redirect Electron's data paths to isolate from system defaults.
 * This prevents conflicts when running nested CodeHydra instances
 * (e.g., running CodeHydra inside a code-server terminal).
 *
 * CRITICAL: Must be called BEFORE app.whenReady()
 */
function redirectElectronDataPaths(): void {
  const electronDir = pathProvider.electronDataDir.toNative();
  ["userData", "sessionData", "logs", "crashDumps"].forEach((name) => {
    app.setPath(name, nodePath.join(electronDir, name));
  });
}

// Redirect Electron data paths before app is ready
redirectElectronDataPaths();

/**
 * Creates the code-server configuration using pathProvider.
 */
function createCodeServerConfig(): CodeServerConfig {
  return {
    port: getCodeServerPort(buildInfo),
    binaryPath: pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toNative(),
    runtimeDir: nodePath.join(pathProvider.dataRootDir.toNative(), "runtime"),
    extensionsDir: pathProvider.vscodeExtensionsDir.toNative(),
    userDataDir: pathProvider.vscodeUserDataDir.toNative(),
    binDir: pathProvider.binDir.toNative(),
    codeServerDir: pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toNative(),
    opencodeDir: pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toNative(),
  };
}

/** Cleanup function — defined as a closure inside bootstrap() to capture local variables. */
let cleanup: (() => Promise<void>) | null = null;

/**
 * Bootstraps the application.
 *
 * Creates all services, wires the intent dispatcher, loads UI, and dispatches app:start.
 *
 * The initialization flow is:
 * 1. Initialize logging and disable application menu
 * 2. Create BinaryDownloadService and setup managers
 * 3. Regenerate wrapper scripts (cheap operation on every startup)
 * 4. Create WindowManager and ViewManager
 * 5. Initialize bootstrap with ApiRegistry and lifecycle handlers
 * 6. Load UI
 * 7. Dispatch app:start intent (checks setup, runs app:setup if needed, starts services)
 */
async function bootstrap(): Promise<void> {
  // Mutable reference: set after initializeBootstrap(), read by lazy closures
  let codeHydraApi: ICodeHydraApi | null = null;

  // 0. Initialize logging service (enables renderer logging via IPC)
  loggingService.initialize();
  registerLogHandlers(loggingService);
  const appLogger = loggingService.createLogger("app");
  appLogger.info("Bootstrap starting", {
    version: buildInfo.version,
    isDev: buildInfo.isDevelopment,
  });

  // 1. Create platform layers and disable application menu
  const dialogLayer = new DefaultDialogLayer(loggingService.createLogger("dialog"));
  const menuLayer = new DefaultMenuLayer(loggingService.createLogger("menu"));
  menuLayer.setApplicationMenu(null);

  // 2. Create ConfigService first to load agent selection
  const configService = new ConfigService({
    fileSystem: fileSystemLayer,
    pathProvider,
    logger: loggingService.createLogger("config"),
  });

  // 2b. Create TelemetryService for PostHog analytics
  // Uses build-time injected API key and host (see vite.config)
  // Operates in no-op mode if API key is missing or telemetry is disabled
  const telemetryService = new PostHogTelemetryService({
    buildInfo,
    platformInfo,
    configService,
    logger: loggingService.createLogger("telemetry"),
    apiKey: typeof __POSTHOG_API_KEY__ !== "undefined" ? __POSTHOG_API_KEY__ : undefined,
    host: typeof __POSTHOG_HOST__ !== "undefined" ? __POSTHOG_HOST__ : undefined,
  });

  // Register global error handlers for uncaught exceptions
  // Use prependListener to capture errors before other handlers
  process.prependListener("uncaughtException", (error: Error) => {
    telemetryService?.captureError(error);
    // Re-throw to let default handler take over
    throw error;
  });
  process.prependListener("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    telemetryService?.captureError(error);
    // Re-throw to let default handler take over
    throw error;
  });

  // 3. Create platform layers and setup services

  // Process runner uses platform-native tree killing (taskkill on Windows, process.kill on Unix)
  const processRunner = new ExecaProcessRunner(loggingService.createLogger("process"));

  // Create network layer for binary downloads
  const networkLayerForSetup = new DefaultNetworkLayer(loggingService.createLogger("network"));

  // Create BinaryDownloadService for downloading code-server and opencode
  const binaryDownloadService: BinaryDownloadService = new DefaultBinaryDownloadService(
    networkLayerForSetup,
    fileSystemLayer,
    new DefaultArchiveExtractor(),
    pathProvider,
    platformInfo,
    loggingService.createLogger("binary-download")
  );

  // 3. Regenerate wrapper scripts (cheap operation, ensures they always exist)
  await setupBinDirectory(fileSystemLayer, pathProvider);

  // 3b. Create setup managers for app:setup hook modules
  // CodeServerManager for setup (preflight + download only, not runtime)
  const codeServerConfig = createCodeServerConfig();
  const setupCodeServerManager = new CodeServerManager(
    codeServerConfig,
    processRunner,
    networkLayerForSetup,
    networkLayerForSetup,
    loggingService.createLogger("code-server"),
    binaryDownloadService
  );

  // AgentBinaryManager factory - creates manager for specific agent type
  const getAgentBinaryManager = (agentType: ConfigAgentType): AgentBinaryManager => {
    return new AgentBinaryManager(
      agentType,
      binaryDownloadService,
      loggingService.createLogger("agent-binary")
    );
  };

  // ExtensionManager for extension preflight/install
  const setupExtensionManager = new ExtensionManager(
    pathProvider,
    fileSystemLayer,
    processRunner,
    loggingService.createLogger("ext-manager")
  );

  // 4. Create WindowManager with appropriate title and icon
  // When not packaged, show branch name: "CodeHydra (branch-name)"
  const windowTitle =
    !buildInfo.isPackaged && buildInfo.gitBranch
      ? `CodeHydra (${buildInfo.gitBranch})`
      : "CodeHydra";

  // Create ImageLayer (shared between WindowLayer and BadgeManager)
  // Must be a single instance so ImageHandles are resolvable across components
  const imageLayer = new DefaultImageLayer(loggingService.createLogger("window"));

  // Create WindowLayer for WindowManager
  const windowLogger = loggingService.createLogger("window");
  const windowLayer = new DefaultWindowLayer(imageLayer, platformInfo, windowLogger);

  const windowManager = WindowManager.create(
    {
      windowLayer,
      imageLayer,
      logger: windowLogger,
      platformInfo,
    },
    windowTitle,
    pathProvider.appIconPath.toNative()
  );

  // 5. Create ViewLayer and SessionLayer for ViewManager
  const viewLogger = loggingService.createLogger("view");
  const sessionLayer = new DefaultSessionLayer(viewLogger);
  const viewLayer = new DefaultViewLayer(windowLayer, viewLogger);

  // 6. Create dispatcher early so ShortcutController can dispatch intents
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // 6b. Create ViewManager with port=0 initially
  // Port will be updated when startServices() runs
  const viewManager = ViewManager.create({
    windowManager,
    windowLayer,
    viewLayer,
    sessionLayer,
    config: {
      uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
      codeServerPort: 0,
    },
    logger: viewLogger,
    setModeFn: (mode) => {
      void dispatcher.dispatch({
        type: INTENT_SET_MODE,
        payload: { mode },
      } as SetModeIntent);
    },
  });

  // 6c. Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // Capture viewManager for closure (TypeScript narrow refinement doesn't persist)
  const viewManagerRef = viewManager;

  // 7. Create runtime services (non-agent, used by lifecycle modules)
  // Agent services are created lazily by AgentModule during its start hook.
  const networkLayer = new DefaultNetworkLayer(loggingService.createLogger("network"));

  const pluginLogger = loggingService.createLogger("plugin");
  const extensionLogger = loggingService.createLogger("extension");
  const pluginServer = new PluginServer(networkLayer, pluginLogger, {
    isDevelopment: buildInfo.isDevelopment,
    extensionLogger,
  });

  const runtimeCodeServerConfig = createCodeServerConfig();
  const codeServerManager = new CodeServerManager(
    runtimeCodeServerConfig,
    processRunner,
    networkLayer,
    networkLayer,
    loggingService.createLogger("code-server")
  );

  const projectStore = new ProjectStore(
    pathProvider.projectsDir.toString(),
    fileSystemLayer,
    pathProvider.remotesDir.toString()
  );
  const gitClient = new SimpleGitClient(loggingService.createLogger("git"));
  const globalWorktreeProvider = new GitWorktreeProvider(
    gitClient,
    fileSystemLayer,
    loggingService.createLogger("worktree")
  );
  const workspaceFileConfig = createWorkspaceFileConfig();
  const workspaceFileService = new WorkspaceFileService(
    fileSystemLayer,
    workspaceFileConfig,
    loggingService.createLogger("workspace-file")
  );

  const appLayer = new DefaultAppLayer(loggingService.createLogger("badge"));
  const badgeManager = new BadgeManager(
    platformInfo,
    appLayer,
    imageLayer,
    windowManager,
    loggingService.createLogger("badge")
  );

  const autoUpdater = new AutoUpdater({
    logger: loggingService.createLogger("updater"),
    isDevelopment: buildInfo.isDevelopment,
  });

  // 7a. Create agent services upfront (both server managers + status manager).
  // Both constructors are pure field assignment (no I/O). Agent type is selected at runtime
  // by AgentModule during its start hook.
  const serverManagerDeps = {
    processRunner,
    portManager: networkLayer,
    httpClient: networkLayer,
    pathProvider,
    fileSystem: fileSystemLayer,
    logger: loggingService.createLogger("agent"),
  };
  const agentServerManagers = {
    claude: createAgentServerManager("claude", serverManagerDeps),
    opencode: createAgentServerManager("opencode", serverManagerDeps),
  };
  const agentStatusManager = new AgentStatusManager(loggingService.createLogger("agent"));

  // 7b. Create McpServerManager with lazy API factory (API is not available until after bootstrap)
  const mcpServerManager = new McpServerManager(
    networkLayer,
    pathProvider,
    () => {
      if (!codeHydraApi) {
        throw new Error("API not initialized");
      }
      return codeHydraApi;
    },
    loggingService.createLogger("mcp")
  );

  // 7c. Create services needed for BootstrapDeps
  const keepFilesService = new KeepFilesService(
    fileSystemLayer,
    loggingService.createLogger("keepfiles")
  );

  // Wrap DialogLayer to match MinimalDialog interface (converts Path to string)
  const dialog = {
    showOpenDialog: async (options: { properties: string[] }) => {
      const result = await dialogLayer.showOpenDialog({
        properties:
          options.properties as import("../services/platform/dialog").OpenDialogProperty[],
      });
      return {
        canceled: result.canceled,
        filePaths: result.filePaths.map((p) => p.toString()),
      };
    },
  };

  const workspaceLockHandler = createWorkspaceLockHandler(
    processRunner,
    platformInfo,
    loggingService.createLogger("process"),
    nodePath.join(pathProvider.scriptsRuntimeDir.toNative(), "blocking-processes.ps1")
  );

  // 8. Initialize bootstrap with API registry and all modules
  const ipcLayer = new DefaultIpcLayer(loggingService.createLogger("api"));
  const bootstrapResult = initializeBootstrap({
    logger: loggingService.createLogger("api"),
    ipcLayer,
    app,
    viewManager,
    gitClient,
    pathProvider,
    projectStore,
    globalWorktreeProvider,
    keepFilesService,
    workspaceFileService,
    emitDeletionProgress: (progress: import("../shared/api/types").DeletionProgress) => {
      try {
        viewManagerRef
          ?.getUIWebContents()
          ?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      } catch {
        // Log but don't throw - deletion continues even if UI disconnected
      }
    },
    killTerminalsCallback: async (workspacePath: string) => {
      await pluginServer.sendExtensionHostShutdown(workspacePath);
    },
    workspaceLockHandler,
    hookRegistry,
    dispatcher,
    setTitle: (title: string) => windowManager?.setTitle(title),
    titleVersion: buildInfo.gitBranch ?? buildInfo.version,
    badgeManager,
    agentServerManagers,
    agentStatusManager,
    mcpServerManager,
    pluginServer,
    getApiFn: () => {
      if (!codeHydraApi) {
        throw new Error("API not initialized");
      }
      return codeHydraApi;
    },
    loggingService,
    telemetryService,
    platformInfo,
    buildInfo,
    autoUpdater,
    codeServerManager,
    fileSystemLayer,
    viewLayer,
    windowLayer,
    sessionLayer,
    getUIWebContentsFn: () => viewManager?.getUIWebContents() ?? null,
    wrapperPath: pathProvider.claudeCodeWrapperPath.toString(),
    dialog,
    setupDeps: {
      configService,
      codeServerManager: setupCodeServerManager,
      getAgentBinaryManager,
      extensionManager: setupExtensionManager,
    },
  });

  // Get the typed API interface (all methods are now registered)
  codeHydraApi = bootstrapResult.getInterface();

  // Wire lifecycle:setup-progress events to IPC immediately (before UI loads)
  bootstrapResult.registry.on("lifecycle:setup-progress", (payload) => {
    const webContents = viewManager?.getUIWebContents();
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_PROGRESS, payload);
    }
  });
  bootstrapResult.registry.on("lifecycle:setup-error", (payload) => {
    const webContents = viewManager?.getUIWebContents();
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, payload);
    }
  });

  // 8. Load UI layer HTML
  // Renderer starts in "initializing" mode and waits for IPC events
  // Use file:// URL to load local HTML file
  const uiHtmlPath = `file://${nodePath.join(__dirname, "../renderer/index.html")}`;
  await viewLayer.loadURL(viewManager.getUIViewHandle(), uiHtmlPath);

  // Focus UI layer so keyboard shortcuts (Alt+X) work immediately on startup
  viewManager.focusUI();

  // Define cleanup as a closure capturing local variables
  cleanup = async () => {
    const shutdownLogger = loggingService.createLogger("app");
    shutdownLogger.info("Shutdown initiated");

    try {
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);
    } catch (error) {
      shutdownLogger.error(
        "Shutdown dispatch failed (continuing cleanup)",
        {},
        error instanceof Error ? error : undefined
      );
    }

    viewManager.destroy();
    await bootstrapResult.dispose();

    cleanup = null;
    shutdownLogger.info("Cleanup complete");
  };

  // 9. Dispatch app:start to orchestrate the startup flow
  // This shows the starting screen, checks if setup is needed, and dispatches app:setup if required.
  // After setup (if any), it runs start and activate hooks to complete startup.
  appLogger.info("Dispatching app:start");
  void dispatcher
    .dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent)
    .catch((error: unknown) => {
      appLogger.error(
        "Startup failed",
        { error: getErrorMessage(error) },
        error instanceof Error ? error : undefined
      );

      dialogLayer.showErrorBox("Startup Failed", getErrorMessage(error));

      app.quit();
    });

  // 10. Open DevTools in development only
  // Note: DevTools not auto-opened to avoid z-order issues on Linux.
  // Use Ctrl+Shift+I to open manually when needed (opens detached).
  if (buildInfo.isDevelopment) {
    const uiWebContents = viewManager.getUIWebContents();
    if (uiWebContents) {
      uiWebContents.on("before-input-event", (event: Electron.Event, input: Electron.Input) => {
        if (input.control && input.shift && input.key === "I") {
          if (uiWebContents.isDevToolsOpened()) {
            uiWebContents.closeDevTools();
          } else {
            uiWebContents.openDevTools({ mode: "detach" });
          }
          event.preventDefault();
        }
      });
    }
  }
}

// App lifecycle handlers
app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    const appLogger = loggingService.createLogger("app");
    appLogger.error(
      "Fatal error",
      { error: getErrorMessage(error) },
      error instanceof Error ? error : undefined
    );
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void cleanup?.().then(() => app.quit());
  }
});

app.on("activate", () => {
  if (cleanup === null) {
    void bootstrap().catch((error: unknown) => {
      const appLogger = loggingService.createLogger("app");
      appLogger.error(
        "Bootstrap failed on activate",
        { error: getErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  }
});

app.on("before-quit", () => {
  // Fire-and-forget cleanup. The shutdown idempotency interceptor ensures
  // only one execution proceeds (window-all-closed also calls cleanup).
  void cleanup?.();
});
