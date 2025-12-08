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
  getDataRootDir,
  getDataProjectsDir,
  type CodeServerConfig,
} from "../services";
import {
  DiscoveryService,
  AgentStatusManager,
  SiPortScanner,
  PidtreeProvider,
  HttpInstanceProbe,
} from "../services/opencode";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { AppState } from "./app-state";
import { registerAllHandlers } from "./ipc/handlers";

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

/**
 * Creates the code-server configuration.
 */
function createCodeServerConfig(): CodeServerConfig {
  const dataRoot = getDataRootDir();
  return {
    runtimeDir: nodePath.join(dataRoot, "runtime"),
    extensionsDir: nodePath.join(dataRoot, "extensions"),
    userDataDir: nodePath.join(dataRoot, "user-data"),
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
 * Initializes the application.
 */
async function initialize(): Promise<void> {
  // 1. Disable application menu
  Menu.setApplicationMenu(null);

  // 2. Start code-server
  const config = createCodeServerConfig();

  // Ensure required directories exist
  await Promise.all([
    mkdir(config.runtimeDir, { recursive: true }),
    mkdir(config.extensionsDir, { recursive: true }),
    mkdir(config.userDataDir, { recursive: true }),
  ]);

  codeServerManager = new CodeServerManager(config);

  try {
    await codeServerManager.ensureRunning();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    dialog.showErrorBox(
      "Code Server Error",
      `Failed to start code-server: ${message}\n\nThe application will run in degraded mode.`
    );
    // Don't exit - allow app to run in degraded mode
  }

  const port = codeServerManager.port() ?? 0;

  // 3. Create WindowManager
  windowManager = WindowManager.create();

  // 4. Create ViewManager
  viewManager = ViewManager.create(windowManager, {
    uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
    codeServerPort: port,
  });

  // 5. Create ProjectStore and AppState
  const projectStore = new ProjectStore(getDataProjectsDir());
  appState = new AppState(projectStore, viewManager, port);

  // 6. Initialize OpenCode services
  const portScanner = new SiPortScanner();
  const processTree = new PidtreeProvider();
  const instanceProbe = new HttpInstanceProbe();

  discoveryService = new DiscoveryService({
    portScanner,
    processTree,
    instanceProbe,
  });

  agentStatusManager = new AgentStatusManager(discoveryService);

  // Inject services into AppState
  appState.setDiscoveryService(discoveryService);
  appState.setAgentStatusManager(agentStatusManager);

  // Wire up code-server PID changes to discovery service
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

  // Start scan interval (1s) - DiscoveryService handles its own concurrency
  scanInterval = setInterval(() => {
    if (discoveryService) {
      void discoveryService.scan();
    }
  }, 1000);

  // 7. Register IPC handlers
  registerAllHandlers(appState, viewManager);

  // 8. Load UI layer HTML
  const uiView = viewManager.getUIView();
  await uiView.webContents.loadFile(nodePath.join(__dirname, "../renderer/index.html"));

  // 9. Open DevTools in development only (detached to avoid interfering with UI layer)
  if (!app.isPackaged) {
    uiView.webContents.openDevTools({ mode: "detach" });
  }

  // 10. Load persisted projects
  await appState.loadPersistedProjects();

  // 11. Set first workspace active if any projects loaded
  const projects = appState.getAllProjects();
  if (projects.length > 0) {
    const firstWorkspace = projects[0]?.workspaces[0];
    if (firstWorkspace) {
      viewManager.setActiveWorkspace(firstWorkspace.path);
    }
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
app.whenReady().then(initialize).catch(console.error);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void cleanup().then(() => app.quit());
  }
});

app.on("activate", () => {
  if (windowManager === null) {
    void initialize().catch(console.error);
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
