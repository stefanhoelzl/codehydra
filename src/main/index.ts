/**
 * Electron main process entry point.
 * Initializes all components and manages the application lifecycle.
 *
 * File layout:
 * 1. Imports
 * 2. Core initializations (buildInfo, platformInfo, pathProvider, logging)
 * 3. Electron layers (all constructors are pure)
 * 4. Service construction
 * 5. Manager construction (two-phase: constructor only, no Electron resources)
 * 6. Intent modules (existing extracted modules)
 * 7. New modules (electron-lifecycle, logging, script, retry, lifecycle-ready)
 * 8. Operation registration + IPC event bridge
 * 9. Register all modules + dispatch app:start
 * 10. App lifecycle handlers
 */

// 1. Imports
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
import { PostHogTelemetryService } from "../services/telemetry";
import { AutoUpdater } from "../services/auto-updater";
import { ExecaProcessRunner } from "../services/platform/process";
import { Path } from "../services/platform/path";
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
  type DownloadRequest,
} from "../services/binary-download";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrl,
  getCodeServerExecutablePath,
} from "../services/code-server/setup-info";
import {
  OPENCODE_VERSION,
  getOpencodeUrl,
  getOpencodeExecutablePath,
} from "../agents/opencode/setup-info";
import { CLAUDE_VERSION, getClaudeUrl, getClaudeExecutablePath } from "../agents/claude/setup-info";
import type { SupportedPlatform, SupportedArch } from "../agents/types";
import { ExtensionManager } from "../services/vscode-setup/extension-manager";
import { AgentStatusManager, createAgentServerManager } from "../agents";
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import { PluginServer } from "../services/plugin-server";
import { McpServerManager } from "../services/mcp-server";
import { createMcpHandlers } from "./modules/mcp-handlers";
import { WindowManager } from "./managers/window-manager";
import { ViewManager } from "./managers/view-manager";
import { BadgeManager } from "./managers/badge-manager";
import { registerLogHandlers } from "./ipc";
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
import { createLinuxProcessCleanupModule } from "./modules/linux-process-cleanup-module";
import { createMacOSProcessCleanupModule } from "./modules/macos-process-cleanup-module";
import { createWindowTitleModule } from "./modules/window-title-module";
import { createTelemetryModule } from "./modules/telemetry-module";
import { createAutoUpdaterModule } from "./modules/auto-updater-module";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createBadgeModule } from "./modules/badge-module";
import { createMcpModule } from "./modules/mcp-module";
import { createConfigModule } from "./modules/config-module";
import { createElectronLifecycleModule } from "./modules/electron-lifecycle-module";
import { createLoggingModule } from "./modules/logging-module";
import { createScriptModule } from "./modules/script-module";
import { createTempDirModule } from "./modules/temp-dir-module";
import { createErrorHandlerModule } from "./modules/error-handler-module";
import { createShortcutModule } from "./modules/shortcut-module";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { createWorkspaceSelectionModule } from "./modules/workspace-selection-module";
import { createAutoWorkspaceModule } from "./modules/auto-workspace/module";
import { createGitHubSource } from "./modules/auto-workspace/github-source";
import { createYouTrackSource } from "./modules/auto-workspace/youtrack-source";
import { AppStartOperation, INTENT_APP_START } from "./operations/app-start";
import type { AppStartIntent } from "./operations/app-start";
import { ConfigSetValuesOperation, INTENT_CONFIG_SET_VALUES } from "./operations/config-set-values";
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
import { ListProjectsOperation, INTENT_LIST_PROJECTS } from "./operations/list-projects";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./operations/open-workspace";
import { GetProjectBasesOperation, INTENT_GET_PROJECT_BASES } from "./operations/get-project-bases";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
} from "./operations/delete-workspace";
import type { DeleteWorkspaceIntent, DeleteWorkspacePayload } from "./operations/delete-workspace";
import {
  OpenProjectOperation,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
  EVENT_PROJECT_OPEN_FAILED,
} from "./operations/open-project";
import type { OpenProjectPayload } from "./operations/open-project";
import { expandGitUrl } from "../services/project/url-utils";
import { CloseProjectOperation, INTENT_CLOSE_PROJECT } from "./operations/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./operations/switch-workspace";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./operations/update-available";
import { UpdateApplyOperation, INTENT_UPDATE_APPLY } from "./operations/update-apply";
import {
  ResolveWorkspaceOperation,
  INTENT_RESOLVE_WORKSPACE,
} from "./operations/resolve-workspace";
import { ResolveProjectOperation, INTENT_RESOLVE_PROJECT } from "./operations/resolve-project";
import { ElectronBuildInfo } from "./build-info";
import { NodePlatformInfo } from "./platform-info";
import { AsyncWatcher } from "../services/platform/async-watcher";
import { getErrorMessage } from "../shared/error-utils";

