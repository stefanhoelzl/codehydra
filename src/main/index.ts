/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 *
 * File layout:
 * 1. Pre-import setup (fontconfig fix)
 * 2. Imports
 * 3. Helper function definitions
 * 4. Core initializations (buildInfo, platformInfo, pathProvider, logging)
 * 5. Electron layers (all constructors are pure)
 * 6. Service construction (hoisted from bootstrap)
 * 7. Manager construction (two-phase: constructor only, no Electron resources)
 * 8. Intent modules (all at module level)
 * 9. Pre-ready calls (applyElectronFlags, redirectElectronDataPaths)
 * 10. Mutable state
 * 11. bootstrap() — focused on Electron lifecycle
 * 12. App lifecycle handlers
 */

// 1. Pre-import setup
// Fix fontconfig for AppImage builds.
// Must be set BEFORE any Electron/Chromium code runs.
// AppImage sets APPIMAGE or APPDIR environment variables.
if (process.env.APPIMAGE || process.env.APPDIR) {
  // Point fontconfig to system fonts instead of any bundled config
  process.env.FONTCONFIG_PATH = "/etc/fonts";
}

// 2. Imports
import { app } from "electron";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import {
  CodeServerManager,
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
import { createIdempotencyModule } from "./intents/infrastructure/idempotency-module";
import { createViewModule } from "./modules/view-module";
import { createCodeServerModule } from "./modules/code-server-module";
import { createAgentModule } from "./modules/agent-module";
import { createMetadataModule } from "./modules/metadata-module";
import { createKeepFilesModule } from "./modules/keepfiles-module";
import { createWindowsFileLockModule } from "./modules/windows-file-lock-module";
import { createWindowTitleModule } from "./modules/window-title-module";
import { createTelemetryModule } from "./modules/telemetry-module";
import { createAutoUpdaterModule } from "./modules/auto-updater-module";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createMigrationModule } from "./modules/migration-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createBadgeModule } from "./modules/badge-module";
import { createMcpModule } from "./modules/mcp-module";
import { INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent } from "./operations/set-mode";
import { INTENT_APP_SHUTDOWN } from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import { INTENT_DELETE_WORKSPACE, EVENT_WORKSPACE_DELETED } from "./operations/delete-workspace";
import type { DeleteWorkspaceIntent, DeleteWorkspacePayload } from "./operations/delete-workspace";
import { INTENT_APP_START } from "./operations/app-start";
import type { AppStartIntent } from "./operations/app-start";
import { INTENT_SETUP, EVENT_SETUP_ERROR } from "./operations/setup";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { ConfigAgentType } from "../shared/api/types";
import { ApiIpcChannels } from "../shared/ipc";
import { ElectronBuildInfo } from "./build-info";
import { NodePlatformInfo } from "./platform-info";
import { getErrorMessage } from "../shared/error-utils";

// 3. Helper function definitions

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
      appLogger.info("Applied Electron flag", { flag: flag.name, value: flag.value });
    } else {
      app.commandLine.appendSwitch(flag.name);
      appLogger.info("Applied Electron flag", { flag: flag.name });
    }
  }
}

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

// 4. Core initializations

const buildInfo: BuildInfo = new ElectronBuildInfo();

const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);
const loggingService: LoggingService = new ElectronLogService(buildInfo, pathProvider);
const appLogger = loggingService.createLogger("app");
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const fileSystemLayer = new DefaultFileSystemLayer(loggingService.createLogger("fs"));

// 5. Electron layers (all constructors are pure — just store deps)

const dialogLayer = new DefaultDialogLayer(loggingService.createLogger("dialog"));
const menuLayer = new DefaultMenuLayer(loggingService.createLogger("menu"));
const imageLayer = new DefaultImageLayer(loggingService.createLogger("window"));
const windowLayer = new DefaultWindowLayer(
  imageLayer,
  platformInfo,
  loggingService.createLogger("window")
);
const viewLayer = new DefaultViewLayer(windowLayer, loggingService.createLogger("view"));
const sessionLayer = new DefaultSessionLayer(loggingService.createLogger("view"));
const appLayer = new DefaultAppLayer(loggingService.createLogger("badge"));
const ipcLayer = new DefaultIpcLayer(loggingService.createLogger("api"));

// 6. Service construction (hoisted from bootstrap)

const configService = new ConfigService({
  fileSystem: fileSystemLayer,
  pathProvider,
  logger: loggingService.createLogger("config"),
});

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

// Process runner uses platform-native tree killing (taskkill on Windows, process.kill on Unix)
const processRunner = new ExecaProcessRunner(loggingService.createLogger("process"));
const networkLayer = new DefaultNetworkLayer(loggingService.createLogger("network"));

const binaryDownloadService: BinaryDownloadService = new DefaultBinaryDownloadService(
  networkLayer,
  fileSystemLayer,
  new DefaultArchiveExtractor(),
  pathProvider,
  platformInfo,
  loggingService.createLogger("binary-download")
);

