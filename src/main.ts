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
  storeBoolean,
  storeEnum,
  storeString,
  PersistedValidationError,
} from "./boundaries/platform/store-definition";
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
import { UiViewManager } from "./boundaries/shell/ui-view-manager";
// Services (stayed)
import { AutoUpdater } from "./modules/auto-updater";
import { DefaultArchiveExtractor } from "./boundaries/platform/archive-extractor";
import type { DownloadDeps } from "./utils/binary-download";
import {
  getOpencodeBundleDir,
  getOpencodeExecutablePath,
  OPENCODE_VERSION,
} from "./modules/agent-module/opencode/setup-info";
import { getClaudeExecutablePath, CLAUDE_VERSION } from "./modules/agent-module/claude/setup-info";
import type { SupportedPlatform, SupportedArch } from "./boundaries/platform/platform-info";
import { ClaudeCodeServerManager } from "./modules/agent-module/claude/server-manager";
import { configBusyDuringBackgroundShell } from "./modules/agent-module/claude/types";
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
import { AgentLifecycleOperation, INTENT_AGENT_LIFECYCLE } from "./intents/agent-lifecycle";
import {
  GetActiveWorkspaceOperation,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./intents/get-active-workspace";
import { ListProjectsOperation, INTENT_LIST_PROJECTS } from "./intents/list-projects";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./intents/open-workspace";
import { GetProjectBasesOperation, INTENT_GET_PROJECT_BASES } from "./intents/get-project-bases";
import {
  AgentLaunchOptionsOperation,
  INTENT_GET_LAUNCH_OPTIONS,
} from "./intents/agent-launch-options";
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
import {
  CloseProjectOperation,
  INTENT_CLOSE_PROJECT,
  EVENT_PROJECT_CLOSED,
  EVENT_PROJECT_CLOSE_FAILED,
  type CloseProjectPayload,
} from "./intents/close-project";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
} from "./intents/switch-workspace";
import type { WorkspaceSwitchedEvent } from "./intents/switch-workspace";
import type { GetWorkspaceStatusIntent } from "./intents/get-workspace-status";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
  EVENT_AGENT_STATUS_UPDATED,
} from "./intents/update-agent-status";
import type { AgentStatusUpdatedEvent } from "./intents/update-agent-status";
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
import { createTelemetryModule } from "./modules/telemetry-module";
import { createPostHogBoundary } from "./boundaries/platform/posthog";
import { createAutoUpdaterModule } from "./modules/auto-updater-module";
import { DefaultStateService } from "./boundaries/platform/state-service";
import { createStateModule, createStateMigrationRegistry } from "./modules/state-module";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createBadgeModule } from "./modules/badge-module";
import { createPowerModule } from "./modules/power-module";
import { createMcpModule } from "./modules/mcp-module";
import { createElectronLifecycleModule } from "./modules/electron-lifecycle-module";
import { createLoggingModule } from "./modules/logging-module";
import { createScriptModule } from "./modules/script-module";
import { createTempDirModule } from "./modules/temp-dir-module";
import { createErrorReportModule } from "./modules/error-report-module";
import { createShortcutModule } from "./modules/shortcut-module";
import { createDevtoolsModule } from "./modules/devtools-module";
import { createThemeModule } from "./modules/theme-module";
import { createDebugModule } from "./modules/debug-module";
import { createUiIpcModule } from "./modules/ui-ipc-module";
import { createPresentationModule } from "./modules/presentation-module";
import { DialogManager } from "./modules/dialog-manager";
import { NotificationManager } from "./modules/notification-manager";
import { createCloneNotificationModule } from "./modules/clone-notification-module";
import { createErrorNotificationModule } from "./modules/error-notification-module";
import { createDeletionDialogModule } from "./modules/deletion-dialog-module";
import { createCreationModule } from "./modules/creation-module";
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

// State — app-written persisted state (state.json), sibling of config. Loaded
// asynchronously by the state module in app:start/init. The migration registry
// is drained there to move keys that left config.json (telemetry.distinct-id,
// update.dismissed-version) into state.json on first launch after upgrade.
const stateService = new DefaultStateService({
  statePath: pathProvider.dataPath("state.json"),
  fileSystem: fileSystemLayer,
  logger: loggingService.createLogger("state"),
});
const stateMigrations = createStateMigrationRegistry();

