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
import { app, powerMonitor } from "electron";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
// Boundaries - Platform
import { DefaultPathProvider, type PathProvider } from "./boundaries/platform/path-provider";
import type { BuildInfo } from "./boundaries/platform/build-info";
import { ElectronLog, type Logging } from "./boundaries/platform/logging";
import { DefaultFileSystemBoundary } from "./boundaries/platform/filesystem";
import { DefaultNetworkLayer } from "./boundaries/platform/network";
import { ExecaProcessRunner } from "./boundaries/platform/process";
import { GitWorktreeProvider } from "./boundaries/platform/git-worktree-provider";
import { SimpleGitClient } from "./boundaries/platform/simple-git-client";
import { DefaultConfig } from "./boundaries/platform/config";
import {
  configBoolean,
  configEnum,
  ConfigValidationError,
} from "./boundaries/platform/config-definition";
// Boundaries - Shell
import { DefaultIpcBoundary } from "./boundaries/shell/ipc";
import { DefaultAppBoundary } from "./boundaries/shell/app";
import { DefaultImageBoundary } from "./boundaries/shell/image";
import { DefaultDialogBoundary } from "./boundaries/shell/dialog";
import { DefaultMenuBoundary } from "./boundaries/shell/menu";
import { DefaultWindowBoundary } from "./boundaries/shell/window";
import { DefaultViewBoundary } from "./boundaries/shell/view";
import { DefaultSessionBoundary } from "./boundaries/shell/session";
import { WindowManager } from "./boundaries/shell/window-manager";
import { WebContentsViewManager } from "./boundaries/shell/webcontents-view-manager";
// Services (stayed)
import { AutoUpdater } from "./modules/auto-updater";
import { DefaultArchiveExtractor } from "./boundaries/platform/archive";
import type { DownloadDeps } from "./utils/binary-download";
import { getOpencodeExecutablePath } from "./modules/agent-module/opencode/setup-info";
import { getClaudeExecutablePath } from "./modules/agent-module/claude/setup-info";
import type { SupportedPlatform, SupportedArch } from "./boundaries/platform/platform-info";
import { ClaudeCodeServerManager } from "./modules/agent-module/claude/server-manager";
import { OpenCodeServerManager } from "./modules/agent-module/opencode/server-manager";
import { createClaudeModuleProvider } from "./modules/agent-module/claude/module-provider";
import { createOpenCodeModuleProvider } from "./modules/agent-module/opencode/module-provider";
import { expandGitUrl } from "./utils/url-utils";
import { AsyncWatcher } from "./boundaries/platform/async-watcher";
// Main
import { ElectronBuildInfo } from "./boundaries/platform/electron-build-info";
import { NodePlatformInfo } from "./boundaries/platform/node-platform-info";
// Intents
import { Dispatcher } from "./intents/lib/dispatcher";
import { createIdempotencyModule } from "./intents/lib/idempotency-module";
import { AppStartOperation, INTENT_APP_START } from "./intents/app-start";
import type { AppStartIntent } from "./intents/app-start";
import { AppReadyOperation, INTENT_APP_READY } from "./intents/app-ready";
// ConfigSetValuesOperation removed — config is now a plain service
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "./intents/app-shutdown";
import { AppResumeOperation, INTENT_APP_RESUME, EVENT_APP_RESUMED } from "./intents/app-resume";
import type { AppShutdownIntent } from "./intents/app-shutdown";
import { SetupOperation, INTENT_SETUP, EVENT_SETUP_ERROR } from "./intents/setup";
import { SetModeOperation, INTENT_SET_MODE } from "./intents/set-mode";
import { SetMetadataOperation, INTENT_SET_METADATA } from "./intents/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "./intents/get-metadata";
import {
  GetWorkspaceStatusOperation,
  INTENT_GET_WORKSPACE_STATUS,
} from "./intents/get-workspace-status";
import { GetAgentSessionOperation, INTENT_GET_AGENT_SESSION } from "./intents/get-agent-session";
import { RestartAgentOperation, INTENT_RESTART_AGENT } from "./intents/restart-agent";
import {
  GetActiveWorkspaceOperation,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./intents/get-active-workspace";
import { ListProjectsOperation, INTENT_LIST_PROJECTS } from "./intents/list-projects";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./intents/open-workspace";
import { GetProjectBasesOperation, INTENT_GET_PROJECT_BASES } from "./intents/get-project-bases";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
} from "./intents/delete-workspace";
import type { DeleteWorkspaceIntent, DeleteWorkspacePayload } from "./intents/delete-workspace";
import {
  HibernateWorkspaceOperation,
  INTENT_HIBERNATE_WORKSPACE,
  EVENT_WORKSPACE_HIBERNATED,
  EVENT_WORKSPACE_HIBERNATE_FAILED,
} from "./intents/hibernate-workspace";
import type { HibernateWorkspacePayload } from "./intents/hibernate-workspace";
import {
  WakeWorkspaceOperation,
  INTENT_WAKE_WORKSPACE,
  EVENT_WORKSPACE_WOKEN,
  EVENT_WORKSPACE_WAKE_FAILED,
} from "./intents/wake-workspace";
import type { WakeWorkspacePayload } from "./intents/wake-workspace";
import { createHibernationScreenshotModule } from "./modules/hibernation-screenshot-module";
import {
  OpenProjectOperation,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
  EVENT_PROJECT_OPEN_FAILED,
} from "./intents/open-project";
import type { OpenProjectPayload } from "./intents/open-project";
import { CloseProjectOperation, INTENT_CLOSE_PROJECT } from "./intents/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./intents/switch-workspace";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./intents/update-agent-status";
import { ShortcutKeyOperation, INTENT_SHORTCUT_KEY } from "./intents/shortcut-key";
import { SubmitBugReportOperation, INTENT_SUBMIT_BUG_REPORT } from "./intents/submit-bug-report";
import {
  VscodeShowMessageOperation,
  INTENT_VSCODE_SHOW_MESSAGE,
} from "./intents/vscode-show-message";
import { VscodeCommandOperation, INTENT_VSCODE_COMMAND } from "./intents/vscode-command";
import { ResolveWorkspaceOperation, INTENT_RESOLVE_WORKSPACE } from "./intents/resolve-workspace";
import { ResolveProjectOperation, INTENT_RESOLVE_PROJECT } from "./intents/resolve-project";
// Modules
import { createExtensionModule } from "./modules/extension-module";
import { createViewModule } from "./modules/view-module";
import { createCodeServerModule } from "./modules/code-server-module";
import { createPluginServerModule } from "./modules/plugin-server-module";
import { createAgentModule } from "./modules/agent-module/agent-module";
import { createMetadataModule } from "./modules/metadata-module";
import { createWorkspaceAgentResolverModule } from "./modules/workspace-agent-resolver-module";
import { createKeepFilesModule } from "./modules/keepfiles-module";
import { createWindowsFileLockModule } from "./modules/windows-file-lock-module";
import { createPosixProcessCleanupModule } from "./modules/posix-process-cleanup-module";
import { createWindowTitleModule } from "./modules/window-title-module";
import { createPosthogModule } from "./modules/posthog-module";
import { createAutoUpdaterModule } from "./modules/auto-updater-module";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createBadgeModule } from "./modules/badge-module";
import { createMcpModule } from "./modules/mcp-module";
import { createElectronLifecycleModule } from "./modules/electron-lifecycle-module";
import { createLoggingModule } from "./modules/logging-module";
import { createScriptModule } from "./modules/script-module";
import { createTempDirModule } from "./modules/temp-dir-module";
import { createErrorHandlerModule } from "./modules/error-handler-module";
import { createShortcutModule } from "./modules/shortcut-module";
import { createDevtoolsModule } from "./modules/devtools-module";
import { createThemeModule } from "./modules/theme-module";
import { createDebugModule } from "./modules/debug-module";
import { createUiIpcModule } from "./modules/ui-ipc-module";
import { DialogManager } from "./modules/dialog-manager";
import { NotificationManager } from "./modules/notification-manager";
import { createCloneNotificationModule } from "./modules/clone-notification-module";
import { createErrorNotificationModule } from "./modules/error-notification-module";
import { createDeletionDialogModule } from "./modules/deletion-dialog-module";
import { createBugReportModule } from "./modules/bug-report-module";
import { createWorkspaceSelectionModule } from "./modules/workspace-selection-module";
import { createAutoWorkspaceModule } from "./modules/auto-workspace/module";
import { createGitHubSource } from "./modules/auto-workspace/github-source";
import { createYouTrackSource } from "./modules/auto-workspace/youtrack-source";
// Shared
import { getErrorMessage } from "./shared/error-utils";

