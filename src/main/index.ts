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
import { PostHogTelemetryService, type TelemetryService } from "../services/telemetry";
import { AutoUpdater } from "../services/auto-updater";
import { ExecaProcessRunner } from "../services/platform/process";
import { DefaultIpcLayer } from "../services/platform/ipc";
import { DefaultAppLayer } from "../services/platform/app";
import { DefaultImageLayer, type ImageLayer } from "../services/platform/image";
import { DefaultDialogLayer, type DialogLayer } from "../services/platform/dialog";
import { DefaultMenuLayer, type MenuLayer } from "../services/platform/menu";
import { DefaultWindowLayer, type WindowLayerInternal } from "../services/shell/window";
import { DefaultViewLayer, type ViewLayer } from "../services/shell/view";
import { DefaultSessionLayer, type SessionLayer } from "../services/shell/session";
import {
  DefaultBinaryDownloadService,
  DefaultArchiveExtractor,
  AgentBinaryManager,
  type BinaryDownloadService,
  CODE_SERVER_VERSION,
  OPENCODE_VERSION,
} from "../services/binary-download";
import { ExtensionManager } from "../services/vscode-setup/extension-manager";
import type { AgentStatusManager, AgentType, AgentServerManager } from "../agents";
import { PluginServer, type ConfigDataProvider } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { registerLogHandlers } from "./ipc";
import { initializeBootstrap, type BootstrapResult } from "./bootstrap";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { wireModules } from "./intents/infrastructure/wire";
import { createMcpModule } from "./modules/mcp-module";
import { INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent } from "./operations/set-mode";
import { INTENT_APP_SHUTDOWN } from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import { INTENT_APP_START } from "./operations/app-start";
import type { AppStartIntent } from "./operations/app-start";
import type { CoreModuleDeps } from "./modules/core";
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

// Global state
let windowManager: WindowManager | null = null;
let viewManager: ViewManager | null = null;
let selectedAgentTypeValue: AgentType | null = null;
let codeServerManager: CodeServerManager | null = null;
let agentStatusManager: AgentStatusManager | null = null;
let badgeManager: BadgeManager | null = null;
let mcpServerManager: McpServerManager | null = null;
let codeHydraApi: ICodeHydraApi | null = null;

/**
 * PluginServer for VS Code extension communication.
 * Created in bootstrap() before initializeBootstrap().
 */
let pluginServer: PluginServer | null = null;

/**
 * Shared ProcessRunner instance for CodeServerManager and other services.
 * Created once in bootstrap() and reused for all process spawning.
 */
let processRunner: ExecaProcessRunner | null = null;

/**
 * Bootstrap result containing API registry and modules.
 * Created in bootstrap() with initializeBootstrap().
 */
let bootstrapResult: BootstrapResult | null = null;

/**
 * Dispatcher instance for the intent system.
 * Created in bootstrap() and used for intent dispatch throughout the app lifecycle.
 */
let dispatcherInstance: Dispatcher | null = null;

/**
 * HookRegistry instance for the intent system.
 * Created in bootstrap() and used for wiring lifecycle modules.
 */
let hookRegistryInstance: HookRegistry | null = null;

/**
 * DialogLayer for showing system dialogs.
 * Created in bootstrap() before any dialogs are shown.
 */
let dialogLayer: DialogLayer | null = null;

/**
 * MenuLayer for managing application menu.
 * Created in bootstrap() before setting application menu.
 */
let menuLayer: MenuLayer | null = null;

/**
 * WindowLayer for managing windows.
 * Created in bootstrap() for WindowManager.
 */
let windowLayer: WindowLayerInternal | null = null;

/**
 * ViewLayer for managing views.
 * Created in bootstrap() for ViewManager.
 */
let viewLayer: ViewLayer | null = null;

/**
 * SessionLayer for managing sessions.
 * Created in bootstrap() for ViewManager.
 */
let sessionLayer: SessionLayer | null = null;

/**
 * ImageLayer for image operations.
 * Created in bootstrap() and shared between WindowLayer and BadgeManager.
 * Must be a single instance so ImageHandles are resolvable across components.
 */
let imageLayer: ImageLayer | null = null;

/**
 * ConfigService for loading/saving agent selection.
 * Created in bootstrap(), used by lifecycle modules for agent configuration.
 */
let configService: import("../services/config/config-service").ConfigService | null = null;

/**
 * TelemetryService for PostHog analytics.
 * Created in bootstrap() after configService.
 */
let telemetryService: TelemetryService | null = null;