// Register core config keys (not owned by any single module). Their accessors
// are threaded into the modules/intents that read or write them, so those
// consumers never reach into the config service by string key.
const agentConfig = configService.register("agent", {
  default: null,
  description: "Agent selection",
  ...storeEnum(["claude", "opencode"], { nullable: true }),
});
// telemetry.enabled is read by two modules (telemetry-module gates passive
// events; error-report-module gates crash reporting), so it is registered here
// and its accessor is threaded into both.
const telemetryEnabledConfig = configService.register("telemetry.enabled", {
  default: true,
  description: "Enable telemetry (false in dev/unpackaged)",
  ...storeBoolean(),
  computedDefault: (ctx) => (ctx.isDevelopment || !ctx.isPackaged ? false : undefined),
});
const helpConfig = configService.register("help", {
  default: false,
  description: "Print config help and exit",
  ...storeBoolean(),
});
const busyDuringBackgroundShellConfig = configService.register(
  "experimental.busy-during-background-shell",
  {
    default: true,
    description:
      "Keep workspace status busy while the agent has a background shell " +
      "running. true = every background shell; false = never; array of " +
      "regexes (config.json only) = only shells whose command matches " +
      "(e.g. a CI-wait script), so dev servers don't pin the workspace busy.",
    ...configBusyDuringBackgroundShell(),
  }
);
// Agent version keys. Registered here (composition root) rather than inside the
// agent module so the accessors exist before the server managers and providers
// that read them are constructed (those are built below, before the modules).
const claudeVersionConfig = configService.register("version.claude", {
  default: CLAUDE_VERSION,
  description: "Claude agent version",
  ...storeString({ nullable: true }),
});
const opencodeVersionConfig = configService.register("version.opencode", {
  default: OPENCODE_VERSION,
  description: "OpenCode agent version",
  ...storeString(),
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
    busyDuringBackgroundShell: busyDuringBackgroundShellConfig,
  }),
  opencode: new OpenCodeServerManager(
    serverManagerDeps.processRunner,
    serverManagerDeps.portManager,
    serverManagerDeps.httpClient,
    serverManagerDeps.pathProvider,
    opencodeVersionConfig,
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
  },
  "CodeHydra",
  pathProvider.appIconPath.toNative()
);