// Async watcher — detect unexpected I/O before app.whenReady()
const asyncWatcher = new AsyncWatcher(["PROMISE", "TickObject", "RANDOMBYTESREQUEST"]);
asyncWatcher.enable();

// 2. Core initializations (buildInfo, platformInfo, pathProvider, logging)

const buildInfo: BuildInfo = new ElectronBuildInfo();

const platformInfo = new NodePlatformInfo();
const pathProvider: PathProvider = new DefaultPathProvider(buildInfo, platformInfo);
const loggingService: Logging = new ElectronLog(pathProvider);
const appLogger = loggingService.createLogger("app");
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const fileSystemLayer = new DefaultFileSystemBoundary(loggingService.createLogger("fs"));

// Config — constructed before modules so they can register keys
const configService = new DefaultConfig({
  configPath: pathProvider.dataPath("config.json"),
  fileSystem: fileSystemLayer,
  logger: loggingService.createLogger("config"),
  isDevelopment: buildInfo.isDevelopment,
  isPackaged: buildInfo.isPackaged,
  env: process.env as Record<string, string | undefined>,
  argv: process.argv,
});

// Register core config keys (not owned by any module)
configService.register("agent", {
  name: "agent",
  default: null,
  description: "Agent selection",
  ...configEnum(["claude", "opencode"], { nullable: true }),
});
configService.register("help", {
  name: "help",
  default: false,
  description: "Print config help and exit",
  ...configBoolean(),
});

