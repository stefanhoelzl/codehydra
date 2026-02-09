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
import { VscodeSetupService } from "../services/vscode-setup";
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
  type BinaryDownloadService,
  CODE_SERVER_VERSION,
  OPENCODE_VERSION,
} from "../services/binary-download";
import { AgentStatusManager, type AgentType, type AgentServerManager } from "../agents";
import { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import { PluginServer } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { wirePluginApi } from "./api/wire-plugin-api";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { AppState } from "./app-state";
import { wireApiEvents, formatWindowTitle, registerLogHandlers } from "./ipc";
import { initializeBootstrap, type BootstrapResult } from "./bootstrap";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent } from "./operations/set-mode";
import type { CoreModuleDeps } from "./modules/core";
import { generateProjectId } from "./api/id-utils";
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
let appState: AppState | null = null;
let codeServerManager: CodeServerManager | null = null;
let agentStatusManager: AgentStatusManager | null = null;
let badgeManager: BadgeManager | null = null;
let serverManager: AgentServerManager | null = null;
let mcpServerManager: McpServerManager | null = null;
let codeHydraApi: ICodeHydraApi | null = null;
let apiEventCleanup: Unsubscribe | null = null;
let agentStatusCleanup: Unsubscribe | null = null;
let mcpFirstRequestCleanup: Unsubscribe | null = null;
let wrapperReadyCleanup: Unsubscribe | null = null;
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
 * ConfigService for loading/saving agent selection.
 * Created in bootstrap(), used in startServices() to determine which agent to use.
 */
let configService: import("../services/config/config-service").ConfigService | null = null;

/**
 * TelemetryService for PostHog analytics.
 * Created in bootstrap() after configService.
 */
let telemetryService: TelemetryService | null = null;

/**
 * AutoUpdater for checking and applying updates.
 * Created in startServices() after configService is available.
 */
let autoUpdater: AutoUpdater | null = null;

/**
 * GitClient for clone operations.
 * Created in startServices() for use in CoreModule.
 */
let gitClient: import("../services").IGitClient | null = null;

/**
 * ProjectStore for project configuration storage.
 * Created in startServices() for use in AppState and CoreModule.
 */
let projectStore: import("../services").ProjectStore | null = null;

/**
 * Global worktree provider. Created in startServices(), shared across all projects.
 * Used by intent dispatcher for metadata operations.
 */
let globalWorktreeProvider: GitWorktreeProvider | null = null;

/**
 * WorkspaceFileService for .code-workspace file management.
 * Created in startServices(), used by intent dispatcher for delete operations.
 */