// Async watcher — detect unexpected I/O before app.whenReady()
const asyncWatcher = new AsyncWatcher(["PROMISE", "TickObject", "RANDOMBYTESREQUEST"]);
asyncWatcher.enable();

// 2. Core initializations (buildInfo, platformInfo, pathProvider, logging)

const buildInfo: BuildInfo = new ElectronBuildInfo();

const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);
const loggingService: LoggingService = new ElectronLogService(pathProvider);
// Logging is configured via config module's before-ready hook (env vars)
// and config:updated events. No direct env var parsing here.
const appLogger = loggingService.createLogger("app");
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const fileSystemLayer = new DefaultFileSystemLayer(loggingService.createLogger("fs"));

// 3. Electron layers (all constructors are pure — just store deps)

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
const ipcLayer = new DefaultIpcLayer();

// 4. Service construction

const telemetryService = new PostHogTelemetryService({
  buildInfo,
  platformInfo,
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
  loggingService.createLogger("binary-download")
);

// Compute platform-specific executable paths and download URLs
const platform = platformInfo.platform as SupportedPlatform;
const arch = platformInfo.arch as SupportedArch;

const codeServerExecutablePath = getCodeServerExecutablePath(platform);
const codeServerBinaryPath = new Path(
  pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`),
  codeServerExecutablePath
).toNative();

const codeServerDownloadRequest: DownloadRequest = {
  name: "code-server",
  url: getCodeServerUrl(platform, arch),
  destDir: pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toNative(),
  executablePath: codeServerExecutablePath,
};

const codeServerConfig: CodeServerConfig = {
  port: getCodeServerPort(buildInfo),
  binaryPath: codeServerBinaryPath,
  runtimeDir: pathProvider.dataPath("runtime").toNative(),
  extensionsDir: pathProvider.dataPath("vscode/extensions").toNative(),
  userDataDir: pathProvider.dataPath("vscode/user-data").toNative(),
  binDir: pathProvider.dataPath("bin").toNative(),
  codeServerDir: pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toNative(),
  opencodeDir: pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative(),
};

const codeServerManager = new CodeServerManager(
  codeServerConfig,
  processRunner,
  networkLayer,
  networkLayer,
  loggingService.createLogger("code-server"),
  { service: binaryDownloadService, request: codeServerDownloadRequest }
);

// Per-agent binary managers (one per agent type, created upfront)
const claudeBinaryManager = new AgentBinaryManager(
  {
    name: "claude",
    version: CLAUDE_VERSION,
    destDir: CLAUDE_VERSION ? pathProvider.bundlePath(`claude/${CLAUDE_VERSION}`).toNative() : "",
    url: CLAUDE_VERSION ? getClaudeUrl(platform, arch) : "",
    executablePath: getClaudeExecutablePath(platform),
  },
  binaryDownloadService,
  loggingService.createLogger("agent-binary")
);
const opencodeBinaryManager = new AgentBinaryManager(
  {
    name: "opencode",
    version: OPENCODE_VERSION,
    destDir: pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative(),
    url: getOpencodeUrl(platform, arch),
    executablePath: getOpencodeExecutablePath(platform),
  },
  binaryDownloadService,
  loggingService.createLogger("agent-binary")
);

// ExtensionManager for extension preflight/install
const setupExtensionManager = new ExtensionManager(
  pathProvider,
  fileSystemLayer,
  processRunner,
  codeServerBinaryPath,
  loggingService.createLogger("ext-manager")
);

const hookRegistry = new HookRegistry();
const dispatcher = new Dispatcher(hookRegistry, loggingService.createLogger("dispatcher"));

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
  pathProvider.runtimePath("scripts/blocking-processes.ps1").toNative()
);

const apiLogger = loggingService.createLogger("api");
const lifecycleLogger = loggingService.createLogger("lifecycle");

// 5. Manager construction (two-phase: constructor only, no Electron resources)

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
    backgroundHtmlPath: nodePath.join(__dirname, "../renderer/background.html"),
  },
  logger: loggingService.createLogger("view"),
});

const badgeManager = new BadgeManager(
  platformInfo,
  appLayer,
  imageLayer,
  windowManager,
  loggingService.createLogger("badge")
);

// McpServerManager with handlers factory that dispatches intents directly
const mcpServerManager = new McpServerManager(
  networkLayer,
  () => createMcpHandlers(dispatcher, pluginServer),
  loggingService.createLogger("mcp")
);

// 6. Intent modules (all at module level)

const idempotencyModule = createIdempotencyModule([
  { intentType: INTENT_APP_SHUTDOWN },
  { intentType: INTENT_SETUP, resetOn: EVENT_SETUP_ERROR },
  {
    intentType: INTENT_DELETE_WORKSPACE,
    getKey: (p) => {
      const { workspacePath } = p as DeleteWorkspacePayload;
      return workspacePath;
    },
    resetOn: [EVENT_WORKSPACE_DELETED, EVENT_WORKSPACE_DELETE_FAILED],
    isForced: (intent) => (intent as DeleteWorkspaceIntent).payload.force,
  },
  {
    intentType: INTENT_OPEN_PROJECT,
    getKey: (p) => {
      const payload = p as OpenProjectPayload;
      if (payload.path) return payload.path.toString();
      if (payload.git) return expandGitUrl(payload.git);
      return undefined; // select-folder case: no dedup
    },
    resetOn: [EVENT_PROJECT_OPENED, EVENT_PROJECT_OPEN_FAILED],
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
});

const codeServerModule = createCodeServerModule({
  codeServerManager,
  extensionManager: setupExtensionManager,
  pluginServer,
  dispatcher,
  fileSystemLayer,
  workspaceFileService,
  pathProvider,
  platform,
  arch,
  wrapperPath: pathProvider.dataPath("bin/ch-claude", { cmd: true }).toString(),
  logger: apiLogger,
});

const claudeAgentModule = createClaudeAgentModule({
  agentBinaryManager: claudeBinaryManager,
  serverManager: agentServerManagers.claude as ClaudeCodeServerManager,
  agentStatusManager,
  dispatcher,
  logger: apiLogger,
  loggingService,
});

const opencodeAgentModule = createOpenCodeAgentModule({
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
const deleteWindowsLockModule =
  platformInfo.platform === "win32"
    ? createWindowsFileLockModule({
        workspaceLockHandler: workspaceLockHandler!,
        logger: apiLogger,
      })
    : undefined;
const linuxProcessCleanupModule =
  platformInfo.platform === "linux"
    ? createLinuxProcessCleanupModule({ processRunner, logger: apiLogger })
    : undefined;
const macosProcessCleanupModule =
  platformInfo.platform === "darwin"
    ? createMacOSProcessCleanupModule({ processRunner, logger: apiLogger })
    : undefined;
const windowTitleModule = createWindowTitleModule(
  (title: string) => windowManager.setTitle(title),
  buildInfo.gitBranch ?? buildInfo.version
);
const telemetryLifecycleModule = createTelemetryModule({
  telemetryService,
  platformInfo,
  buildInfo,
  dispatcher,
});
const autoUpdaterLifecycleModule = createAutoUpdaterModule({
  autoUpdater,
  dispatcher,
  ipcLayer,
});
const localProjectModule = createLocalProjectModule({
  projectsDir: pathProvider.dataPath("projects").toString(),
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
const badgeModule = createBadgeModule(badgeManager);
const workspaceSelectionModule = createWorkspaceSelectionModule(agentStatusManager);
const mcpModule = createMcpModule({
  mcpServerManager,
});
const githubSource = createGitHubSource({
  processRunner,
  httpClient: networkLayer,
  logger: loggingService.createLogger("auto-workspace:github"),
});
const youtrackSource = createYouTrackSource({
  httpClient: networkLayer,
  logger: loggingService.createLogger("auto-workspace:youtrack"),
});
const autoWorkspaceModule = createAutoWorkspaceModule({
  fs: fileSystemLayer,
  logger: loggingService.createLogger("auto-workspace"),
  stateFilePath: pathProvider.dataPath("auto-workspaces.json").toString(),
  dispatcher,
  sources: [githubSource, youtrackSource],
});

// 7. New modules

const configModule = createConfigModule({
  fileSystem: fileSystemLayer,
  configPath: pathProvider.dataPath("config.json"),
  dispatcher,
  logger: loggingService.createLogger("config"),
  isDevelopment: buildInfo.isDevelopment,
  isPackaged: buildInfo.isPackaged,
  env: process.env as Record<string, string | undefined>,
  argv: process.argv,
  stdout: process.stdout,
});

const electronLifecycleModule = createElectronLifecycleModule({
  app,
  buildInfo,
  pathProvider,
  asyncWatcher,
  logger: lifecycleLogger,
});

const loggingModule = createLoggingModule({
  loggingService,
  registerLogHandlers: () => registerLogHandlers(loggingService),
  buildInfo,
  platformInfo,
  logger: appLogger,
});

const scriptModule = createScriptModule({
  fileSystem: fileSystemLayer,
  pathProvider,
});

const tempDirModule = createTempDirModule({
  fileSystem: fileSystemLayer,
  pathProvider,
});

const errorHandlerModule = createErrorHandlerModule({
  logger: appLogger,
});

const shortcutModule = createShortcutModule({
  viewManager,
  viewLayer,
  windowLayer,
  getWindowHandle: () => windowManager.getWindowHandle(),
  dispatch: (intent) => dispatcher.dispatch(intent),
  logger: loggingService.createLogger("shortcut"),
  isDevelopment: buildInfo.isDevelopment,
});

// 8. Operation registration

dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new ConfigSetValuesOperation());
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
dispatcher.registerOperation(INTENT_LIST_PROJECTS, new ListProjectsOperation());
dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
dispatcher.registerOperation(INTENT_GET_PROJECT_BASES, new GetProjectBasesOperation());

dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new DeleteWorkspaceOperation());

dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());

dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());
dispatcher.registerOperation(INTENT_UPDATE_APPLY, new UpdateApplyOperation());

// Create IPC event bridge (registers all IPC handlers directly on ipcLayer)
const ipcEventBridge = createIpcEventBridge({
  ipcLayer,
  sendToUI: (...args) => viewManager.sendToUI(...args),
  logger: apiLogger,
  dispatcher,
  readyHandler,
  agentStatusManager,
});

// 9. Register all modules

dispatcher.registerModule(idempotencyModule);
dispatcher.registerModule(configModule);
dispatcher.registerModule(viewModule);
dispatcher.registerModule(codeServerModule);
dispatcher.registerModule(claudeAgentModule);
dispatcher.registerModule(opencodeAgentModule);
dispatcher.registerModule(badgeModule);
dispatcher.registerModule(workspaceSelectionModule);
dispatcher.registerModule(metadataModule);
dispatcher.registerModule(keepFilesModule);
if (deleteWindowsLockModule) dispatcher.registerModule(deleteWindowsLockModule);
if (linuxProcessCleanupModule) dispatcher.registerModule(linuxProcessCleanupModule);
if (macosProcessCleanupModule) dispatcher.registerModule(macosProcessCleanupModule);
dispatcher.registerModule(remoteProjectModule);
dispatcher.registerModule(localProjectModule);
dispatcher.registerModule(gitWorktreeWorkspaceModule);
dispatcher.registerModule(windowTitleModule);
dispatcher.registerModule(telemetryLifecycleModule);
dispatcher.registerModule(autoUpdaterLifecycleModule);
dispatcher.registerModule(mcpModule);
dispatcher.registerModule(electronLifecycleModule);
dispatcher.registerModule(loggingModule);
dispatcher.registerModule(scriptModule);
dispatcher.registerModule(tempDirModule);
dispatcher.registerModule(errorHandlerModule);
dispatcher.registerModule(shortcutModule);
dispatcher.registerModule(autoWorkspaceModule);
dispatcher.registerModule(ipcEventBridge);

// 10. Dispatch app:start

// Dispatch app:start — orchestrates the entire startup flow via hook points
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

// 11. App lifecycle handlers

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
