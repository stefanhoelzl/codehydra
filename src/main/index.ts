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
import { LoggingProcessRunner } from "../services/platform/logging-process-runner";
import { VscodeSetupService } from "../services/vscode-setup";
import { ExecaProcessRunner } from "../services/platform/process";
import {
  DefaultBinaryDownloadService,
  DefaultArchiveExtractor,
  type BinaryDownloadService,
} from "../services/binary-download";
import {
  DiscoveryService,
  AgentStatusManager,
  PidtreeProvider,
  HttpInstanceProbe,
} from "../services/opencode";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { AppState } from "./app-state";
import {
  registerApiHandlers,
  wireApiEvents,
  registerLifecycleHandlers,
  formatWindowTitle,
  registerLogHandlers,
} from "./ipc";
import { CodeHydraApiImpl } from "./api/codehydra-api";
import { LifecycleApi } from "./api/lifecycle-api";
import { generateProjectId } from "./api/id-utils";
import type { ICodeHydraApi, ILifecycleApi, Unsubscribe } from "../shared/api/interfaces";
import type { WorkspaceName, WorkspaceStatus } from "../shared/api/types";
import { ApiIpcChannels } from "../shared/ipc";
import { ElectronBuildInfo } from "./build-info";
import { NodePlatformInfo } from "./platform-info";

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
    } else {
      app.commandLine.appendSwitch(flag.name);
    }
  }
}

// Apply Electron command-line flags IMMEDIATELY after imports.
// CRITICAL: Must be before app.whenReady() and any code that might trigger GPU initialization.
applyElectronFlags();

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

// Module-level instances - created before app.whenReady()
// These are created early because redirectElectronDataPaths() needs pathProvider
const buildInfo: BuildInfo = new ElectronBuildInfo();
const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);

// Create logging service - must be before any services that need loggers
const loggingService: LoggingService = new ElectronLogService(buildInfo, pathProvider);
const fileSystemLayer = new DefaultFileSystemLayer(loggingService.createLogger("fs"));

/**
 * Redirect Electron's data paths to isolate from system defaults.
 * This prevents conflicts when running nested CodeHydra instances
 * (e.g., running CodeHydra inside a code-server terminal).
 *
 * CRITICAL: Must be called BEFORE app.whenReady()
 */
function redirectElectronDataPaths(): void {
  const electronDir = pathProvider.electronDataDir;
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
    binaryPath: pathProvider.codeServerBinaryPath,
    runtimeDir: nodePath.join(pathProvider.dataRootDir, "runtime"),
    extensionsDir: pathProvider.vscodeExtensionsDir,
    userDataDir: pathProvider.vscodeUserDataDir,
    binDir: pathProvider.binDir,
  };
}

// Global state
let windowManager: WindowManager | null = null;
let viewManager: ViewManager | null = null;
let appState: AppState | null = null;
let codeServerManager: CodeServerManager | null = null;
let discoveryService: DiscoveryService | null = null;
let agentStatusManager: AgentStatusManager | null = null;
let scanInterval: ReturnType<typeof setInterval> | null = null;
let codeHydraApi: ICodeHydraApi | null = null;
let apiEventCleanup: Unsubscribe | null = null;
let agentStatusCleanup: Unsubscribe | null = null;

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
 * LifecycleApi instance created in bootstrap(), reused by CodeHydraApiImpl.
 * Created early to make lifecycle handlers available before startServices() runs.
 */