// 3. Electron layers (all constructors are pure — just store deps)

const dialogLayer = new DefaultDialogBoundary(loggingService.createLogger("dialog"));
const menuLayer = new DefaultMenuBoundary(loggingService.createLogger("menu"));
const imageLayer = new DefaultImageBoundary(loggingService.createLogger("window"));
const windowLayer = new DefaultWindowBoundary(
  imageLayer,
  platformInfo,
  loggingService.createLogger("window")
);
const viewLayer = new DefaultViewBoundary(windowLayer, loggingService.createLogger("view"));
const sessionLayer = new DefaultSessionBoundary(loggingService.createLogger("view"));
const appLayer = new DefaultAppBoundary(loggingService.createLogger("badge"));
const ipcLayer = new DefaultIpcBoundary();

// 4. Service construction

// Process runner uses platform-native tree killing (taskkill on Windows, process.kill on Unix)
const processRunner = new ExecaProcessRunner(loggingService.createLogger("process"));
const networkLayer = new DefaultNetworkLayer(loggingService.createLogger("network"));

// Compute platform-specific executable paths and download URLs
const platform = platformInfo.platform as SupportedPlatform;
const arch = platformInfo.arch as SupportedArch;

// Shared download dependencies for binary downloads
const archiveExtractor = new DefaultArchiveExtractor();
const downloadDeps: DownloadDeps = {
  httpClient: networkLayer,
  fileSystemLayer,
  archiveExtractor,
  logger: loggingService.createLogger("binary-download"),
};

// Per-agent binary configs (non-version fields only; version comes from configService)
const claudeBinaryConfig = {
  name: "claude" as const,
  executablePath: getClaudeExecutablePath(platform),
  archiveExtension: ".tar.gz" as const,
};
const opencodeBinaryConfig = {
  name: "opencode" as const,
  executablePath: getOpencodeExecutablePath(platform),
  archiveExtension: (platform === "darwin" ? ".zip" : platform === "win32" ? ".zip" : ".tar.gz") as
    | ".tar.gz"
    | ".zip",
};

const dispatcher = new Dispatcher({
  logger: loggingService.createLogger("dispatcher"),
  initialCapabilities: {
    platform: platformInfo.platform,
    posix: platformInfo.posix,
    arch: platformInfo.arch,
    development: buildInfo.isDevelopment,
  },
});