let workspaceFileService: import("../services").IWorkspaceFileService | null = null;

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

  // Load agent type from config (saved by user via agent selection dialog)
  // Guard: configService must be initialized by bootstrap()
  if (!configService) {
    throw new Error("ConfigService not initialized - startServices called before bootstrap");
  }
  const appConfig = await configService.load();
  const selectedAgentType: AgentType = appConfig.agent ?? "opencode"; // Default to opencode if not set

  // Capture app launch event with agent type
  // Note: telemetryService may be null if initialization failed in bootstrap
  telemetryService?.capture("app_launched", {
    platform: platformInfo.platform,
    arch: platformInfo.arch,
    isDevelopment: buildInfo.isDevelopment,
    agent: selectedAgentType,
  });

  // Initialize auto-updater (checks once per session after startup, applies on quit)
  autoUpdater = new AutoUpdater({
    logger: loggingService.createLogger("updater"),
    isDevelopment: buildInfo.isDevelopment,
  });
  autoUpdater.start();

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

    // Wire up config data provider - called when workspace extension connects
    // Provides environment variables and agent type for terminal launching
    pluginServer.onConfigData((workspacePath) => {
      // Get agent environment variables for terminal integration
      const env =
        appState
          ?.getAgentStatusManager()
          ?.getEnvironmentVariables(workspacePath as import("../shared/ipc").WorkspacePath) ?? null;

      // Get the agent type for terminal launching
      // Note: appState may be null during early startup
      const agentType = appState?.getAgentType() ?? null;

      return { env, agentType };
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

  // Start code-server - errors propagate to lifecycle module which returns
  // failure to the renderer, which shows the error screen with retry/quit options
  await codeServerManager.ensureRunning();

  // Port is guaranteed to be set after successful ensureRunning()
  const port = codeServerManager.port()!;

  // Update ViewManager with code-server port
  viewManager.updateCodeServerPort(port);

  // Create ProjectStore and AppState
  projectStore = new ProjectStore(
    pathProvider.projectsDir.toString(),
    fileSystemLayer,
    pathProvider.remotesDir.toString()
  );

  // Create GitClient for clone operations
  gitClient = new SimpleGitClient(loggingService.createLogger("git"));

  // Create global GitWorktreeProvider (shared across all projects)
  globalWorktreeProvider = new GitWorktreeProvider(
    gitClient,
    fileSystemLayer,
    loggingService.createLogger("worktree")
  );

  // Create WorkspaceFileService for .code-workspace file management
  const workspaceFileConfig = createWorkspaceFileConfig();
  workspaceFileService = new WorkspaceFileService(
    fileSystemLayer,
    workspaceFileConfig,
    loggingService.createLogger("workspace-file")
  );

  appState = new AppState(
    projectStore,
    viewManager,
    pathProvider,
    port,
    fileSystemLayer,
    loggingService,
    selectedAgentType,
    workspaceFileService,
    pathProvider.claudeCodeWrapperPath.toString(),
    globalWorktreeProvider
  );

  // Initialize agent-specific services based on selected agent type
  // Create AgentStatusManager with appropriate logger
  const agentLoggerName = selectedAgentType === "claude" ? "claude" : "opencode";
  agentStatusManager = new AgentStatusManager(loggingService.createLogger(agentLoggerName));

  // Create agent-specific server manager
  if (selectedAgentType === "claude") {
    serverManager = new ClaudeCodeServerManager({
      portManager: networkLayer,
      pathProvider,
      fileSystem: fileSystemLayer,
      logger: loggingService.createLogger("claude"),
    });
  } else {
    // OpenCode: create OpenCodeServerManager to spawn and manage opencode serve processes
    const { OpenCodeServerManager } = await import("../agents/opencode/server-manager");
    serverManager = new OpenCodeServerManager(
      processRunner,
      networkLayer,
      networkLayer,
      pathProvider,
      loggingService.createLogger("opencode")
    );
  }

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
  if (serverManager) {
    appState.setServerManager(serverManager);
  }

  // Guard: bootstrapResult must be initialized by bootstrap()
  if (!bootstrapResult) {
    throw new Error("Bootstrap not initialized - startServices called before bootstrap");
  }

  // Create remaining modules (CoreModule) and wire intent dispatcher
  // The deps factory functions reference module-level appState/viewManager which are now set
  bootstrapResult.startServices();

  // Get the typed API interface (all methods are now registered)
  codeHydraApi = bootstrapResult.getInterface();

  // Wire PluginServer to CodeHydraApi (if PluginServer is running)
  if (pluginServer) {
    wirePluginApi(pluginServer, codeHydraApi, appState, loggingService.createLogger("plugin"));
  }

  // Title suffix: branch in dev mode, version in packaged mode
  const titleSuffix = buildInfo.gitBranch ?? buildInfo.version;

  // Capture references for closures (TypeScript narrow refinement doesn't persist)
  const windowManagerRef = windowManager;
  const appStateRef = appState;
  const viewManagerRef = viewManager;

  // Wire API events to IPC emission
  // Note: workspace:switched events are handled by IpcEventBridge + SwitchTitleModule in bootstrap.ts
  apiEventCleanup = wireApiEvents(codeHydraApi, () => viewManager?.getUIWebContents() ?? null);

  // Wire auto-updater to update window title when update is available
  if (autoUpdater) {
    autoUpdater.onUpdateAvailable(() => {
      windowManagerRef?.setUpdateAvailable();
      // Update the current title immediately to show update availability
      // Get current active workspace to rebuild the title
      const activeWorkspace = viewManagerRef?.getActiveWorkspacePath();
      if (activeWorkspace) {
        const project = appStateRef?.findProjectForWorkspace(activeWorkspace);
        const workspaceName = nodePath.basename(activeWorkspace);
        const title = formatWindowTitle(project?.name, workspaceName, titleSuffix, true);
        windowManagerRef?.setTitle(title);
      } else {
        const title = formatWindowTitle(undefined, undefined, titleSuffix, true);
        windowManagerRef?.setTitle(title);
      }
    });
  }

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
    // Also signals AgentStatusManager that agent is active (for status indicator)
    const agentStatusManagerRef = agentStatusManager;
    mcpFirstRequestCleanup = mcpServerManager.onFirstRequest((workspacePath) => {
      // setWorkspaceLoaded is idempotent (guards internally), no need to check isWorkspaceLoading
      viewManagerRef.setWorkspaceLoaded(workspacePath);
      // Mark agent as active for status indicator (shows green when TUI attaches)
      agentStatusManagerRef.markActive(workspacePath as import("../shared/ipc").WorkspacePath);
    });

    // Register callback for wrapper start (Claude Code only)
    // This signals when the wrapper has started (before Claude shows dialogs)
    // Allows loading screen to clear immediately rather than waiting for MCP or timeout
    if (selectedAgentType === "claude" && serverManager) {
      // Type narrowing: cast to ClaudeCodeServerManager which has onWorkspaceReady
      const claudeServerManager = serverManager as ClaudeCodeServerManager;
      wrapperReadyCleanup = claudeServerManager.onWorkspaceReady((workspacePath) => {
        // setWorkspaceLoaded is idempotent, safe if both WrapperStart and MCP first request fire
        viewManagerRef.setWorkspaceLoaded(workspacePath);
      });
    }

    // Configure server manager to connect to MCP
    // Each manager has its own setMcpConfig signature, so we cast to the specific type
    if (serverManager && selectedAgentType === "claude") {
      // Claude Code: only needs port (config files are generated per-workspace)
      const claudeManager = serverManager as ClaudeCodeServerManager;
      claudeManager.setMcpConfig({
        port: mcpServerManager.getPort()!,
      });
    } else if (serverManager) {
      // OpenCode: needs configPath (shared config) and port
      // Cast to the OpenCodeServerManager type which has the full setMcpConfig signature
      const opencodeManager = serverManager as OpenCodeServerManager;
      opencodeManager.setMcpConfig({
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

  // Note: onWorkspaceChange callback removed -- workspace:switched events now flow through
  // the intent dispatcher (SwitchWorkspaceOperation → IpcEventBridge + SwitchTitleModule)

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
      const title = formatWindowTitle(projectName, workspaceName, titleSuffix);
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

  // 3. Create VscodeSetupService early (needed for LifecycleModule)
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

  // Factory to create VscodeSetupService for the current agent type
  // This is called each time setup needs to run, ensuring it uses the latest agent selection
  // Capture references to avoid null checks (they're set by the time the factory is called)
  const configServiceRef = configService;
  const processRunnerRef = processRunner;
  const createVscodeSetupService = async (): Promise<VscodeSetupService> => {
    // Re-read config to get current agent selection
    const currentConfig = await configServiceRef.load();
    const currentAgentType: AgentType = currentConfig.agent ?? "opencode";

    return new VscodeSetupService(
      processRunnerRef,
      pathProvider,
      fileSystemLayer,
      platformInfo,
      binaryDownloadService,
      loggingService.createLogger("vscode-setup"),
      undefined, // Agent extension ID no longer used
      currentAgentType // Pass agent binary type for download operations
    );
  };

  // Create initial VscodeSetupService for bootstrap operations (preflight, bin directory)
  vscodeSetupService = await createVscodeSetupService();

  // 3. Regenerate wrapper scripts (cheap operation, ensures they always exist)
  await vscodeSetupService.setupBinDirectory();

  // 4. Run preflight to determine if setup is needed
  const preflightResult = await vscodeSetupService.preflight();
  const setupComplete = preflightResult.success && !preflightResult.needsSetup;

  // 5. Create WindowManager with appropriate title and icon
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

  // 6. Create dispatcher early so ShortcutController can dispatch intents
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

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

  // 7. Initialize bootstrap with API registry and modules
  // LifecycleModule is created immediately (handles lifecycle.* IPC)
  // CoreModule and intent dispatcher are created when startServices() calls bootstrapResult.startServices()
  const ipcLayer = new DefaultIpcLayer(loggingService.createLogger("api"));
  bootstrapResult = initializeBootstrap({
    logger: loggingService.createLogger("api"),
    ipcLayer,
    // Lifecycle module deps - available now
    lifecycleDeps: {
      // Factory to create VscodeSetupService with current agent type from config
      getVscodeSetup: createVscodeSetupService,
      configService,
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
      if (!appState || !viewManager || !processRunner || !gitClient || !projectStore) {
        throw new Error(
          "Core deps not ready - appState/viewManager/processRunner/gitClient/projectStore not initialized"
        );
      }

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
        appState,
        viewManager,
        gitClient,
        pathProvider,
        projectStore,
        ...(dialog ? { dialog } : {}),
        ...(pluginServer ? { pluginServer } : {}),
        logger: loggingService.createLogger("api"),
      };
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
    // Callback to check if an update is available
    hasUpdateAvailableFn: () => () => windowManager?.hasUpdateAvailable() ?? false,
  }) as BootstrapResult & { startServices: () => void };

  // Note: IPC handlers for lifecycle.* are now registered by LifecycleModule
  // No need to call registerLifecycleHandlers() separately

  // Wire lifecycle:setup-progress events to IPC immediately (before UI loads)
  // This is needed because setup runs before startServices() which wires other events
  bootstrapResult.registry.on("lifecycle:setup-progress", (payload) => {
    const webContents = viewManager?.getUIWebContents();
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_PROGRESS, payload);
    }
  });

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

  // Flush telemetry events before shutdown
  if (telemetryService) {
    await telemetryService.shutdown();
    telemetryService = null;
  }

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

  // Dispose auto-updater
  if (autoUpdater) {
    autoUpdater.dispose();
    autoUpdater = null;
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

  // Cleanup wrapper ready callback
  if (wrapperReadyCleanup) {
    wrapperReadyCleanup();
    wrapperReadyCleanup = null;
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
