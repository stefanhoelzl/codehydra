/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 */

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
  type CodeServerConfig,
  type PathProvider,
  type BuildInfo,
  type LoggingService,
} from "../services";
import { VscodeSetupService } from "../services/vscode-setup";
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
  type BinaryDownloadService,
} from "../services/binary-download";
import { AgentStatusManager, OpenCodeServerManager } from "../services/opencode";
import { PluginServer, sendStartupCommands } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { wirePluginApi } from "./api/wire-plugin-api";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { AppState } from "./app-state";
import { wireApiEvents, formatWindowTitle, registerLogHandlers } from "./ipc";
import { initializeBootstrap, type BootstrapResult } from "./bootstrap";
import type { CoreModuleDeps } from "./modules/core";
import type { UiModuleDeps } from "./modules/ui";
import { generateProjectId, extractWorkspaceName } from "./api/id-utils";
import type { ICodeHydraApi, Unsubscribe } from "../shared/api/interfaces";
import type { WorkspaceName, WorkspaceStatus } from "../shared/api/types";
import { ApiIpcChannels, type WorkspaceLoadingChangedPayload } from "../shared/ipc";
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

// Disable ASAR virtual filesystem in development mode.
// Prevents file handle issues on Windows when deleting workspaces
// that contain node_modules/electron directories.
if (buildInfo.isDevelopment) {
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
    binaryPath: pathProvider.codeServerBinaryPath.toNative(),
    runtimeDir: nodePath.join(pathProvider.dataRootDir.toNative(), "runtime"),
    extensionsDir: pathProvider.vscodeExtensionsDir.toNative(),
    userDataDir: pathProvider.vscodeUserDataDir.toNative(),
    binDir: pathProvider.binDir.toNative(),
    codeServerDir: pathProvider.codeServerDir.toNative(),
    opencodeDir: pathProvider.opencodeDir.toNative(),
  };
}

// Global state
let windowManager: WindowManager | null = null;
let viewManager: ViewManager | null = null;
let appState: AppState | null = null;
let codeServerManager: CodeServerManager | null = null;
let agentStatusManager: AgentStatusManager | null = null;
let badgeManager: BadgeManager | null = null;
let serverManager: OpenCodeServerManager | null = null;
let mcpServerManager: McpServerManager | null = null;
let codeHydraApi: ICodeHydraApi | null = null;
let apiEventCleanup: Unsubscribe | null = null;
let agentStatusCleanup: Unsubscribe | null = null;
let mcpFirstRequestCleanup: Unsubscribe | null = null;
let loadingChangeCleanup: Unsubscribe | null = null;

/**
 * PluginServer for VS Code extension communication.
 * Started in startServices() before code-server.
 */
let pluginServer: PluginServer | null = null;

/**
 * Shared ProcessRunner instance for both VscodeSetupService and CodeServerManager.
 * Created once in bootstrap() and reused for all process spawning.
 */
let processRunner: ExecaProcessRunner | null = null;

/**
 * Setup service for first-run configuration.
 */
let vscodeSetupService: VscodeSetupService | null = null;

/**
 * Bootstrap result containing API registry and modules.
 * Created in bootstrap() with initializeBootstrap().
 */
let bootstrapResult: (BootstrapResult & { startServices: () => void }) | null = null;

/**
 * Flag to track if services have been started.
 * Prevents double-initialization when both bootstrap and setup flow might call startServices.
 */
let servicesStarted = false;

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
 * Starts all application services after setup completes.
 * This is the second phase of the two-phase startup:
 * bootstrap() → startServices()
 *
 * CRITICAL: Called by LifecycleModule's onSetupComplete callback BEFORE
 * returning the setup result to the renderer. This ensures IPC handlers
 * are registered before MainView mounts.
 */