const gitClient = new SimpleGitClient(loggingService.createLogger("git"));
const gitWorktreeProvider = new GitWorktreeProvider(
  gitClient,
  fileSystemLayer,
  loggingService.createLogger("worktree")
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
  claude: new ClaudeCodeServerManager({
    portManager: serverManagerDeps.portManager,
    pathProvider: serverManagerDeps.pathProvider,
    fileSystem: serverManagerDeps.fileSystem,
    logger: serverManagerDeps.logger,
  }),
  opencode: new OpenCodeServerManager(
    serverManagerDeps.processRunner,
    serverManagerDeps.portManager,
    serverManagerDeps.httpClient,
    serverManagerDeps.pathProvider,
    configService,
    serverManagerDeps.logger
  ),
};
const providerLogger = loggingService.createLogger("agent");

const apiLogger = loggingService.createLogger("api");
const lifecycleLogger = loggingService.createLogger("lifecycle");

// 5. Manager construction (two-phase: constructor only, no Electron resources)

const windowManager = new WindowManager(
  {
    windowLayer,
    imageLayer,
    appLayer,
    logger: loggingService.createLogger("window"),
    platformInfo,
  },
  "CodeHydra",
  pathProvider.appIconPath.toNative()
);

const viewManager = new WebContentsViewManager({
  windowManager,
  windowLayer,
  viewLayer,
  sessionLayer,
  appLayer,
  config: {
    uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
    codeServerPort: 0,
  },
  logger: loggingService.createLogger("view"),
});

// 6. Intent modules (all at module level)

