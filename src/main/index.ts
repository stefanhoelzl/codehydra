/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 */

import { app, Menu, dialog, ipcMain } from "electron";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import {
  CodeServerManager,
  ProjectStore,
  DefaultPathProvider,
  DefaultNetworkLayer,
  DefaultFileSystemLayer,
  type CodeServerConfig,
  type PathProvider,
  type BuildInfo,
} from "../services";
import { VscodeSetupService } from "../services/vscode-setup";
import { ExecaProcessRunner } from "../services/platform/process";
import {
  DiscoveryService,
  AgentStatusManager,
  PidtreeProvider,
  HttpInstanceProbe,
} from "../services/opencode";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { AppState } from "./app-state";
import { registerAllHandlers, createSetupRetryHandler, createSetupQuitHandler } from "./ipc";
import { IpcChannels, type SetupProgress, type SetupErrorPayload } from "../shared/ipc";
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
const fileSystemLayer = new DefaultFileSystemLayer();

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
    runtimeDir: nodePath.join(pathProvider.dataRootDir, "runtime"),
    extensionsDir: pathProvider.vscodeExtensionsDir,
    userDataDir: pathProvider.vscodeUserDataDir,
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
 * Guard flag to prevent multiple concurrent setup processes.
 * Used by runSetupProcess() to ensure only one setup runs at a time.
 */
let setupInProgress = false;

/**
 * Flag to track if services have been started.
 * Prevents double-initialization when both bootstrap and setup flow might call startServices.
 */
let servicesStarted = false;

/**
 * Emits setup progress event to renderer.
 */
function emitSetupProgress(progress: SetupProgress): void {
  if (viewManager) {
    viewManager.getUIView().webContents.send(IpcChannels.SETUP_PROGRESS, progress);
  }
}

/**
 * Emits setup complete event to renderer.
 */
function emitSetupComplete(): void {
  if (viewManager) {
    viewManager.getUIView().webContents.send(IpcChannels.SETUP_COMPLETE);
  }
}

/**
 * Emits setup error event to renderer.
 */
function emitSetupError(error: SetupErrorPayload): void {
  if (viewManager) {
    viewManager.getUIView().webContents.send(IpcChannels.SETUP_ERROR, error);
  }
}

/**
 * Starts all application services after setup completes.
 * This is the second phase of the two-phase startup:
 * bootstrap() → startServices()
 *
 * CRITICAL: Must be called BEFORE emitting setup:complete to renderer.
 * This ensures IPC handlers are registered before MainView mounts.
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
  const networkLayer = new DefaultNetworkLayer();

  codeServerManager = new CodeServerManager(config, processRunner, networkLayer, networkLayer);

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
  appState = new AppState(projectStore, viewManager, pathProvider, port);

  // Initialize OpenCode services
  const processTree = new PidtreeProvider();
  const instanceProbe = new HttpInstanceProbe(networkLayer);

  discoveryService = new DiscoveryService({
    portManager: networkLayer,
    processTree,
    instanceProbe,
  });

  agentStatusManager = new AgentStatusManager(discoveryService);

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

  // Register IPC handlers
  registerAllHandlers(appState, viewManager);

  // Load persisted projects
  await appState.loadPersistedProjects();

  // Set first workspace active if any projects loaded
  const projects = await appState.getAllProjects();
  if (projects.length > 0) {
    const firstWorkspace = projects[0]?.workspaces[0];
    if (firstWorkspace) {
      viewManager.setActiveWorkspace(firstWorkspace.path);
    }
  }
}

/**
 * Creates setup event emitters for the setup process.
 *
 * CRITICAL: emitComplete is async and waits for startServices() to complete
 * before emitting setup:complete to the renderer. This ensures that all
 * IPC handlers are registered before MainView mounts and calls them.
 */
function createSetupEmitters(): {
  emitProgress: (progress: SetupProgress) => void;
  emitComplete: () => Promise<void>;
  emitError: (error: SetupErrorPayload) => void;
} {
  return {
    emitProgress: emitSetupProgress,
    emitComplete: async () => {
      // CRITICAL: Start services FIRST, so IPC handlers are registered
      await startServices();
      // THEN emit setup:complete to renderer - MainView can now safely call IPC
      emitSetupComplete();
    },
    emitError: emitSetupError,
  };
}

/**
 * Runs the setup process: clean, setup, emit events.
 * Called after setup:ready returns { ready: false }.
 *
 * Uses setupInProgress guard to prevent multiple concurrent setup processes
 * if setupReady() is called rapidly multiple times.
 */
