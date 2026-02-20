/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 *
 * File layout:
 * 1. Pre-import setup (fontconfig fix)
 * 2. Imports
 * 3. Core initializations (buildInfo, platformInfo, pathProvider, logging)
 * 4. Electron layers (all constructors are pure)
 * 5. Service construction
 * 6. Manager construction (two-phase: constructor only, no Electron resources)
 * 7. Intent modules (existing extracted modules)
 * 8. New modules (electron-lifecycle, logging, script, retry, lifecycle-ready)
 * 9. ApiRegistry + Operation registration + IPC event bridge
 * 10. Wire all modules + get API interface
 * 11. Cleanup + dispatch app:start
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
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import { PluginServer } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { registerLogHandlers } from "./ipc";
import { ApiRegistry } from "./api/registry";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { createIdempotencyModule } from "./intents/infrastructure/idempotency-module";
import { createViewModule } from "./modules/view-module";
import { createCodeServerModule } from "./modules/code-server-module";
import { createClaudeAgentModule } from "./modules/claude-agent-module";
import { createOpenCodeAgentModule } from "./modules/opencode-agent-module";
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
import { createElectronLifecycleModule } from "./modules/electron-lifecycle-module";
import { createLoggingModule } from "./modules/logging-module";
import { createScriptModule } from "./modules/script-module";
import { createRetryModule } from "./modules/retry-module";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { createWorkspaceSelectionModule } from "./modules/workspace-selection-module";
import { AppStartOperation, INTENT_APP_START } from "./operations/app-start";
import type { AppStartIntent } from "./operations/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import { SetupOperation, INTENT_SETUP, EVENT_SETUP_ERROR } from "./operations/setup";
import { SetModeOperation, INTENT_SET_MODE } from "./operations/set-mode";
import { SetMetadataOperation, INTENT_SET_METADATA } from "./operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import { GetAgentSessionOperation, INTENT_GET_AGENT_SESSION } from "./operations/get-agent-session";
import { RestartAgentOperation, INTENT_RESTART_AGENT } from "./operations/restart-agent";
import {
  GetActiveWorkspaceOperation,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./operations/get-active-workspace";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./operations/open-workspace";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
} from "./operations/delete-workspace";
import type { DeleteWorkspaceIntent, DeleteWorkspacePayload } from "./operations/delete-workspace";
import { OpenProjectOperation, INTENT_OPEN_PROJECT } from "./operations/open-project";
import { CloseProjectOperation, INTENT_CLOSE_PROJECT } from "./operations/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./operations/switch-workspace";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./operations/update-available";
import {
  ResolveWorkspaceOperation,
  INTENT_RESOLVE_WORKSPACE,
} from "./operations/resolve-workspace";
import { ResolveProjectOperation, INTENT_RESOLVE_PROJECT } from "./operations/resolve-project";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import { ApiIpcChannels } from "../shared/ipc";
import { ElectronBuildInfo } from "./build-info";
import { NodePlatformInfo } from "./platform-info";
import { getErrorMessage } from "../shared/error-utils";

// 3. Core initializations (buildInfo, platformInfo, pathProvider, logging)

const buildInfo: BuildInfo = new ElectronBuildInfo();

const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);
const loggingService: LoggingService = new ElectronLogService(buildInfo, pathProvider);
const appLogger = loggingService.createLogger("app");
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const fileSystemLayer = new DefaultFileSystemLayer(loggingService.createLogger("fs"));

// 4. Electron layers (all constructors are pure — just store deps)

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

// 5. Service construction

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

// Per-agent binary managers (one per agent type, created upfront)
const claudeBinaryManager = new AgentBinaryManager(
  "claude",
  binaryDownloadService,
  loggingService.createLogger("agent-binary")
);
const opencodeBinaryManager = new AgentBinaryManager(
  "opencode",
  binaryDownloadService,
  loggingService.createLogger("agent-binary")
);

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

const workspaceLockHandler = createWorkspaceLockHandler(
  processRunner,
  platformInfo,
  loggingService.createLogger("process"),
  nodePath.join(pathProvider.scriptsRuntimeDir.toNative(), "blocking-processes.ps1")
);

const apiLogger = loggingService.createLogger("api");
const lifecycleLogger = loggingService.createLogger("lifecycle");

// 6. Manager construction (two-phase: constructor only, no Electron resources)

const windowManager = new WindowManager(
  {
    windowLayer,
    imageLayer,
    logger: loggingService.createLogger("window"),
    platformInfo,
  },
  "CodeHydra",
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
  dispatcher,
});

const badgeManager = new BadgeManager(
  platformInfo,
  appLayer,
  imageLayer,
  windowManager,
  loggingService.createLogger("badge")
);

// Mutable reference: set after module wiring + registry.getInterface(), read by lazy closures
let codeHydraApi: ICodeHydraApi | null = null;