const codeServerConfig: CodeServerConfig = {
  port: getCodeServerPort(buildInfo),
  binaryPath: pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toNative(),
  runtimeDir: nodePath.join(pathProvider.dataRootDir.toNative(), "runtime"),
  extensionsDir: pathProvider.vscodeExtensionsDir.toNative(),
  userDataDir: pathProvider.vscodeUserDataDir.toNative(),
  binDir: pathProvider.binDir.toNative(),
  codeServerDir: pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toNative(),
  opencodeDir: pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toNative(),
};

const codeServerManager = new CodeServerManager(
  codeServerConfig,
  processRunner,
  networkLayer,
  networkLayer,
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

const hookRegistry = new HookRegistry();
const dispatcher = new Dispatcher(hookRegistry);

// Runtime services (non-agent, used by lifecycle modules)
const pluginServer = new PluginServer(networkLayer, loggingService.createLogger("plugin"), {
  isDevelopment: buildInfo.isDevelopment,
  extensionLogger: loggingService.createLogger("extension"),
});

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

const autoUpdater = new AutoUpdater({
  logger: loggingService.createLogger("updater"),
  isDevelopment: buildInfo.isDevelopment,
});

// Agent services (both server managers + status manager)
// Both constructors are pure field assignment (no I/O)
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

const keepFilesService = new KeepFilesService(
  fileSystemLayer,
  loggingService.createLogger("keepfiles")
);

// Wrap DialogLayer for bootstrap (converts Path to string)
const dialog = {
  showOpenDialog: async (options: { properties: string[] }) => {
    const result = await dialogLayer.showOpenDialog({
      properties: options.properties as import("../services/platform/dialog").OpenDialogProperty[],
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

const apiLogger = loggingService.createLogger("api");
const lifecycleLogger = loggingService.createLogger("lifecycle");

// 7. Manager construction (two-phase: constructor only, no Electron resources)

const windowTitle =
  !buildInfo.isPackaged && buildInfo.gitBranch ? `CodeHydra (${buildInfo.gitBranch})` : "CodeHydra";

const windowManager = new WindowManager(
  {
    windowLayer,
    imageLayer,
    logger: loggingService.createLogger("window"),
    platformInfo,
  },
  windowTitle,
  pathProvider.appIconPath.toNative()
);

const viewManager = new ViewManager({
  windowManager,
  windowLayer,
  viewLayer,
  sessionLayer,
  config: {
    uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
    codeServerPort: 0,
  },
  logger: loggingService.createLogger("view"),
  setModeFn: (mode) => {
    void dispatcher.dispatch({
      type: INTENT_SET_MODE,
      payload: { mode },
    } as SetModeIntent);
  },
});

const badgeManager = new BadgeManager(
  platformInfo,
  appLayer,
  imageLayer,
  windowManager,
  loggingService.createLogger("badge")
);

// Mutable reference: set after initializeBootstrap(), read by lazy closures
let codeHydraApi: ICodeHydraApi | null = null;

// McpServerManager with lazy API factory (API is not available until after bootstrap)
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

// 8. Intent modules (all at module level)

const idempotencyModule = createIdempotencyModule([
  { intentType: INTENT_APP_SHUTDOWN },
  { intentType: INTENT_SETUP, resetOn: EVENT_SETUP_ERROR },
  {
    intentType: INTENT_DELETE_WORKSPACE,
    getKey: (p) => {
      const { workspacePath } = p as DeleteWorkspacePayload;
      return workspacePath;
    },
    resetOn: EVENT_WORKSPACE_DELETED,
    isForced: (intent) => (intent as DeleteWorkspaceIntent).payload.force,
  },
]);

const { module: viewModule, mountSignal } = createViewModule({
  viewManager,
  logger: apiLogger,
  viewLayer,
  windowLayer,
  sessionLayer,
});

const codeServerModule = createCodeServerModule({
  codeServerManager,
  extensionManager: setupExtensionManager,
  logger: apiLogger,
  getLifecycleDeps: () => ({
    pluginServer,
    codeServerManager,
    fileSystemLayer,
    onPortChanged: (port: number) => {
      viewManager.updateCodeServerPort(port);
    },
  }),
  getWorkspaceDeps: () => ({
    workspaceFileService,
    wrapperPath: pathProvider.claudeCodeWrapperPath.toString(),
  }),
});

const agentModule = createAgentModule({
  configService,
  getAgentBinaryManager,
  ipcLayer,
  getUIWebContentsFn: () => viewManager.getUIWebContents(),
  logger: apiLogger,
  loggingService,
  dispatcher,
  killTerminalsCallback: async (workspacePath: string) => {
    await pluginServer.sendExtensionHostShutdown(workspacePath);
  },
  agentServerManagers,
  agentStatusManager,
});

const metadataModule = createMetadataModule({
  globalProvider: globalWorktreeProvider,
});
const keepFilesModule = createKeepFilesModule({
  keepFilesService,
  logger: apiLogger,
});
const deleteWindowsLockModule = createWindowsFileLockModule({
  workspaceLockHandler,
  logger: apiLogger,
});
const windowTitleModule = createWindowTitleModule(
  (title: string) => windowManager.setTitle(title),
  buildInfo.gitBranch ?? buildInfo.version
);
const telemetryLifecycleModule = createTelemetryModule({
  telemetryService,
  platformInfo,
  buildInfo,
  configService,
  logger: lifecycleLogger,
});
const autoUpdaterLifecycleModule = createAutoUpdaterModule({
  autoUpdater,
  dispatcher,
  logger: lifecycleLogger,
});
const migrationModule = createMigrationModule({
  projectsDir: pathProvider.projectsDir.toString(),
  remotesDir: pathProvider.remotesDir.toString(),
  fs: fileSystemLayer,
});
const localProjectModule = createLocalProjectModule({
  projectsDir: pathProvider.projectsDir.toString(),
  fs: fileSystemLayer,
  globalProvider: globalWorktreeProvider,
});
const remoteProjectModule = createRemoteProjectModule({
  fs: fileSystemLayer,
  gitClient,
  pathProvider,
  logger: lifecycleLogger,
});
const gitWorktreeWorkspaceModule = createGitWorktreeWorkspaceModule(
  globalWorktreeProvider,
  pathProvider,
  apiLogger
);
const badgeModule = createBadgeModule(badgeManager, lifecycleLogger);
const mcpModule = createMcpModule({
  mcpServerManager,
  logger: lifecycleLogger,
});

// 9. Pre-ready calls

// Disable ASAR virtual filesystem when not packaged.
// Prevents file handle issues on Windows when deleting workspaces
// that contain node_modules/electron directories.
if (!buildInfo.isPackaged) {
  process.noAsar = true;
}

// Apply Electron command-line flags IMMEDIATELY after logging is available.
// CRITICAL: Must be before app.whenReady() and any code that might trigger GPU initialization.
applyElectronFlags();

// Redirect Electron data paths before app is ready
redirectElectronDataPaths();

// 10. Mutable state

/** Cleanup function — defined as a closure inside bootstrap() to capture local variables. */
let cleanup: (() => Promise<void>) | null = null;

// 11. bootstrap() — focused on Electron lifecycle

/**
 * Bootstraps the application.
 *
 * All services and modules are constructed at module level. This function
 * handles only Electron lifecycle operations:
 * 1. Initialize logging and disable application menu
 * 2. Regenerate wrapper scripts
 * 3. Create window and views (two-phase init: create())
 * 4. Initialize bootstrap with ApiRegistry and lifecycle handlers
 * 5. Load UI
 * 6. Dispatch app:start intent
 */
async function bootstrap(): Promise<void> {
  // Initialize logging service (enables renderer logging via IPC)
  loggingService.initialize();
  registerLogHandlers(loggingService);
  appLogger.info("Bootstrap starting", {
    version: buildInfo.version,
    isDev: buildInfo.isDevelopment,
  });

  // Disable application menu
  menuLayer.setApplicationMenu(null);

  // Regenerate wrapper scripts (cheap operation, ensures they always exist)
  await setupBinDirectory(fileSystemLayer, pathProvider);

  // Two-phase init: create Electron resources
  windowManager.create();
  viewManager.create();

  // Maximize window after ViewManager subscription is active
  // On Linux, maximize() is async - wait for it to complete before loading UI
  await windowManager.maximizeAsync();

  // Initialize bootstrap with API registry and pre-created modules
  const bootstrapResult = initializeBootstrap({
    logger: apiLogger,
    ipcLayer,
    app,
    hookRegistry,
    dispatcher,
    getApiFn: () => {
      if (!codeHydraApi) {
        throw new Error("API not initialized");
      }
      return codeHydraApi;
    },
    pluginServer,
    getUIWebContentsFn: () => viewManager.getUIWebContents(),
    emitDeletionProgress: (progress: import("../shared/api/types").DeletionProgress) => {
      try {
        viewManager.getUIWebContents()?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      } catch {
        // Log but don't throw - deletion continues even if UI disconnected
      }
    },
    agentStatusManager,
    globalWorktreeProvider,
    dialog,
    modules: [
      idempotencyModule,
      viewModule,
      codeServerModule,
      agentModule,
      badgeModule,
      metadataModule,
      keepFilesModule,
      deleteWindowsLockModule,
      remoteProjectModule,
      migrationModule,
      localProjectModule,
      gitWorktreeWorkspaceModule,
      windowTitleModule,
      telemetryLifecycleModule,
      autoUpdaterLifecycleModule,
      mcpModule,
    ],
    mountSignal,
  });

  // Get the typed API interface (all methods are now registered)
  codeHydraApi = bootstrapResult.getInterface();

  // Load UI layer HTML
  // Renderer starts in "initializing" mode and waits for IPC events
  const uiHtmlPath = `file://${nodePath.join(__dirname, "../renderer/index.html")}`;
  await viewLayer.loadURL(viewManager.getUIViewHandle(), uiHtmlPath);

  // Focus UI layer so keyboard shortcuts (Alt+X) work immediately on startup
  viewManager.focusUI();

  // Define cleanup as a closure capturing bootstrapResult
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

  // Dispatch app:start to orchestrate the startup flow
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

  // Open DevTools in development only
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

// 12. App lifecycle handlers

app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
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