async function runSetupProcess(): Promise<void> {
  if (!vscodeSetupService) return;

  // Guard: prevent multiple concurrent setup processes
  if (setupInProgress) {
    return; // Already running, ignore duplicate calls
  }
  setupInProgress = true;

  const emitters = createSetupEmitters();

  try {
    // Clean any partial setup state first
    await vscodeSetupService.cleanVscodeDir();

    // Run setup with progress callbacks
    const result = await vscodeSetupService.setup((progress) => {
      emitters.emitProgress(progress);
    });

    if (result.success) {
      await emitters.emitComplete();
    } else {
      emitters.emitError({
        message: result.error.message,
        code: result.error.code ?? result.error.type,
      });
    }
  } catch (error) {
    emitters.emitError({
      message: error instanceof Error ? error.message : String(error),
      code: "unknown",
    });
  } finally {
    setupInProgress = false;
  }
}

/**
 * Registers the setup:ready handler that checks status and triggers setup if needed.
 * This handler is registered EARLY, before any mode branching.
 *
 * IMPORTANT: If setup is complete, this handler ensures startServices() has run
 * before returning. This handles edge cases where the setup marker appeared
 * between bootstrap()'s check and this handler's check.
 */
function registerSetupReadyHandler(): void {
  if (!vscodeSetupService) return;

  const setupService = vscodeSetupService;

  // Handler that checks status and triggers setup if needed
  ipcMain.handle(IpcChannels.SETUP_READY, async () => {
    const isComplete = await setupService.isSetupComplete();

    if (!isComplete) {
      // Trigger setup asynchronously after returning response
      // This allows renderer to display SetupScreen before setup events arrive
      setImmediate(() => {
        void runSetupProcess();
      });
      return { ready: false };
    }

    // Setup is complete - ensure services are started before returning.
    // This handles edge cases where setupComplete was false in bootstrap()
    // but the marker appeared before this handler was called.
    await startServices();
    return { ready: true };
  });
}

/**
 * Registers setup retry and quit handlers.
 * These handlers are registered along with setup:ready.
 */
function registerSetupRetryAndQuitHandlers(): void {
  if (!vscodeSetupService) return;

  const emitters = createSetupEmitters();

  ipcMain.handle(IpcChannels.SETUP_RETRY, createSetupRetryHandler(vscodeSetupService, emitters));
  ipcMain.handle(
    IpcChannels.SETUP_QUIT,
    createSetupQuitHandler(() => app.quit())
  );
}

/**
 * Bootstraps the application.
 *
 * This is the first phase of the two-phase startup:
 * bootstrap() → startServices()
 *
 * The initialization flow is:
 * 1. Create VscodeSetupService (needed for setup:ready handler)
 * 2. Create WindowManager and ViewManager
 * 3. Register setup:ready handler (ALWAYS - this is the entry point for renderer)
 * 4. Register setup:retry and setup:quit handlers
 * 5. Load UI (renderer will call setupReady() in onMount)
 * 6. Handler returns { ready: true/false }
 *    - If ready: renderer shows MainView, main registers normal handlers
 *    - If not ready: renderer shows SetupScreen, main runs setup asynchronously
 */
async function bootstrap(): Promise<void> {
  // 1. Disable application menu
  Menu.setApplicationMenu(null);

  // 2. Create VscodeSetupService early (needed for setup:ready handler)
  // Store processRunner in module-level variable for reuse by CodeServerManager
  processRunner = new ExecaProcessRunner();
  vscodeSetupService = new VscodeSetupService(
    processRunner,
    pathProvider,
    "code-server",
    fileSystemLayer
  );

  // 3. Check if setup is already complete (determines code-server startup)
  const setupComplete = await vscodeSetupService.isSetupComplete();

  // 4. Create WindowManager with appropriate title
  // In dev mode, show branch name: "CodeHydra (branch-name)"
  const windowTitle =
    buildInfo.isDevelopment && buildInfo.gitBranch
      ? `CodeHydra (${buildInfo.gitBranch})`
      : "CodeHydra";
  windowManager = WindowManager.create(windowTitle);

  // 5. Create ViewManager with port=0 initially
  // Port will be updated when startServices() runs
  viewManager = ViewManager.create(windowManager, {
    uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
    codeServerPort: 0,
  });

  // 6. Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // 7. Register setup:ready handler EARLY (before loading UI)
  // This handler is ALWAYS registered and returns { ready: boolean }
  registerSetupReadyHandler();

  // 8. Register setup:retry and setup:quit handlers
  registerSetupRetryAndQuitHandlers();

  // 9. If setup is complete, start services immediately
  // This is done BEFORE loading UI so handlers are ready when MainView mounts
  if (setupComplete) {
    await startServices();
  }

  // 10. Load UI layer HTML
  // Renderer will call setupReady() in onMount and route based on response
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
}

// App lifecycle handlers
app.whenReady().then(bootstrap).catch(console.error);

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