let lifecycleApi: ILifecycleApi | null = null;

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
 * CRITICAL: Called by LifecycleApi's onSetupComplete callback BEFORE
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

  // Wrap process runner with logging decorator
  const loggingProcessRunner = new LoggingProcessRunner(
    processRunner!,
    loggingService.createLogger("process")
  );

  codeServerManager = new CodeServerManager(
    config,
    loggingProcessRunner,
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
  const projectStore = new ProjectStore(pathProvider.projectsDir, fileSystemLayer);
  appState = new AppState(
    projectStore,
    viewManager,
    pathProvider,
    port,
    fileSystemLayer,
    loggingService
  );

  // Initialize OpenCode services
  const processTree = new PidtreeProvider(loggingService.createLogger("pidtree"));
  const instanceProbe = new HttpInstanceProbe(networkLayer);

  discoveryService = new DiscoveryService({
    portManager: networkLayer,
    processTree,
    instanceProbe,
  });

  agentStatusManager = new AgentStatusManager(
    discoveryService,
    loggingService.createLogger("opencode")
  );

  // Inject services into AppState
  appState.setDiscoveryService(discoveryService);
  appState.setAgentStatusManager(agentStatusManager);

  // Wire up code-server PID changes to discovery service
  if (codeServerManager) {
    codeServerManager.onPidChanged((pid) => {
      if (discoveryService) {
        discoveryService.setCodeServerPid(pid);
      }
    });

    // Set initial PID if code-server is already running
    const currentPid = codeServerManager.pid();
    if (currentPid !== null) {
      discoveryService.setCodeServerPid(currentPid);
    }
  }

  // Start scan interval (1s) - DiscoveryService handles its own concurrency
  scanInterval = setInterval(() => {
    if (discoveryService) {
      void discoveryService.scan();
    }
  }, 1000);

  // Create and register API-based handlers
  // Reuse the existing lifecycleApi from bootstrap() if available
  // Capture viewManager for deletion progress emission
  const viewManagerForDeletion = viewManager;
  codeHydraApi = new CodeHydraApiImpl(
    appState,
    viewManager,
    dialog,
    app,
    vscodeSetupService ?? undefined,
    lifecycleApi ?? undefined,
    // Deletion progress callback - emits to renderer
    (progress) => {
      try {
        viewManagerForDeletion
          ?.getUIWebContents()
          ?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      } catch {
        // Log but don't throw - deletion continues even if UI disconnected
      }
    }
  );

  // Register API handlers
  registerApiHandlers(codeHydraApi, loggingService.createLogger("api"));

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
  // This bridges the AgentStatusManager callback to the v2 API event system
  const api = codeHydraApi as CodeHydraApiImpl;
  agentStatusCleanup = agentStatusManager.onStatusChanged((workspacePath, aggregatedStatus) => {
    // Find the project containing this workspace
    const project = appStateRef.findProjectForWorkspace(workspacePath);
    if (!project) {
      return; // Workspace not in any known project, skip
    }

    // Generate IDs
    const projectId = generateProjectId(project.path);
    const workspaceName = workspacePath.split("/").pop() as WorkspaceName;

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

    // Emit through the API
    api.emit("workspace:status-changed", {
      projectId,
      workspaceName,
      path: workspacePath,
      status,
    });
  });

  // Load persisted projects
  await appState.loadPersistedProjects();

  // Set first workspace active if any projects loaded
  const projects = await appState.getAllProjects();
  if (projects.length > 0) {
    const firstWorkspace = projects[0]?.workspaces[0];
    if (firstWorkspace) {
      viewManager.setActiveWorkspace(firstWorkspace.path);

      // Set initial window title (workspace:switched event not emitted for startup activation)
      const projectName = projects[0]?.name;
      const workspaceName = firstWorkspace.path.split("/").pop();
      const title = formatWindowTitle(projectName, workspaceName, buildInfo.gitBranch);
      windowManager.setTitle(title);
    }
  }
}

// NOTE: Legacy setup handlers (registerSetupReadyHandler, registerSetupRetryAndQuitHandlers,
// runSetupProcess, createSetupEmitters) have been removed. Setup is now handled entirely
// through the LifecycleApi and registerLifecycleHandlers().