const idempotencyModule = createIdempotencyModule([
  { intentType: INTENT_APP_SHUTDOWN },
  { intentType: INTENT_APP_READY },
  { intentType: INTENT_APP_RESUME, resetOn: EVENT_APP_RESUMED },
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
    intentType: INTENT_HIBERNATE_WORKSPACE,
    getKey: (p) => (p as HibernateWorkspacePayload).workspacePath,
    resetOn: [EVENT_WORKSPACE_HIBERNATED, EVENT_WORKSPACE_HIBERNATE_FAILED],
  },
  {
    intentType: INTENT_WAKE_WORKSPACE,
    getKey: (p) => (p as WakeWorkspacePayload).workspacePath,
    resetOn: [EVENT_WORKSPACE_WOKEN, EVENT_WORKSPACE_WAKE_FAILED],
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

const dialogManager = new DialogManager(viewManager.sendToUI.bind(viewManager), apiLogger);
const notificationManager = new NotificationManager(viewManager, apiLogger);
const cloneNotificationModule = createCloneNotificationModule({ notificationManager });
const errorNotificationModule = createErrorNotificationModule({ notificationManager });

const viewModule = createViewModule({
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
  configService,
  dialogManager,
  dispatcher,
});

const codeServerModule = createCodeServerModule({
  processRunner,
  httpClient: networkLayer,
  portManager: networkLayer,
  fileSystemLayer,
  pathProvider,
  buildInfo,
  platform,
  arch,
  wrapperPath: pathProvider.dataPath("bin/ch-claude", { cmd: true }).toString(),
  logger: apiLogger,
  archiveExtractor,
  configService,
});

const pluginServerModule = createPluginServerModule({
  portManager: networkLayer,
  dispatcher,
  appLayer,
  logger: apiLogger,
  options: {
    isDevelopment: buildInfo.isDevelopment,
    extensionLogger: loggingService.createLogger("extension"),
  },
});

const extensionModule = createExtensionModule({
  pathProvider,
  fileSystemLayer,
  logger: loggingService.createLogger("ext-manager"),
});

const claudeAgentModule = createAgentModule(
  createClaudeModuleProvider({
    serverManager: agentServerManagers.claude,
    downloadDeps,
    binaryConfig: claudeBinaryConfig,
    configService,
    pathProvider,
    platform,
    arch,
    logger: providerLogger,
  }),
  { dispatcher, logger: apiLogger, configService }
);

const opencodeAgentModule = createAgentModule(
  createOpenCodeModuleProvider({
    serverManager: agentServerManagers.opencode,
    downloadDeps,
    binaryConfig: opencodeBinaryConfig,
    configService,
    pathProvider,
    platform,
    arch,
    logger: providerLogger,
  }),
  { dispatcher, logger: apiLogger, configService }
);

const metadataModule = createMetadataModule({
  gitWorktreeProvider,
});
const workspaceAgentResolverModule = createWorkspaceAgentResolverModule({
  gitWorktreeProvider,
  configService,
  logger: loggingService.createLogger("agent-resolver"),
});
const keepFilesModule = createKeepFilesModule({
  fileSystem: fileSystemLayer,
  logger: loggingService.createLogger("keepfiles"),
});
const deleteWindowsLockModule = createWindowsFileLockModule({
  processRunner,
  scriptPath: pathProvider.runtimePath("scripts/blocking-processes.ps1").toNative(),
  logger: apiLogger,
});
const posixProcessCleanupModule = createPosixProcessCleanupModule({
  processRunner,
  logger: apiLogger,
});
const windowTitleModule = createWindowTitleModule({
  windowManager,
  titleVersion: buildInfo.gitBranch ?? buildInfo.version,
});
const posthogModule = createPosthogModule({
  platformInfo,
  buildInfo,
  configService,
  logger: loggingService.createLogger("telemetry"),
  apiKey: typeof __POSTHOG_API_KEY__ !== "undefined" ? __POSTHOG_API_KEY__ : undefined,
  host: typeof __POSTHOG_HOST__ !== "undefined" ? __POSTHOG_HOST__ : undefined,
});
const autoUpdaterLifecycleModule = createAutoUpdaterModule({
  autoUpdater,
  dispatcher,
  configService,
  notificationManager,
});
const localProjectModule = createLocalProjectModule({
  projectsDir: pathProvider.dataPath("projects").toString(),
  fs: fileSystemLayer,
  gitWorktreeProvider,
  dialogManager,
  gitClient,
});
const remoteProjectModule = createRemoteProjectModule({
  fs: fileSystemLayer,
  gitClient,
  pathProvider,
  logger: lifecycleLogger,
});
const gitWorktreeWorkspaceModule = createGitWorktreeWorkspaceModule(
  gitWorktreeProvider,
  pathProvider,
  apiLogger
);
const badgeModule = createBadgeModule({
  platformInfo,
  appLayer,
  imageLayer,
  windowManager,
  logger: loggingService.createLogger("badge"),
});
const deletionDialogModule = createDeletionDialogModule({
  dialogManager,
  dispatcher,
  logger: apiLogger,
});
const workspaceSelectionModule = createWorkspaceSelectionModule();
const mcpModule = createMcpModule({
  portManager: networkLayer,
  dispatcher,
  logger: loggingService.createLogger("mcp"),
});
const githubSource = createGitHubSource({
  processRunner,
  httpClient: networkLayer,
  logger: loggingService.createLogger("auto-workspace:github"),
  configService,
});
const youtrackSource = createYouTrackSource({
  httpClient: networkLayer,
  logger: loggingService.createLogger("auto-workspace:youtrack"),
  configService,
});
const autoWorkspaceModule = createAutoWorkspaceModule({
  fs: fileSystemLayer,
  logger: loggingService.createLogger("auto-workspace"),
  stateFilePath: pathProvider.dataPath("auto-workspaces.json").toString(),
  dispatcher,
  sources: [githubSource, youtrackSource],
  configService,
});

// 7. New modules

const electronLifecycleModule = createElectronLifecycleModule({
  app,
  buildInfo,
  pathProvider,
  asyncWatcher,
  powerMonitor,
  dispatcher,
  logger: lifecycleLogger,
  configService,
});

const loggingModule = createLoggingModule({
  loggingService,
  buildInfo,
  platformInfo,
  logger: appLogger,
  configService,
  app,
  fileSystem: fileSystemLayer,
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
  windowManager,
  dispatcher,
  logger: loggingService.createLogger("shortcut"),
});

const devtoolsModule = createDevtoolsModule({
  viewManager,
  viewLayer,
});

const themeModule = createThemeModule({
  viewManager,
  windowManager,
});

const debugModule = createDebugModule({ configService, notificationManager });

const bugReportModule = createBugReportModule({
  dialogManager,
  fileSystem: fileSystemLayer,
  loggingService,
  dispatcher,
  config: configService,
  logger: loggingService.createLogger("bug-report"),
});

// 8. Operation registration

dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());
dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation(configService));
dispatcher.registerOperation(INTENT_APP_READY, new AppReadyOperation(configService));
// config:set-values operation removed — config is now a plain service
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
dispatcher.registerOperation(INTENT_HIBERNATE_WORKSPACE, new HibernateWorkspaceOperation());
dispatcher.registerOperation(INTENT_WAKE_WORKSPACE, new WakeWorkspaceOperation());

dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());

dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
dispatcher.registerOperation(INTENT_SHORTCUT_KEY, new ShortcutKeyOperation());
dispatcher.registerOperation(INTENT_SUBMIT_BUG_REPORT, new SubmitBugReportOperation());
dispatcher.registerOperation(INTENT_VSCODE_SHOW_MESSAGE, new VscodeShowMessageOperation());
dispatcher.registerOperation(INTENT_VSCODE_COMMAND, new VscodeCommandOperation());

// Create UI IPC module (handles all bidirectional IPC between main and renderer)
const uiIpcModule = createUiIpcModule({
  ipcLayer,
  viewManager,
  logger: apiLogger,
  dispatcher,
  loggingService,
  dialogManager,
  notificationManager,
  pathProvider,
});

const hibernationScreenshotModule = createHibernationScreenshotModule({
  fileSystem: fileSystemLayer,
  pathProvider,
  viewManager,
  logger: loggingService.createLogger("view"),
});

// 9. Register all modules

dispatcher.registerModule(idempotencyModule);
dispatcher.registerModule(viewModule);
dispatcher.registerModule(pluginServerModule);
dispatcher.registerModule(extensionModule);
dispatcher.registerModule(codeServerModule);
dispatcher.registerModule(workspaceAgentResolverModule);
dispatcher.registerModule(claudeAgentModule);
dispatcher.registerModule(opencodeAgentModule);
dispatcher.registerModule(badgeModule);
dispatcher.registerModule(deletionDialogModule);
dispatcher.registerModule(workspaceSelectionModule);
dispatcher.registerModule(metadataModule);
dispatcher.registerModule(keepFilesModule);
dispatcher.registerModule(deleteWindowsLockModule);
dispatcher.registerModule(posixProcessCleanupModule);
dispatcher.registerModule(remoteProjectModule);
dispatcher.registerModule(localProjectModule);
dispatcher.registerModule(gitWorktreeWorkspaceModule);
dispatcher.registerModule(windowTitleModule);
dispatcher.registerModule(posthogModule);
dispatcher.registerModule(autoUpdaterLifecycleModule);
dispatcher.registerModule(mcpModule);
dispatcher.registerModule(electronLifecycleModule);
dispatcher.registerModule(loggingModule);
dispatcher.registerModule(scriptModule);
dispatcher.registerModule(tempDirModule);
dispatcher.registerModule(errorHandlerModule);
dispatcher.registerModule(shortcutModule);
dispatcher.registerModule(devtoolsModule);
dispatcher.registerModule(themeModule);
dispatcher.registerModule(debugModule);
dispatcher.registerModule(bugReportModule);
dispatcher.registerModule(autoWorkspaceModule);
dispatcher.registerModule(cloneNotificationModule);
dispatcher.registerModule(errorNotificationModule);
dispatcher.registerModule(hibernationScreenshotModule);
dispatcher.registerModule(uiIpcModule);

// Load config (sync — reads config.json, env vars, CLI args)
try {
  configService.load();
} catch (error) {
  if (error instanceof ConfigValidationError) {
    appLogger.error("Config validation failed", { key: error.detail.key }, error);
    process.stderr.write(`\nConfiguration error:\n${error.message}\n\n`);
    process.stderr.write(configService.getHelpText());
    process.exit(1);
  }
  throw error;
}

// Handle --help
if (configService.get("help") === true) {
  process.stdout.write(configService.getHelpText());
  app.quit();
}

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
