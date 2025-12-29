/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 */

import { app, Menu, dialog } from "electron";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import {
  CodeServerManager,
  ProjectStore,
  DefaultPathProvider,
  DefaultNetworkLayer,
  DefaultFileSystemLayer,
  ElectronLogService,
  type CodeServerConfig,
  type PathProvider,
  type BuildInfo,
  type LoggingService,
} from "../services";
import { VscodeSetupService, WrapperScriptGenerationService } from "../services/vscode-setup";
import { ExecaProcessRunner } from "../services/platform/process";
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
import { DefaultElectronAppApi } from "./managers/electron-app-api";
import { AppState } from "./app-state";
import { wireApiEvents, formatWindowTitle, registerLogHandlers } from "./ipc";
import { initializeBootstrap, type BootstrapResult } from "./bootstrap";
import type { CoreModuleDeps } from "./modules/core";
import type { UiModuleDeps } from "./modules/ui";
import { generateProjectId, extractWorkspaceName } from "./api/id-utils";
import type { ICodeHydraApi, Unsubscribe } from "../shared/api/interfaces";
import type { WorkspaceName, WorkspaceStatus } from "../shared/api/types";
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
    mkdir(config.runtimeDir, { recursive: true }),
    mkdir(config.extensionsDir, { recursive: true }),
    mkdir(config.userDataDir, { recursive: true }),
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
    await dialog.showMessageBox({
      type: "error",
      title: "Code Server Error",
      message: "Failed to start code-server",
      detail: `${message}\n\nThe application cannot continue without code-server.`,
      buttons: ["Quit"],
    });
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
  const electronAppApi = new DefaultElectronAppApi();
  badgeManager = new BadgeManager(
    platformInfo,
    electronAppApi,
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

  // Wire API events to IPC emission (with window title updates)
  apiEventCleanup = wireApiEvents(
    codeHydraApi,
    () => viewManager?.getUIView().webContents ?? null,
    {
      setTitle: (title) => windowManagerRef?.setTitle(title),
      defaultTitle,
      ...(buildInfo.gitBranch && { devBranch: buildInfo.gitBranch }),
      getProjectName: (workspacePath) => {
        const project = appStateRef?.findProjectForWorkspace(workspacePath);
        return project?.name;
      },
    }
  );

  // Wire agent status changes to API events
  // This bridges the AgentStatusManager callback to the registry event system
  agentStatusCleanup = agentStatusManager.onStatusChanged((workspacePath, aggregatedStatus) => {
    // Find the project containing this workspace
    const project = appStateRef.findProjectForWorkspace(workspacePath);
    if (!project) {
      return; // Workspace not in any known project, skip
    }

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
      configPath: mcpServerManager.getConfigPath(),
    });

    // Configure OpenCode servers to connect to MCP
    if (serverManager) {
      serverManager.setMcpConfig({
        configPath: mcpServerManager.getConfigPath(),
        port: mcpServerManager.getPort()!,
      });
    }
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

  // 1. Disable application menu
  Menu.setApplicationMenu(null);

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

  // 3. Regenerate wrapper scripts on every startup (cheap operation, ~1ms)
  // This ensures scripts are always fresh and match current binary versions
  const wrapperScriptService = new WrapperScriptGenerationService(
    pathProvider,
    fileSystemLayer,
    platformInfo,
    loggingService.createLogger("vscode-setup") // Use vscode-setup logger for wrapper scripts
  );
  try {
    await wrapperScriptService.regenerate();
  } catch (error) {
    // Log but don't fail bootstrap - scripts can be regenerated during setup
    appLogger.warn("Failed to regenerate wrapper scripts", { error: getErrorMessage(error) });
  }

  // 4. Run preflight to determine if setup is needed
  const preflightResult = await vscodeSetupService.preflight();
  const setupComplete = preflightResult.success && !preflightResult.needsSetup;

  // 5. Create WindowManager with appropriate title and icon
  // In dev mode, show branch name: "CodeHydra (branch-name)"
  const windowTitle =
    buildInfo.isDevelopment && buildInfo.gitBranch
      ? `CodeHydra (${buildInfo.gitBranch})`
      : "CodeHydra";
  windowManager = WindowManager.create(
    loggingService.createLogger("window"),
    platformInfo,
    windowTitle,
    pathProvider.appIconPath.toNative()
  );

  // 6. Create ViewManager with port=0 initially
  // Port will be updated when startServices() runs
  viewManager = ViewManager.create(
    windowManager,
    {
      uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
      codeServerPort: 0,
    },
    loggingService.createLogger("view")
  );

  // 7. Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // Capture viewManager for closure (TypeScript narrow refinement doesn't persist)
  const viewManagerRef = viewManager;

  // 8. Initialize bootstrap with API registry and modules
  // LifecycleModule is created immediately (handles lifecycle.* IPC)
  // CoreModule and UiModule are created when startServices() calls bootstrapResult.startServices()
  bootstrapResult = initializeBootstrap({
    logger: loggingService.createLogger("api"),
    // Lifecycle module deps - available now
    lifecycleDeps: {
      vscodeSetup: vscodeSetupService ?? undefined,
      app,
      onSetupComplete: async () => {
        appLogger.info("Setup complete");
        await startServices();
        appLogger.info("Services started");
      },
      logger: loggingService.createLogger("lifecycle"),
    },
    // Core module deps - factory that captures module-level appState
    // Called when bootstrapResult.startServices() runs in startServices()
    coreDepsFn: (): CoreModuleDeps => {
      if (!appState || !viewManager) {
        throw new Error("Core deps not ready - appState/viewManager not initialized");
      }
      const baseDeps = {
        appState,
        viewManager,
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
      if (!appState || !viewManager) {
        throw new Error("UI deps not ready - appState/viewManager not initialized");
      }
      return {
        appState,
        viewManager,
        // Wrap Electron dialog to match MinimalDialog interface
        dialog: {
          showOpenDialog: async (options: { properties: string[] }) => {
            return dialog.showOpenDialog(options as Parameters<typeof dialog.showOpenDialog>[0]);
          },
        },
      };
    },
  }) as BootstrapResult & { startServices: () => void };

  // Note: IPC handlers for lifecycle.* are now registered by LifecycleModule
  // No need to call registerLifecycleHandlers() separately

  // 10. If setup is complete, start services immediately
  // This is done BEFORE loading UI so handlers are ready when MainView mounts
  if (setupComplete) {
    await startServices();
    appLogger.info("Services started");
  } else {
    appLogger.info("Setup required");
  }

  // 11. Load UI layer HTML
  // Renderer will call lifecycle.getState() in onMount and route based on response
  const uiView = viewManager.getUIView();
  await uiView.webContents.loadFile(nodePath.join(__dirname, "../renderer/index.html"));

  // 12. Open DevTools in development only
  // Note: DevTools not auto-opened to avoid z-order issues on Linux.
  // Use Ctrl+Shift+I to open manually when needed (opens detached).
  if (buildInfo.isDevelopment) {
    uiView.webContents.on("before-input-event", (event, input) => {
      if (input.control && input.shift && input.key === "I") {
        if (uiView.webContents.isDevToolsOpened()) {
          uiView.webContents.closeDevTools();
        } else {
          uiView.webContents.openDevTools({ mode: "detach" });
        }
        event.preventDefault();
      }
    });
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