/**
 * Bootstraps the application.
 *
 * This is the first phase of the two-phase startup:
 * bootstrap() → startServices()
 *
 * The initialization flow is:
 * 1. Create VscodeSetupService (needed for LifecycleApi)
 * 2. Create WindowManager and ViewManager
 * 3. Create LifecycleApi and register lifecycle handlers (available immediately)
 * 4. Load UI (renderer will call lifecycle.getState() in onMount)
 * 5. Handler returns "ready" or "setup"
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

  // 2. Create VscodeSetupService early (needed for LifecycleApi)
  // Store processRunner in module-level variable for reuse by CodeServerManager
  processRunner = new ExecaProcessRunner();

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

  // 3. Check if setup is already complete (determines code-server startup)
  const setupComplete = await vscodeSetupService.isSetupComplete();

  // 4. Create WindowManager with appropriate title and icon
  // In dev mode, show branch name: "CodeHydra (branch-name)"
  const windowTitle =
    buildInfo.isDevelopment && buildInfo.gitBranch
      ? `CodeHydra (${buildInfo.gitBranch})`
      : "CodeHydra";
  windowManager = WindowManager.create(
    loggingService.createLogger("window"),
    windowTitle,
    pathProvider.appIconPath
  );

  // 5. Create ViewManager with port=0 initially
  // Port will be updated when startServices() runs
  viewManager = ViewManager.create(
    windowManager,
    {
      uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
      codeServerPort: 0,
    },
    loggingService.createLogger("view")
  );

  // 6. Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // Capture viewManager for closure (TypeScript narrow refinement doesn't persist)
  const viewManagerRef = viewManager;

  // 7. Create LifecycleApi - this must happen BEFORE loading UI
  // The LifecycleApi handles setup flow and is reused by CodeHydraApiImpl
  lifecycleApi = new LifecycleApi(
    vscodeSetupService,
    app,
    // onSetupComplete callback - starts services when setup completes
    async () => {
      appLogger.info("Setup complete");
      await startServices();
      appLogger.info("Services started");
    },
    // emitProgress callback - sends progress events to renderer
    (progress) => {
      viewManagerRef.getUIView().webContents.send(ApiIpcChannels.SETUP_PROGRESS, progress);
    },
    loggingService.createLogger("lifecycle")
  );

  // 8. Register lifecycle handlers EARLY (before loading UI)
  // These handlers delegate to LifecycleApi
  registerLifecycleHandlers(lifecycleApi);

  // 9. If setup is complete, start services immediately
  // This is done BEFORE loading UI so handlers are ready when MainView mounts
  if (setupComplete) {
    await startServices();
    appLogger.info("Services started");
  } else {
    appLogger.info("Setup required");
  }

  // 10. Load UI layer HTML
  // Renderer will call lifecycle.getState() in onMount and route based on response
  const uiView = viewManager.getUIView();
  await uiView.webContents.loadFile(nodePath.join(__dirname, "../renderer/index.html"));

  // 11. Open DevTools in development only
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

  // Stop scan interval
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  // Dispose agent status manager
  if (agentStatusManager) {
    agentStatusManager.dispose();
    agentStatusManager = null;
  }

  // Dispose discovery service
  if (discoveryService) {
    discoveryService.dispose();
    discoveryService = null;
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

  // Dispose CodeHydra API
  if (codeHydraApi) {
    codeHydraApi.dispose();
    codeHydraApi = null;
  }

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
    const message = error instanceof Error ? error.message : String(error);
    appLogger.error("Fatal error", { error: message }, error instanceof Error ? error : undefined);
    console.error(error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void cleanup().then(() => app.quit());
  }
});

app.on("activate", () => {
  if (windowManager === null) {
    void bootstrap().catch(console.error);
  }
});

app.on("before-quit", () => {
  // Explicit cleanup for OpenCode services - synchronous operations
  // These are done explicitly to ensure they happen even if cleanup() is async
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (agentStatusManager) {
    agentStatusManager.dispose();
    agentStatusManager = null;
  }
  if (discoveryService) {
    discoveryService.dispose();
    discoveryService = null;
  }

  // Run full cleanup for remaining resources (code-server, views, etc.)
  void cleanup();
});