// McpServerManager with lazy API factory (API is not available until after module wiring)
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

// 7. Intent modules (all at module level)

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

const uiHtmlPath = `file://${nodePath.join(__dirname, "../renderer/index.html")}`;

const { module: viewModule, readyHandler } = createViewModule({
  viewManager,
  logger: apiLogger,
  viewLayer,
  windowLayer,
  sessionLayer,
  dialogLayer,
  ipcLayer,
  menuLayer,
  windowManager,
  buildInfo,
  uiHtmlPath,
  devToolsHandler: buildInfo.isDevelopment
    ? () => {
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
    : null,
});

const codeServerModule = createCodeServerModule({
  codeServerManager,
  extensionManager: setupExtensionManager,
  pluginServer,
  fileSystemLayer,
  workspaceFileService,
  wrapperPath: pathProvider.claudeCodeWrapperPath.toString(),
  logger: apiLogger,
});

const claudeAgentModule = createClaudeAgentModule({
  configService,
  agentBinaryManager: claudeBinaryManager,
  serverManager: agentServerManagers.claude as ClaudeCodeServerManager,
  agentStatusManager,
  dispatcher,
  logger: apiLogger,
  loggingService,
});

const opencodeAgentModule = createOpenCodeAgentModule({
  configService,
  agentBinaryManager: opencodeBinaryManager,
  serverManager: agentServerManagers.opencode as OpenCodeServerManager,
  agentStatusManager,
  dispatcher,
  logger: apiLogger,
  loggingService,
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
const workspaceSelectionModule = createWorkspaceSelectionModule(agentStatusManager);
const mcpModule = createMcpModule({
  mcpServerManager,
  logger: lifecycleLogger,
});

// 8. New modules

const electronLifecycleModule = createElectronLifecycleModule({
  app,
  buildInfo,
  pathProvider,
  logger: lifecycleLogger,
});

const loggingModule = createLoggingModule({
  loggingService,
  registerLogHandlers: () => registerLogHandlers(loggingService),
});

const scriptModule = createScriptModule({
  fileSystem: fileSystemLayer,
  pathProvider,
});

const retryModule = createRetryModule({ ipcLayer });

// 9. ApiRegistry + Operation registration

const registry = new ApiRegistry({
  logger: apiLogger,
  ipcLayer,
});

dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());
dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());
dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());

const deleteOp = new DeleteWorkspaceOperation();
dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOp);

dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());

dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());

// Create IPC event bridge (registers all API bridge handlers on the registry)
const ipcEventBridge = createIpcEventBridge({
  apiRegistry: registry,
  getApi: () => {
    if (!codeHydraApi) {
      throw new Error("API not initialized");
    }
    return codeHydraApi;
  },
  getUIWebContents: () => viewManager.getUIWebContents(),
  pluginServer,
  logger: apiLogger,
  dispatcher,
  agentStatusManager,
  globalWorktreeProvider,
  deleteOp,
});

// 10. Register all modules + get API interface

dispatcher.registerModule(idempotencyModule);
dispatcher.registerModule(viewModule);
dispatcher.registerModule(codeServerModule);
dispatcher.registerModule(claudeAgentModule);
dispatcher.registerModule(opencodeAgentModule);
dispatcher.registerModule(badgeModule);
dispatcher.registerModule(workspaceSelectionModule);
dispatcher.registerModule(metadataModule);
dispatcher.registerModule(keepFilesModule);
dispatcher.registerModule(deleteWindowsLockModule);
dispatcher.registerModule(remoteProjectModule);
dispatcher.registerModule(migrationModule);
dispatcher.registerModule(localProjectModule);
dispatcher.registerModule(gitWorktreeWorkspaceModule);
dispatcher.registerModule(windowTitleModule);
dispatcher.registerModule(telemetryLifecycleModule);
dispatcher.registerModule(autoUpdaterLifecycleModule);
dispatcher.registerModule(mcpModule);
dispatcher.registerModule(electronLifecycleModule);
dispatcher.registerModule(loggingModule);
dispatcher.registerModule(scriptModule);
dispatcher.registerModule(retryModule);
dispatcher.registerModule(ipcEventBridge);

// Register lifecycle.ready handler (bridges mount signal + projects-loaded deferred)
registry.register("lifecycle.ready", readyHandler, {
  ipc: ApiIpcChannels.LIFECYCLE_READY,
});

// Get the typed API interface (all methods are now registered)
codeHydraApi = registry.getInterface();

// 11. Dispatch app:start

// Dispatch app:start — orchestrates the entire startup flow via hook points
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

// 12. App lifecycle handlers

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);
  }
});

app.on("before-quit", () => {
  void dispatcher.dispatch({
    type: INTENT_APP_SHUTDOWN,
    payload: {},
  } as AppShutdownIntent);
});