/**
 * AutoUpdater for checking and applying updates.
 * Created in bootstrap() before initializeBootstrap().
 */
let autoUpdater: AutoUpdater | null = null;

/**
 * GitClient for clone operations.
 * Created in bootstrap() for use in CoreModule.
 */
let gitClient: import("../services").IGitClient | null = null;

/**
 * ProjectStore for project configuration storage.
 * Created in bootstrap() for use in CoreModule.
 */
let projectStore: import("../services").ProjectStore | null = null;

/**
 * Global worktree provider. Created in bootstrap(), shared across all projects.
 * Used by intent dispatcher for metadata operations.
 */
let globalWorktreeProvider: GitWorktreeProvider | null = null;

/**
 * WorkspaceFileService for .code-workspace file management.
 * Created in bootstrap(), used by intent dispatcher for delete operations.
 */
let workspaceFileService: import("../services").IWorkspaceFileService | null = null;

/**
 * Bootstraps the application.
 *
 * Creates all services, wires the intent dispatcher, loads UI, and dispatches app:start.
 * Agent services (ServerManager, AgentStatusManager) are created lazily during
 * the app:start "start" hook by AgentModule.
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
  // 0. Initialize logging service (enables renderer logging via IPC)
  loggingService.initialize();
  registerLogHandlers(loggingService);
  const appLogger = loggingService.createLogger("app");
  appLogger.info("Bootstrap starting", {
    version: buildInfo.version,
    isDev: buildInfo.isDevelopment,
  });

  // 1. Create platform layers and disable application menu
  dialogLayer = new DefaultDialogLayer(loggingService.createLogger("dialog"));
  menuLayer = new DefaultMenuLayer(loggingService.createLogger("menu"));
  menuLayer.setApplicationMenu(null);

  // 2. Create ConfigService first to load agent selection
  configService = new ConfigService({
    fileSystem: fileSystemLayer,
    pathProvider,
    logger: loggingService.createLogger("config"),
  });

  // 2b. Create TelemetryService for PostHog analytics
  // Uses build-time injected API key and host (see vite.config)
  // Operates in no-op mode if API key is missing or telemetry is disabled
  telemetryService = new PostHogTelemetryService({
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

  // Store processRunner in module-level variable for reuse by CodeServerManager
  // Process runner uses platform-native tree killing (taskkill on Windows, process.kill on Unix)
  processRunner = new ExecaProcessRunner(loggingService.createLogger("process"));

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
  imageLayer = new DefaultImageLayer(loggingService.createLogger("window"));

  // Create WindowLayer for WindowManager
  const windowLogger = loggingService.createLogger("window");
  windowLayer = new DefaultWindowLayer(imageLayer, platformInfo, windowLogger);

  windowManager = WindowManager.create(
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
  sessionLayer = new DefaultSessionLayer(viewLogger);
  viewLayer = new DefaultViewLayer(windowLayer, viewLogger);

  // 6. Create dispatcher early so ShortcutController can dispatch intents
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  dispatcherInstance = dispatcher;
  hookRegistryInstance = hookRegistry;

  // 6b. Create ViewManager with port=0 initially
  // Port will be updated when startServices() runs
  viewManager = ViewManager.create({
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
  pluginServer = new PluginServer(networkLayer, pluginLogger, {
    isDevelopment: buildInfo.isDevelopment,
    extensionLogger,
  });

  const runtimeCodeServerConfig = createCodeServerConfig();
  codeServerManager = new CodeServerManager(
    runtimeCodeServerConfig,
    processRunner,
    networkLayer,
    networkLayer,
    loggingService.createLogger("code-server")
  );

  projectStore = new ProjectStore(
    pathProvider.projectsDir.toString(),
    fileSystemLayer,
    pathProvider.remotesDir.toString()
  );
  gitClient = new SimpleGitClient(loggingService.createLogger("git"));
  globalWorktreeProvider = new GitWorktreeProvider(
    gitClient,
    fileSystemLayer,
    loggingService.createLogger("worktree")
  );
  const workspaceFileConfig = createWorkspaceFileConfig();
  workspaceFileService = new WorkspaceFileService(
    fileSystemLayer,
    workspaceFileConfig,
    loggingService.createLogger("workspace-file")
  );

  const appLayer = new DefaultAppLayer(loggingService.createLogger("badge"));
  badgeManager = new BadgeManager(
    platformInfo,
    appLayer,
    imageLayer!,
    windowManager,
    loggingService.createLogger("badge")
  );

  autoUpdater = new AutoUpdater({
    logger: loggingService.createLogger("updater"),
    isDevelopment: buildInfo.isDevelopment,
  });

  // onAgentInitialized callback: AgentModule calls this during its start hook
  // to publish agent services so lifecycleRefs lazy getters can resolve.
  const onAgentInitialized = (services: {
    serverManager: AgentServerManager;
    agentStatusManager: AgentStatusManager;
    selectedAgentType: AgentType;
  }) => {
    agentStatusManager = services.agentStatusManager;
    selectedAgentTypeValue = services.selectedAgentType;
  };

  // 8. Initialize bootstrap with API registry and all modules
  const ipcLayer = new DefaultIpcLayer(loggingService.createLogger("api"));
  bootstrapResult = initializeBootstrap({
    logger: loggingService.createLogger("api"),
    ipcLayer,
    app,
    // Core module deps
    coreDepsFn: (): CoreModuleDeps => {
      // Wrap DialogLayer to match MinimalDialog interface (converts Path to string)
      // dialogLayer is guaranteed set by bootstrap() before startServices()
      const dialogLayerRef = dialogLayer;
      const dialog = dialogLayerRef
        ? {
            showOpenDialog: async (options: { properties: string[] }) => {
              const result = await dialogLayerRef.showOpenDialog({
                properties:
                  options.properties as import("../services/platform/dialog").OpenDialogProperty[],
              });
              return {
                canceled: result.canceled,
                filePaths: result.filePaths.map((p) => p.toString()),
              };
            },
          }
        : undefined;

      return {
        // resolveWorkspace is overridden in wireDispatcher with the workspace index
        resolveWorkspace: () => {
          throw new Error("resolveWorkspace not wired yet");
        },
        codeServerPort: 0, // Updated by CodeServerLifecycleModule
        wrapperPath: pathProvider.claudeCodeWrapperPath.toString(),
        ...(dialog ? { dialog } : {}),
        ...(pluginServer ? { pluginServer } : {}),
      };
    },
    // View manager for workspace view lifecycle
    viewManagerFn: () => {
      if (!viewManager) {
        throw new Error("ViewManager not initialized");
      }
      return viewManager;
    },
    // Git client for clone operations
    gitClientFn: () => {
      if (!gitClient) {
        throw new Error("GitClient not initialized");
      }
      return gitClient;
    },
    // Path provider for directory paths
    pathProviderFn: () => pathProvider,
    // Project store for project persistence
    projectStoreFn: () => {
      if (!projectStore) {
        throw new Error("ProjectStore not initialized");
      }
      return projectStore;
    },
    // Global worktree provider for metadata operations
    globalWorktreeProviderFn: () => {
      if (!globalWorktreeProvider) {
        throw new Error("Global worktree provider not initialized");
      }
      return globalWorktreeProvider;
    },
    // KeepFilesService for copying .keepfiles to new workspaces
    keepFilesServiceFn: () =>
      new KeepFilesService(fileSystemLayer, loggingService.createLogger("keepfiles")),
    // WorkspaceFileService for .code-workspace file management
    workspaceFileServiceFn: () => {
      if (!workspaceFileService) {
        throw new Error("WorkspaceFileService not initialized");
      }
      return workspaceFileService;
    },
    // Deletion progress callback for emitting DeletionProgress to the renderer
    emitDeletionProgressFn: () => (progress: import("../shared/api/types").DeletionProgress) => {
      try {
        viewManagerRef
          ?.getUIWebContents()
          ?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      } catch {
        // Log but don't throw - deletion continues even if UI disconnected
      }
    },
    // Kill terminals callback (only when PluginServer is available)
    killTerminalsCallbackFn: () =>
      pluginServer
        ? async (workspacePath: string) => {
            await pluginServer!.sendExtensionHostShutdown(workspacePath);
          }
        : undefined,
    // Workspace lock handler for Windows file handle detection
    workspaceLockHandlerFn: () => {
      if (!processRunner) {
        return undefined;
      }
      return createWorkspaceLockHandler(
        processRunner,
        platformInfo,
        loggingService.createLogger("process"),
        nodePath.join(pathProvider.scriptsRuntimeDir.toNative(), "blocking-processes.ps1")
      );
    },
    // Dispatcher created early so ShortcutController can dispatch intents
    dispatcherFn: () => ({ hookRegistry, dispatcher }),
    // Window title setter for SwitchTitleModule
    setTitleFn: () => (title: string) => windowManager?.setTitle(title),
    // Version suffix for window title (branch in dev, version in packaged)
    titleVersionFn: () => buildInfo.gitBranch ?? buildInfo.version,
    // BadgeManager
    badgeManagerFn: () => badgeManager!,
    // ServerManagerDeps for AgentModule to create AgentServerManager
    serverManagerDeps: {
      processRunner,
      portManager: networkLayer,
      httpClient: networkLayer,
      pathProvider,
      fileSystem: fileSystemLayer,
      logger: loggingService.createLogger("app"),
    },
    // Callback for AgentModule to publish agent services
    onAgentInitialized,
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
    autoUpdater: autoUpdater!,
    agentStatusManagerFn: () => agentStatusManager!,
    codeServerManager: codeServerManager!,
    fileSystemLayer,
    configDataProviderFn: (): ConfigDataProvider => {
      return (workspacePath: string) => {
        const env =
          agentStatusManager
            ?.getProvider(workspacePath as import("../shared/ipc").WorkspacePath)
            ?.getEnvironmentVariables() ?? null;
        return { env, agentType: selectedAgentTypeValue! };
      };
    },
    // Shell layers for ViewModule (available immediately from bootstrap)
    viewLayer,
    windowLayer,
    sessionLayer,
    // Function to get UI webContents for setup error IPC events
    // ViewManager is available after bootstrap creates it
    getUIWebContentsFn: () => viewManager?.getUIWebContents() ?? null,
    // Setup dependencies for app:setup hook modules
    setupDeps: {
      configService: configService!,
      codeServerManager: setupCodeServerManager,
      getAgentBinaryManager,
      extensionManager: setupExtensionManager,
    },
  });

  // Get the typed API interface (all methods are now registered)
  codeHydraApi = bootstrapResult.getInterface();

  // Create McpServerManager now that API is available
  mcpServerManager = new McpServerManager(
    networkLayer,
    pathProvider,
    codeHydraApi,
    loggingService.createLogger("mcp")
  );

  // Wire MCP module (must happen before app:start's "start" hook collects handlers)
  const mcpModule = createMcpModule({
    mcpServerManager,
    logger: loggingService.createLogger("mcp"),
  });
  wireModules([mcpModule], hookRegistryInstance!, dispatcherInstance!);

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

  // 9. Dispatch app:start to orchestrate the startup flow
  // This shows the starting screen, checks if setup is needed, and dispatches app:setup if required.
  // After setup (if any), it runs start and activate hooks to complete startup.
  appLogger.info("Dispatching app:start");
  void dispatcherInstance!
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

      if (dialogLayer) {
        dialogLayer.showErrorBox("Startup Failed", getErrorMessage(error));
      }

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

/**
 * Cleans up resources on shutdown.
 *
 * Dispatches `app:shutdown` intent, which runs lifecycle module stop hooks
 * (each module disposes its own resources, best-effort with internal try/catch).
 * The shutdown idempotency interceptor ensures only one execution proceeds.
 *
 * After the intent completes, disposes the API registry/modules and clears
 * module-level references.
 */