// UiViewManager construction is cheap (no Electron resources). The UI view
// is created inside create(), which runs later from the app-start/init hook,
// once the window exists.
const viewManager = new UiViewManager({
  windowManager,
  windowLayer,
  viewLayer,
  sessionLayer,
  appLayer,
  config: {
    uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
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
  {
    // An interactive close parks on its confirm dialog; the guard keeps a
    // second close gesture from opening a second dialog meanwhile.
    intentType: INTENT_CLOSE_PROJECT,
    getKey: (p) => (p as CloseProjectPayload).projectPath,
    resetOn: [EVENT_PROJECT_CLOSED, EVENT_PROJECT_CLOSE_FAILED],
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
  menuLayer,
  windowManager,
  uiHtmlPath,
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
  resolveOpencodeBundleDir: (): string =>
    getOpencodeBundleDir(pathProvider, opencodeVersionConfig.get()).toNative(),
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

const claudeProvider = createClaudeModuleProvider({
  serverManager: agentServerManagers.claude,
  downloadDeps,
  binaryConfig: claudeBinaryConfig,
  versionConfig: claudeVersionConfig,
  pathProvider,
  platform,
  arch,
  logger: providerLogger,
  processRunner,
});
const claudeAgentModule = createAgentModule(claudeProvider, {
  dispatcher,
  logger: apiLogger,
  agentConfig,
});

const opencodeProvider = createOpenCodeModuleProvider({
  serverManager: agentServerManagers.opencode,
  downloadDeps,
  binaryConfig: opencodeBinaryConfig,
  versionConfig: opencodeVersionConfig,
  pathProvider,
  platform,
  arch,
  logger: providerLogger,
});
const opencodeAgentModule = createAgentModule(opencodeProvider, {
  dispatcher,
  logger: apiLogger,
  agentConfig,
});

// Agents whose binaries are currently present — same probe the app:ready
// "available-agents" hook runs, exposed to the creation form module.
const getAvailableAgents = async (): Promise<readonly AgentInfo[]> => {
  const agents: AgentInfo[] = [];
  for (const provider of [claudeProvider, opencodeProvider]) {
    try {
      const result = await provider.preflight();
      if (result.success && !result.needsDownload) {
        agents.push({ agent: provider.type, label: provider.displayName, icon: provider.icon });
      }
    } catch {
      // Best-effort: a failing preflight just hides the agent.
    }
  }
  return agents;
};

const metadataModule = createMetadataModule({
  gitWorktreeProvider,
});
const workspaceAgentResolverModule = createWorkspaceAgentResolverModule({
  gitWorktreeProvider,
  agentConfig,
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
// The PostHog sink, shared by telemetry-module (passive events) and
// error-report-module (crash + bug reports).
const postHogBoundary = createPostHogBoundary({
  logger: loggingService.createLogger("telemetry"),
  apiKey: typeof __POSTHOG_API_KEY__ !== "undefined" ? __POSTHOG_API_KEY__ : undefined,
  host: typeof __POSTHOG_HOST__ !== "undefined" ? __POSTHOG_HOST__ : undefined,
});
const telemetryModule = createTelemetryModule({
  platformInfo,
  buildInfo,
  configService,
  stateService,
  stateMigrations,
  agentConfig,
  telemetryEnabled: telemetryEnabledConfig,
  boundary: postHogBoundary,
  logger: loggingService.createLogger("telemetry"),
});
const autoUpdaterLifecycleModule = createAutoUpdaterModule({
  autoUpdater,
  dispatcher,
  configService,
  stateService,
  stateMigrations,
  notificationManager,
});
// State module — loads state.json and drains the migration registry in
// app:start/init. Constructed after the modules that contribute migrations.
const stateModule = createStateModule({
  stateService,
  migrations: stateMigrations,
  logger: loggingService.createLogger("state"),
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
const powerModule = createPowerModule({
  appLayer,
  logger: loggingService.createLogger("power"),
});
const deletionDialogModule = createDeletionDialogModule({
  dialogManager,
  dispatcher,
  logger: apiLogger,
});
const creationModule = createCreationModule({
  dialogManager,
  dispatcher,
  appBoundary: appLayer,
  agentConfig,
  getAvailableAgents,
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
  legacyStateFilePath: pathProvider.dataPath("auto-workspaces.json").toString(),
  dispatcher,
  sources: [githubSource, youtrackSource],
  configService,
  stateService,
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

const errorReportModule = createErrorReportModule({
  dialogManager,
  fileSystem: fileSystemLayer,
  loggingService,
  dispatcher,
  boundary: postHogBoundary,
  configService,
  stateService,
  telemetryEnabled: telemetryEnabledConfig,
  dialogBoundary: dialogLayer,
  viewLayer,
  viewManager,
  logger: loggingService.createLogger("error-report"),
});

// 8. Operation registration

dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());
dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation(agentConfig));
dispatcher.registerOperation(INTENT_APP_READY, new AppReadyOperation(agentConfig));
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
dispatcher.registerOperation(INTENT_AGENT_LIFECYCLE, new AgentLifecycleOperation());
dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
dispatcher.registerOperation(INTENT_LIST_PROJECTS, new ListProjectsOperation());
dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
dispatcher.registerOperation(INTENT_GET_PROJECT_BASES, new GetProjectBasesOperation());
dispatcher.registerOperation(INTENT_GET_LAUNCH_OPTIONS, new AgentLaunchOptionsOperation());

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

// Initial terminal focus for a workspace, fired exactly once per session
// per workspace (tracked in firstFocused). After the first focus, the
// in-frame focus tracker (installed by view-manager via the boundary's
// installChildFrameScript) preserves wherever the user left off (search
// input, editor, terminal, file explorer, etc.) across subsequent switches.
//
// Triggers:
//   1. agent:status-updated → "idle" for the active workspace (most common
//      path: agent boots, becomes idle while its workspace is on screen).
//   2. workspace:switched to a workspace not yet initially-focused, when
//      its current status is idle (covers auto-switch after delete and
//      switch-to-already-idle-workspace cases).
//
// Dispatches workbench.action.terminal.focus via sidekick, then refreshes
// OS window focus and the in-window focus chain so keystrokes reach xterm.
const firstFocused = new Set<string>();

const focusTerminal = (workspacePath: string): void => {
  void dispatcher
    .dispatch({
      type: INTENT_VSCODE_COMMAND,
      payload: {
        workspacePath,
        command: "workbench.action.terminal.focus",
      },
    })
    .then(() => {
      firstFocused.add(workspacePath);
      viewManager.focus();
    })
    .catch(() => {
      /* sidekick not connected yet; will retry on next trigger */
    });
};

dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
  const payload = (event as AgentStatusUpdatedEvent).payload;
  if (firstFocused.has(payload.workspace.path)) return;
  if (payload.status.status !== "idle") return;
  if (!payload.workspace.active) return;
  focusTerminal(payload.workspace.path);
});

dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
  const payload = (event as WorkspaceSwitchedEvent).payload;
  if (!payload) return;
  const path = payload.path;
  if (firstFocused.has(path)) return;
  void dispatcher
    .dispatch({
      type: INTENT_GET_WORKSPACE_STATUS,
      payload: { workspacePath: path },
    } as GetWorkspaceStatusIntent)
    .then((status) => {
      if (status.agent.type === "idle") focusTerminal(path);
    })
    .catch(() => {
      /* status query failed; agent-idle event will handle it later */
    });
});

// Create UI IPC module (handles all bidirectional IPC between main and renderer)
const uiIpcModule = createUiIpcModule({
  ipcLayer,
  viewManager,
  logger: apiLogger,
  dispatcher,
  dialogManager,
  notificationManager,
});

// Create presentation module (owns the api:ui:event + api:ui:state channels;
// Phases A+B of the UI-state architecture — event intake, renderer log
// routing, shadow UiState snapshots)
const presentationModule = createPresentationModule({
  ipcLayer,
  loggingService,
  viewManager,
  windowManager,
  fileSystem: fileSystemLayer,
  pathProvider,
  dialogManager,
  dispatcher,
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
dispatcher.registerModule(powerModule);
dispatcher.registerModule(deletionDialogModule);
dispatcher.registerModule(creationModule);
dispatcher.registerModule(workspaceSelectionModule);
dispatcher.registerModule(metadataModule);
dispatcher.registerModule(keepFilesModule);
dispatcher.registerModule(deleteWindowsLockModule);
dispatcher.registerModule(posixProcessCleanupModule);
dispatcher.registerModule(remoteProjectModule);
dispatcher.registerModule(localProjectModule);
dispatcher.registerModule(gitWorktreeWorkspaceModule);
dispatcher.registerModule(windowTitleModule);
dispatcher.registerModule(stateModule);
dispatcher.registerModule(telemetryModule);
dispatcher.registerModule(autoUpdaterLifecycleModule);
dispatcher.registerModule(mcpModule);
dispatcher.registerModule(electronLifecycleModule);
dispatcher.registerModule(loggingModule);
dispatcher.registerModule(scriptModule);
dispatcher.registerModule(tempDirModule);
dispatcher.registerModule(shortcutModule);
dispatcher.registerModule(devtoolsModule);
dispatcher.registerModule(themeModule);
dispatcher.registerModule(debugModule);
dispatcher.registerModule(errorReportModule);
dispatcher.registerModule(autoWorkspaceModule);
dispatcher.registerModule(cloneNotificationModule);
dispatcher.registerModule(errorNotificationModule);
dispatcher.registerModule(hibernationScreenshotModule);
dispatcher.registerModule(uiIpcModule);
dispatcher.registerModule(presentationModule);

// Load config (sync — reads config.json, env vars, CLI args)
try {
  configService.load();
} catch (error) {
  if (error instanceof PersistedValidationError) {
    appLogger.error("Config validation failed", { key: error.detail.key }, error);
    process.stderr.write(`\nConfiguration error:\n${error.message}\n\n`);
    process.stderr.write(configService.getHelpText());
    process.exit(1);
  }
  throw error;
}

// Handle --help
if (helpConfig.get()) {
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