async function startServices(): Promise<void> {
  // Guard against double initialization
  if (servicesStarted) return;
  if (!windowManager || !viewManager) return;
  servicesStarted = true;

  // Start code-server
  const config = createCodeServerConfig();

  // Ensure required directories exist
  await Promise.all([
    fileSystemLayer.mkdir(config.runtimeDir),
    fileSystemLayer.mkdir(config.extensionsDir),
    fileSystemLayer.mkdir(config.userDataDir),
  ]);

  // Guard: processRunner must be initialized by bootstrap()
  if (!processRunner) {
    throw new Error("ProcessRunner not initialized - startServices called before bootstrap");
  }

  // Create shared network layer for all network operations
  const networkLayer = new DefaultNetworkLayer(loggingService.createLogger("network"));

  // Start PluginServer BEFORE code-server so port is available for environment variable
  // Graceful degradation: if PluginServer fails, log warning and continue (plugin is optional)
  try {
    const pluginLogger = loggingService.createLogger("plugin");
    const extensionLogger = loggingService.createLogger("extension");
    pluginServer = new PluginServer(networkLayer, pluginLogger, {
      isDevelopment: buildInfo.isDevelopment,
      extensionLogger,
    });
    const pluginPort = await pluginServer.start();
    loggingService.createLogger("app").info("PluginServer started", { port: pluginPort });

    // Wire up startup commands - sent when workspace extension connects
    pluginServer.onConnect((workspacePath) => {
      void sendStartupCommands(pluginServer!, workspacePath, pluginLogger);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    loggingService.createLogger("app").warn("PluginServer start failed", { error: message });
    // Continue without plugin server - it's optional functionality
    pluginServer = null;
  }

  // Use process runner directly (logging is now integrated)
  // Pass plugin port to code-server for CODEHYDRA_PLUGIN_PORT env var
  const codeServerConfig = pluginServer?.getPort()
    ? { ...config, pluginPort: pluginServer.getPort()! }
    : config;
  codeServerManager = new CodeServerManager(
    codeServerConfig,
    processRunner,
    networkLayer,
    networkLayer,
    loggingService.createLogger("code-server")
  );

  try {
    await codeServerManager.ensureRunning();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // Guard: dialogLayer must be initialized by bootstrap()
    if (dialogLayer) {
      await dialogLayer.showMessageBox({
        type: "error",
        title: "Code Server Error",
        message: "Failed to start code-server",
        detail: `${message}\n\nThe application cannot continue without code-server.`,
        buttons: ["Quit"],
      });
    }
    app.quit();
    return;
  }

  // Port is guaranteed to be set after successful ensureRunning()
  const port = codeServerManager.port()!;

  // Update ViewManager with code-server port
  viewManager.updateCodeServerPort(port);

  // Create ProjectStore and AppState
  const projectStore = new ProjectStore(pathProvider.projectsDir.toString(), fileSystemLayer);
  appState = new AppState(
    projectStore,
    viewManager,
    pathProvider,
    port,
    fileSystemLayer,
    loggingService
  );

  // Initialize OpenCode services
  // Create OpenCodeServerManager to manage one opencode server per workspace
  serverManager = new OpenCodeServerManager(
    processRunner,
    networkLayer, // PortManager
    networkLayer, // HttpClient
    pathProvider,
    loggingService.createLogger("opencode")
  );

  // Create AgentStatusManager (receives ports via callbacks from serverManager)
  agentStatusManager = new AgentStatusManager(loggingService.createLogger("opencode"));

  // Create and connect BadgeManager
  // Uses shared imageLayer (created in bootstrap) so ImageHandles are resolvable by WindowLayer
  if (!imageLayer) {
    throw new Error("ImageLayer not initialized - startServices called before bootstrap");
  }
  const appLayer = new DefaultAppLayer(loggingService.createLogger("badge"));
  badgeManager = new BadgeManager(
    platformInfo,
    appLayer,
    imageLayer,
    windowManager,
    loggingService.createLogger("badge")
  );
  badgeManager.connectToStatusManager(agentStatusManager);

  // Inject services into AppState and wire callbacks
  appState.setAgentStatusManager(agentStatusManager);
  appState.setServerManager(serverManager);

  // Guard: bootstrapResult must be initialized by bootstrap()
  if (!bootstrapResult) {
    throw new Error("Bootstrap not initialized - startServices called before bootstrap");
  }

  // Create remaining modules (CoreModule, UiModule)
  // The deps factory functions reference module-level appState/viewManager which are now set
  bootstrapResult.startServices();

  // Get the typed API interface (all methods are now registered)
  codeHydraApi = bootstrapResult.getInterface();

  // Wire PluginServer to CodeHydraApi (if PluginServer is running)
  if (pluginServer) {
    wirePluginApi(pluginServer, codeHydraApi, appState, loggingService.createLogger("plugin"));
  }

  // Default window title (used when no workspace is active)
  const defaultTitle = formatWindowTitle(undefined, undefined, buildInfo.gitBranch);

  // Capture references for closures (TypeScript narrow refinement doesn't persist)
  const windowManagerRef = windowManager;
  const appStateRef = appState;
  const viewManagerRef = viewManager;

  // Wire API events to IPC emission (with window title updates)
  apiEventCleanup = wireApiEvents(codeHydraApi, () => viewManager?.getUIWebContents() ?? null, {
    setTitle: (title) => windowManagerRef?.setTitle(title),
    defaultTitle,
    ...(buildInfo.gitBranch && { devBranch: buildInfo.gitBranch }),
    getProjectName: (workspacePath) => {
      const project = appStateRef?.findProjectForWorkspace(workspacePath);
      return project?.name;
    },
  });

  // Wire agent status changes to API events
  // This bridges the AgentStatusManager callback to the registry event system
  agentStatusCleanup = agentStatusManager.onStatusChanged((workspacePath, aggregatedStatus) => {
    // Find the project containing this workspace
    const project = appStateRef.findProjectForWorkspace(workspacePath);
    if (!project) return; // Workspace not in any known project, skip

    // Generate IDs
    const projectId = generateProjectId(project.path);
    const workspaceName = nodePath.basename(workspacePath) as WorkspaceName;

    // Convert old AggregatedAgentStatus to v2 WorkspaceStatus format
    // Note: isDirty is not available from the status callback, so we set it to false
    // The renderer will fetch the full status via getStatus() if needed
    const status: WorkspaceStatus =
      aggregatedStatus.status === "none"
        ? { isDirty: false, agent: { type: "none" } }
        : {
            isDirty: false,
            agent: {
              type: aggregatedStatus.status,
              counts: {
                idle: aggregatedStatus.counts.idle,
                busy: aggregatedStatus.counts.busy,
                total: aggregatedStatus.counts.idle + aggregatedStatus.counts.busy,
              },
            },
          };

    // Emit through the registry
    bootstrapResult?.registry.emit("workspace:status-changed", {
      projectId,
      workspaceName,
      path: workspacePath,
      status,
    });
  });

  // Initialize MCP server (must start before loading projects so port is available)
  // MCP server provides AI agent access to workspace API
  try {
    mcpServerManager = new McpServerManager(
      networkLayer, // PortManager
      pathProvider,
      codeHydraApi, // ICoreApi
      appState, // WorkspaceLookup
      loggingService.createLogger("mcp")
    );
    const mcpPort = await mcpServerManager.start();
    loggingService.createLogger("app").info("MCP server started", {
      port: mcpPort,
      configPath: pathProvider.opencodeConfig.toString(),
    });

    // Register callback for first MCP request per workspace
    // This is the primary signal for TUI attachment (marks workspace as loaded)
    // Also signals AgentStatusManager that TUI is attached (for status indicator)
    const agentStatusManagerRef = agentStatusManager;
    mcpFirstRequestCleanup = mcpServerManager.onFirstRequest((workspacePath) => {
      // setWorkspaceLoaded is idempotent (guards internally), no need to check isWorkspaceLoading
      viewManagerRef.setWorkspaceLoaded(workspacePath);
      // Mark TUI as attached for status indicator (shows green when TUI attaches)
      agentStatusManagerRef.setTuiAttached(workspacePath as import("../shared/ipc").WorkspacePath);
    });

    // Configure OpenCode servers to connect to MCP
    if (serverManager) {
      serverManager.setMcpConfig({
        configPath: pathProvider.opencodeConfig.toString(),
        port: mcpServerManager.getPort()!,
      });
    }

    // Inject MCP server manager into AppState (for clearing seen workspaces on deletion)
    appState.setMcpServerManager(mcpServerManager);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    loggingService.createLogger("app").warn("MCP server start failed", { error: message });
    // Continue without MCP server - it's optional functionality
    mcpServerManager = null;
  }

  // Load persisted projects FIRST (before wiring callback)
  // This prevents startup events from being emitted and racing with renderer
  await appState.loadPersistedProjects();

  // Wire workspace change callback AFTER loading projects
  // This ensures events are only emitted for user-initiated actions, not startup
  // Capture appState for closure - it's guaranteed to be set by now
  const appStateForCallback = appState;
  viewManager.onWorkspaceChange((path) => {
    if (path === null) {
      bootstrapResult?.registry.emit("workspace:switched", null);
      return;
    }
    const project = appStateForCallback.findProjectForWorkspace(path);
    if (!project) {
      // Workspace not found - skip event emission
      // This can happen during cleanup or race conditions
      return;
    }
    bootstrapResult?.registry.emit("workspace:switched", {
      projectId: generateProjectId(project.path),
      workspaceName: extractWorkspaceName(path),
      path,
    });
  });

  // Wire loading state changes to IPC
  // This emits loading changed events to the renderer for UI overlay display
  loadingChangeCleanup = viewManager.onLoadingChange((path, loading) => {
    try {
      const webContents = viewManagerRef.getUIWebContents();
      if (webContents && !webContents.isDestroyed()) {
        const payload: WorkspaceLoadingChangedPayload = {
          path: path as import("../shared/ipc").WorkspacePath,
          loading,
        };
        webContents.send(ApiIpcChannels.WORKSPACE_LOADING_CHANGED, payload);
      }
    } catch {
      // Ignore errors - UI might be disconnected during shutdown
    }
  });

  // Set first workspace active if any projects loaded
  const projects = await appState.getAllProjects();
  if (projects.length > 0) {
    const firstWorkspace = projects[0]?.workspaces[0];
    if (firstWorkspace) {
      viewManager.setActiveWorkspace(firstWorkspace.path);

      // Set initial window title (event is emitted but UI not loaded yet,
      // so renderer will get correct state via getActiveWorkspace() on mount)
      const projectName = projects[0]?.name;
      const workspaceName = nodePath.basename(firstWorkspace.path);
      const title = formatWindowTitle(projectName, workspaceName, buildInfo.gitBranch);
      windowManager.setTitle(title);
    }
  }
}

// NOTE: Legacy setup handlers (registerSetupReadyHandler, registerSetupRetryAndQuitHandlers,
// runSetupProcess, createSetupEmitters) have been removed. Setup is now handled entirely
// through the LifecycleModule (which registers lifecycle.* IPC handlers).

/**
 * Bootstraps the application.
 *
 * This is the first phase of the two-phase startup:
 * bootstrap() → startServices()
 *
 * The initialization flow is:
 * 1. Initialize logging and disable application menu
 * 2. Create VscodeSetupService, BinaryDownloadService
 * 3. Regenerate wrapper scripts (cheap operation on every startup)
 * 4. Run preflight to determine if setup is needed
 * 5. Create WindowManager and ViewManager
 * 6. Initialize bootstrap with ApiRegistry and LifecycleModule
 * 7. If setup complete, start services immediately
 * 8. Load UI (renderer will call lifecycle.getState() in onMount)
 *    - If "ready": renderer shows MainView
 *    - If "setup": renderer shows SetupScreen, calls lifecycle.setup()
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

  // 2. Create VscodeSetupService early (needed for LifecycleModule)
  // Note: Process tree provider is created lazily in startServices() using the factory

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

  vscodeSetupService = new VscodeSetupService(
    processRunner,
    pathProvider,
    fileSystemLayer,
    platformInfo,
    binaryDownloadService,
    loggingService.createLogger("vscode-setup")
  );

  // 3. Run preflight to determine if setup is needed
  const preflightResult = await vscodeSetupService.preflight();
  const setupComplete = preflightResult.success && !preflightResult.needsSetup;

  // 4. Create WindowManager with appropriate title and icon
  // In dev mode, show branch name: "CodeHydra (branch-name)"
  const windowTitle =
    buildInfo.isDevelopment && buildInfo.gitBranch
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

  // 6. Create ViewManager with port=0 initially
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
  });

  // 6b. Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // Capture viewManager for closure (TypeScript narrow refinement doesn't persist)
  const viewManagerRef = viewManager;

  // 7. Initialize bootstrap with API registry and modules
  // LifecycleModule is created immediately (handles lifecycle.* IPC)
  // CoreModule and UiModule are created when startServices() calls bootstrapResult.startServices()
  const ipcLayer = new DefaultIpcLayer(loggingService.createLogger("api"));
  bootstrapResult = initializeBootstrap({
    logger: loggingService.createLogger("api"),
    ipcLayer,
    // Lifecycle module deps - available now
    lifecycleDeps: {
      vscodeSetup: vscodeSetupService ?? undefined,
      app,
      doStartServices: async () => {
        appLogger.info("Starting services");
        await startServices();
        appLogger.info("Services started");
      },
      logger: loggingService.createLogger("lifecycle"),
    },
    // Core module deps - factory that captures module-level appState
    // Called when bootstrapResult.startServices() runs in startServices()
    coreDepsFn: (): CoreModuleDeps => {
      if (!appState || !viewManager || !processRunner) {
        throw new Error("Core deps not ready - appState/viewManager/processRunner not initialized");
      }

      // Create WorkspaceLockHandler for Windows file handle detection
      // Uses "process" logger since blocking process detection is process management
      // Script path is resolved from pathProvider.scriptsDir
      // Returns undefined on non-Windows platforms (no file locking issues)
      const workspaceLockHandler = createWorkspaceLockHandler(
        processRunner,
        platformInfo,
        loggingService.createLogger("process"),
        nodePath.join(pathProvider.scriptsDir.toNative(), "blocking-processes.ps1")
      );

      const baseDeps = {
        appState,
        viewManager,
        workspaceLockHandler,
        emitDeletionProgress: (progress: import("../shared/api/types").DeletionProgress) => {
          try {
            viewManagerRef
              ?.getUIWebContents()
              ?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
          } catch {
            // Log but don't throw - deletion continues even if UI disconnected
          }
        },
        logger: loggingService.createLogger("api"),
      };
      // Add killTerminalsCallback only if PluginServer is available
      // This callback sends shutdown event to the extension, which:
      // 1. Kills all terminals and waits for them to close (or timeout)
      // 2. Removes workspace folders (releases file watchers)
      // 3. Terminates the extension host process
      if (pluginServer) {
        return {
          ...baseDeps,
          pluginServer,
          killTerminalsCallback: async (workspacePath: string) => {
            // Shutdown extension host (kills terminals, releases file watchers, terminates process)
            await pluginServer!.sendExtensionHostShutdown(workspacePath);
          },
        };
      }
      return baseDeps;
    },
    // UI module deps - factory that captures module-level appState
    uiDepsFn: (): UiModuleDeps => {
      if (!appState || !viewManager || !dialogLayer) {
        throw new Error("UI deps not ready - appState/viewManager/dialogLayer not initialized");
      }
      // Capture dialogLayer for closure
      const dialogLayerRef = dialogLayer;
      return {
        appState,
        viewManager,
        // Wrap DialogLayer to match MinimalDialog interface (converts Path to string)
        dialog: {
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
        },
      };
    },
  }) as BootstrapResult & { startServices: () => void };

  // Note: IPC handlers for lifecycle.* are now registered by LifecycleModule
  // No need to call registerLifecycleHandlers() separately

  // 8. Services are NOT started here anymore
  // The renderer will call lifecycle.startServices() after loading
  // This allows the UI to display a loading screen during service startup
  if (setupComplete) {
    appLogger.debug("Setup complete, renderer will start services");
  } else {
    appLogger.info("Setup required");
  }

  // 9. Load UI layer HTML
  // Renderer will call lifecycle.getState() in onMount and route based on response
  // Use file:// URL to load local HTML file
  const uiHtmlPath = `file://${nodePath.join(__dirname, "../renderer/index.html")}`;
  await viewLayer.loadURL(viewManager.getUIViewHandle(), uiHtmlPath);

  // Focus UI layer so keyboard shortcuts (Alt+X) work immediately on startup
  viewManager.focusUI();

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
 */
async function cleanup(): Promise<void> {
  const appLogger = loggingService.createLogger("app");
  appLogger.info("Shutdown initiated");

  // Dispose OpenCode server manager (stops all servers)
  if (serverManager) {
    await serverManager.dispose();
    serverManager = null;
  }

  // Dispose MCP server manager AFTER OpenCode (servers may still be using it)
  if (mcpServerManager) {
    await mcpServerManager.dispose();
    mcpServerManager = null;
  }

  // Dispose badge manager
  if (badgeManager) {
    badgeManager.disconnect();
    badgeManager = null;
  }

  // Dispose agent status manager
  if (agentStatusManager) {
    agentStatusManager.dispose();
    agentStatusManager = null;
  }

  // Cleanup API event wiring
  if (apiEventCleanup) {
    apiEventCleanup();
    apiEventCleanup = null;
  }

  // Cleanup agent status wiring
  if (agentStatusCleanup) {
    agentStatusCleanup();
    agentStatusCleanup = null;
  }

  // Cleanup MCP first request callback
  if (mcpFirstRequestCleanup) {
    mcpFirstRequestCleanup();
    mcpFirstRequestCleanup = null;
  }

  // Cleanup loading state change callback
  if (loadingChangeCleanup) {
    loadingChangeCleanup();
    loadingChangeCleanup = null;
  }

  // Dispose API registry and modules
  if (bootstrapResult) {
    await bootstrapResult.dispose();
    bootstrapResult = null;
  }
  codeHydraApi = null;

  // Destroy all views
  if (viewManager) {
    viewManager.destroy();
    viewManager = null;
  }

  // Stop code-server
  if (codeServerManager) {
    await codeServerManager.stop();
    codeServerManager = null;
  }

  // Close PluginServer AFTER code-server (extensions disconnect first)
  if (pluginServer) {
    await pluginServer.close();
    pluginServer = null;
  }

  windowManager = null;
  appState = null;

  // Dispose layers in reverse initialization order:
  // Initialization: IpcLayer → AppLayer → ImageLayer → MenuLayer → DialogLayer → SessionLayer → WindowLayer → ViewLayer
  // Dispose: ViewLayer → WindowLayer → SessionLayer → ...
  // Note: ViewLayer already disposed via viewManager.destroy() above
  // Note: Some layers don't have dispose() or are not stored

  if (viewLayer) {
    await viewLayer.dispose();
    viewLayer = null;
  }

  if (windowLayer) {
    await windowLayer.dispose();
    windowLayer = null;
  }

  if (sessionLayer) {
    await sessionLayer.dispose();
    sessionLayer = null;
  }

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
  // Explicit cleanup for OpenCode services - synchronous operations
  // These are done explicitly to ensure they happen even if cleanup() is async
  if (serverManager) {
    void serverManager.dispose();
    serverManager = null;
  }
  if (mcpServerManager) {
    void mcpServerManager.dispose();
    mcpServerManager = null;
  }
  if (agentStatusManager) {
    agentStatusManager.dispose();
    agentStatusManager = null;
  }

  // Run full cleanup for remaining resources (code-server, views, etc.)
  void cleanup();
});