async function cleanup(): Promise<void> {
  const appLogger = loggingService.createLogger("app");
  appLogger.info("Shutdown initiated");

  // Dispatch app:shutdown -- lifecycle modules handle all disposal
  // Idempotency interceptor blocks duplicate dispatches (from before-quit + window-all-closed)
  if (dispatcherInstance) {
    try {
      await dispatcherInstance.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);
    } catch (error) {
      appLogger.error(
        "Shutdown dispatch failed (continuing cleanup)",
        {},
        error instanceof Error ? error : undefined
      );
    }
  }

  // Destroy all views (concrete ViewManager, not on IViewManager interface)
  if (viewManager) {
    viewManager.destroy();
  }

  // Dispose API registry and modules
  if (bootstrapResult) {
    await bootstrapResult.dispose();
    bootstrapResult = null;
  }
  codeHydraApi = null;

  // Clear module-level references
  windowManager = null;
  viewManager = null;
  selectedAgentTypeValue = null;
  codeServerManager = null;
  agentStatusManager = null;
  badgeManager = null;
  mcpServerManager = null;
  dispatcherInstance = null;
  hookRegistryInstance = null;

  // Clear shell layer references (disposed by ViewLifecycleModule)
  viewLayer = null;
  windowLayer = null;
  sessionLayer = null;

  // Clear lifecycle service references (disposed by their respective modules)
  pluginServer = null;
  autoUpdater = null;
  telemetryService = null;

  // DialogLayer, MenuLayer don't have dispose() methods
  dialogLayer = null;
  menuLayer = null;

  appLogger.info("Cleanup complete");
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
    void cleanup().then(() => app.quit());
  }
});

app.on("activate", () => {
  if (windowManager === null) {
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
  void cleanup();
});
