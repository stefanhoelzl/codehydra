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
import {
  DefaultPathProvider,
  legacyWindowsDataRoot,
  windowsDataRoot,
  type PathProvider,
} from "./boundaries/platform/path-provider";
import {
  relocateDataRoot,
  type DataRootRelocation,
} from "./boundaries/platform/data-root-relocation";
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
  storeNumber,
  storeString,
  PersistedValidationError,
} from "./boundaries/platform/store-definition";
// Boundaries - Shell
import { DefaultAppBoundary } from "./boundaries/shell/app";
import { DefaultOsNotificationBoundary } from "./boundaries/shell/os-notification";
import { DefaultImageBoundary } from "./boundaries/shell/image";
import { DefaultDialogBoundary } from "./boundaries/shell/dialog";
import { DefaultMenuBoundary } from "./boundaries/shell/menu";
import { DefaultWindowBoundary } from "./boundaries/shell/window";
import { DefaultViewBoundary } from "./boundaries/shell/view";
import { DefaultSessionBoundary } from "./boundaries/shell/session";
import { WindowManager } from "./boundaries/shell/window-manager";
import { UiViewManager, GLOBAL_SESSION_PARTITION } from "./boundaries/shell/ui-view-manager";
// Services (stayed)
import { AutoUpdater } from "./modules/auto-updater";
import { downloadBinaries } from "./modules/download-binaries";
import { DefaultArchiveExtractor } from "./boundaries/platform/archive-extractor";
import type { DownloadDeps } from "./utils/binary-download";
import { createOpencodeBinaryDescriptor } from "./modules/agent-module/opencode/setup-info";
import { createClaudeBinaryDescriptor } from "./modules/agent-module/claude/setup-info";
import { createAgentBinaryResolver } from "./modules/agent-module/binary-resolver";
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
import type { AgentInfo } from "./shared/ipc";
import { SetupOperation, INTENT_SETUP, EVENT_SETUP_ERROR } from "./intents/setup";
import { SetMetadataOperation } from "./intents/set-metadata";
import { GetMetadataOperation } from "./intents/get-metadata";
import { GetWorkspaceStatusOperation } from "./intents/get-workspace-status";
import { GetAgentSessionOperation } from "./intents/get-agent-session";
import { RestartAgentOperation } from "./intents/restart-agent";
import { SendAgentMessageOperation } from "./intents/send-agent-message";
import { AgentLifecycleOperation } from "./intents/agent-lifecycle";
import { GetActiveWorkspaceOperation } from "./intents/get-active-workspace";
import { ListProjectsOperation } from "./intents/list-projects";
import { OpenWorkspaceOperation } from "./intents/open-workspace";
import { GetProjectBasesOperation } from "./intents/get-project-bases";
import { AgentLaunchOptionsOperation } from "./intents/agent-launch-options";
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
import { SwitchWorkspaceOperation } from "./intents/switch-workspace";
import { UpdateAgentStatusOperation } from "./intents/update-agent-status";
import { ShortcutKeyOperation } from "./intents/shortcut-key";
import { SetShortcutActiveOperation } from "./intents/set-shortcut-active";
import { SubmitBugReportOperation } from "./intents/submit-bug-report";
import { VscodeShowMessageOperation } from "./intents/vscode-show-message";
import { ShowNotificationOperation } from "./intents/show-notification";
import { CloseNotificationOperation } from "./intents/close-notification";
import { VscodeModalChangedOperation } from "./intents/vscode-modal-changed";
import { VscodeCommandOperation } from "./intents/vscode-command";
import { ResolveWorkspaceOperation } from "./intents/resolve-workspace";
import { ResolveProjectOperation } from "./intents/resolve-project";
// Modules
import { createExtensionModule } from "./modules/extension-module";
import { createViewModule } from "./modules/view-module";
import { createIdeServerModule } from "./modules/ide-server-module/ide-server-module";
import { createApiServerModule } from "./modules/api-server-module";
import { createAgentModule } from "./modules/agent-module/agent-module";
import type { McpConfig } from "./modules/agent-module/types";
import { createMetadataModule } from "./modules/metadata-module";
import { createWorkspaceAgentResolverModule } from "./modules/workspace-agent-resolver-module";
import { createPluginModule } from "./modules/plugin-module/module";
import { createHookOutputSink } from "./modules/plugin-module/output-sink";
import { createWorkspaceLogModule } from "./modules/workspace-log-module";
import { createWindowsFileLockModule } from "./modules/windows-file-lock-module";
import { createPosixProcessCleanupModule } from "./modules/posix-process-cleanup-module";
import { createWindowTitleModule } from "./modules/window-title-module";
import { createTerminalFocusModule } from "./modules/terminal-focus-module";
import { createTelemetryModule } from "./modules/telemetry-module";
import { createPostHogBoundary } from "./boundaries/platform/posthog";
import { createAutoUpdaterModule } from "./modules/auto-updater-module";
import { DefaultStateService } from "./boundaries/platform/state-service";
import { createWorkspacesRootModule } from "./modules/workspaces-root/module";
import { createStateModule } from "./modules/state-module";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createWorkspaceLifecycleModule } from "./modules/workspace-lifecycle-module";
import { createBadgeModule } from "./modules/badge-module";
import { createOsNotificationModule } from "./modules/os-notification-module";
import { createPowerModule } from "./modules/power-module";
import { createFrameWatchdogModule } from "./modules/frame-watchdog-module";
import { createCliModule } from "./modules/cli-module";
import { createRegistry } from "./api/entries";
import { createDeletionWaiter } from "./api/deletion-waiter";
import { createElectronLifecycleModule } from "./modules/electron-lifecycle-module";
import { createLoggingModule } from "./modules/logging-module";
import { createScriptModule } from "./modules/script-module";
import { createTempDirModule } from "./modules/temp-dir-module";
import { createCleanupModule } from "./modules/cleanup-module";
import { createErrorReportModule } from "./modules/error-report-module";
import { createShortcutModule } from "./modules/shortcut-module";
import { createDevtoolsModule } from "./modules/devtools-module";
import { createDebugModule } from "./modules/debug-module";
import { createPresentationModule } from "./modules/presentation/presentation-module";
import { createSettingsModule } from "./modules/settings-module";
import { createHelpModule } from "./modules/help-module";
import { createCloneNotificationModule } from "./modules/clone-notification-module";
import { createErrorNotificationModule } from "./modules/error-notification-module";
import { createDeletionDialogModule } from "./modules/deletion-dialog-module";
import { createCreationModule } from "./modules/creation-module";
import { createWorkspaceSelectionModule } from "./modules/workspace-selection-module";
import { createAutoTaggingModule } from "./modules/auto-tagging-module";
import { createLockModule } from "./modules/lock-module";
// Shared
import { getErrorMessage } from "./shared/error-utils";
import { clearInheritedEnv } from "./utils/inherited-env";

// Async watcher — detect unexpected I/O before app.whenReady()
const asyncWatcher = new AsyncWatcher(["PROMISE", "TickObject", "RANDOMBYTESREQUEST"]);
asyncWatcher.enable();

// 2. Core initializations (buildInfo, platformInfo, pathProvider, logging)

// First, before anything reads the environment or spawns a child: drop what a
// launching CodeHydra left behind, or this instance's children would reach that
// one. Nothing imported above reads a `_CH_*` variable at module load.
const inheritedEnv = clearInheritedEnv(process.env);

const buildInfo: BuildInfo = new ElectronBuildInfo();

const platformInfo = new NodePlatformInfo();
// Windows releases keep their data in %LOCALAPPDATA% since they stopped using the
// roaming profile. Move an existing install's data before anything opens it; when
// that fails (an older instance still running), this run stays in the old folder.
const legacyDataRoot =
  platformInfo.platform === "win32" && !buildInfo.isDevelopment && !process.env._CHDEV_ROOT_DIR
    ? legacyWindowsDataRoot(platformInfo.homeDir)
    : null;
const dataRootRelocation: DataRootRelocation =
  legacyDataRoot === null
    ? { status: "nothing" }
    : relocateDataRoot(legacyDataRoot, windowsDataRoot(platformInfo.homeDir));
const pathProvider: PathProvider = new DefaultPathProvider(
  buildInfo,
  platformInfo,
  dataRootRelocation.status === "failed" ? { platformRoot: dataRootRelocation.from } : {}
);
const loggingService: Logging = new ElectronLog(pathProvider);
const appLogger = loggingService.createLogger("app");
if (inheritedEnv.length > 0) {
  appLogger.info("Cleared variables inherited from a launching CodeHydra", {
    names: inheritedEnv.join(","),
  });
}
if (dataRootRelocation.status === "moved") {
  appLogger.info("Moved the data folder", {
    from: dataRootRelocation.from,
    to: dataRootRelocation.to,
    sourceCodeKept: dataRootRelocation.sourceCodeKept,
  });
  for (const warning of dataRootRelocation.warnings) appLogger.warn(warning);
} else if (dataRootRelocation.status === "failed") {
  appLogger.warn("Could not move the data folder; using the old one until the next start", {
    from: dataRootRelocation.from,
    to: dataRootRelocation.to,
    error: dataRootRelocation.error,
  });
}
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const fileSystemLayer = new DefaultFileSystemBoundary(loggingService.createLogger("fs"));

// Config — constructed before modules so they can register keys
const configService = new DefaultConfig({
  configPath: pathProvider.homePath("config.json"),
  legacyConfigPath: pathProvider.dataPath("config.json"),
  fileSystem: fileSystemLayer,
  logger: loggingService.createLogger("config"),
  isDevelopment: buildInfo.isDevelopment,
  isPackaged: buildInfo.isPackaged,
  env: process.env as Record<string, string | undefined>,
  argv: process.argv,
});

// State — app-written persisted state (state.json), sibling of config. Loaded
// asynchronously by the state module in app:start/init.
const stateService = new DefaultStateService({
  statePath: pathProvider.dataPath("state.json"),
  fileSystem: fileSystemLayer,
  logger: loggingService.createLogger("state"),
});

// Register core config keys (not owned by any single module). Their accessors
// are threaded into the modules/intents that read or write them, so those
// consumers never reach into the config service by string key.
const agentConfig = configService.register("agent", {
  default: "claude",
  description: "Agent selection",
  applies: "restart",
  ...storeEnum(["claude", "opencode"]),
});
// telemetry.enabled is read by two modules (telemetry-module gates passive
// events; error-report-module gates crash reporting), so it is registered here
// and its accessor is threaded into both.
const telemetryEnabledConfig = configService.register("telemetry.enabled", {
  default: true,
  description: "Enable telemetry (false in dev/unpackaged)",
  applies: "live",
  ...storeBoolean(),
  computedDefault: (ctx) => (ctx.isDevelopment || !ctx.isPackaged ? false : undefined),
});
const helpConfig = configService.register("help", {
  default: false,
  description: "Print config help and exit",
  ...storeBoolean(),
});
// Agent version keys. Registered here (composition root) rather than inside the
// agent module so the accessors exist before the server managers and providers
// that read them are constructed (those are built below, before the modules).
// null = the system install, else the latest download. Set = that version (or
// channel), downloaded even when the agent is installed on the system.
const claudeVersionConfig = configService.register("version.claude", {
  default: null,
  description:
    "Claude agent version: null = system install, else latest stable; x.y.z | latest | stable",
  ...storeString({ nullable: true }),
});
const opencodeVersionConfig = configService.register("version.opencode", {
  default: null,
  description: "OpenCode agent version: null = system install, else latest; x.y.z | latest",
  ...storeString({ nullable: true }),
});
const downloadBinariesConfig = configService.register("download-binaries", {
  default: false,
  description: "Download the IDE server and both agents' binaries, then exit",
  ...storeBoolean(),
});
// Expanded-sidebar width (px). Written by the renderer's drag-to-resize gesture
// and also user-editable here. The [250, 100000] bounds enforce the grow-only
// floor at the config layer: an out-of-range hand-edited value fails load with
// a help message (like ide-server.port), rather than being silently coerced.
const sidebarWidthConfig = configService.register("sidebar.width", {
  default: 250,
  description: "Expanded sidebar width in pixels (drag its right edge to resize; min 250)",
  applies: "live",
  ...storeNumber({ min: 250, max: 100000 }),
});

// Run the handlers of one hook point (and of one domain event) concurrently
// rather than one at a time. Read by the dispatcher once per hook point, so a
// change applies from the next one.
const concurrentHooksConfig = configService.register("experimental.concurrent-hooks", {
  default: false,
  description: "Run a hook point's ready handlers concurrently instead of one at a time",
  applies: "live",
  ...storeBoolean(),
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
const notificationLogger = loggingService.createLogger("notification");
const osNotificationLayer = new DefaultOsNotificationBoundary(notificationLogger);

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

// Which executable each agent runs: system install or a download (binary-resolver.ts)
const binaryResolverLogger = loggingService.createLogger("binary-download");
const agentBinaryResolvers = {
  claude: createAgentBinaryResolver({
    descriptor: createClaudeBinaryDescriptor(platform, arch),
    version: claudeVersionConfig,
    pathProvider,
    fileSystem: fileSystemLayer,
    processRunner,
    downloadDeps,
    env: process.env,
    platform,
    logger: binaryResolverLogger,
  }),
  opencode: createAgentBinaryResolver({
    descriptor: createOpencodeBinaryDescriptor(platform, arch),
    version: opencodeVersionConfig,
    pathProvider,
    fileSystem: fileSystemLayer,
    processRunner,
    downloadDeps,
    env: process.env,
    platform,
    logger: binaryResolverLogger,
  }),
};

const dispatcher = new Dispatcher({
  logger: loggingService.createLogger("dispatcher"),
  logScope: loggingService.scope,
  concurrentHooks: () => concurrentHooksConfig.get(),
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
  loggingService.createLogger("worktree"),
  // A workspace migrated from git config without a recorded agent has been
  // running the default: pin it, as the agent resolver does on open.
  () => {
    const agent = agentConfig.get();
    return agent === "claude" || agent === "opencode" ? { agent } : {};
  }
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
    localSocketClient: networkLayer,
    pathProvider: serverManagerDeps.pathProvider,
    fileSystem: serverManagerDeps.fileSystem,
    logger: serverManagerDeps.logger,
  }),
  opencode: new OpenCodeServerManager(
    serverManagerDeps.processRunner,
    serverManagerDeps.portManager,
    serverManagerDeps.httpClient,
    serverManagerDeps.pathProvider,
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
// Preload for the UI page, hosted directly by the window's webContents.
const uiPreloadPath = nodePath.join(__dirname, "../preload/index.cjs");

const viewManager = new UiViewManager({
  windowManager,
  windowLayer,
  viewLayer,
  sessionLayer,
  appLayer,
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
      const { workspaceRef } = p as DeleteWorkspacePayload;
      return workspaceRef;
    },
    resetOn: [EVENT_WORKSPACE_DELETED, EVENT_WORKSPACE_DELETE_FAILED],
    isForced: (intent) => (intent as DeleteWorkspaceIntent).payload.force,
  },
  {
    intentType: INTENT_HIBERNATE_WORKSPACE,
    getKey: (p) => (p as HibernateWorkspacePayload).workspaceRef,
    resetOn: [EVENT_WORKSPACE_HIBERNATED, EVENT_WORKSPACE_HIBERNATE_FAILED],
  },
  {
    intentType: INTENT_WAKE_WORKSPACE,
    getKey: (p) => (p as WakeWorkspacePayload).workspaceRef,
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
    // A second open of the same project (`ch ws create --project <path>` while
    // app:ready opens it at startup) waits for the first rather than failing,
    // then finds it open.
    wait: true,
  },
  {
    // An interactive close parks on its confirm dialog; the guard keeps a
    // second close gesture from opening a second dialog meanwhile.
    intentType: INTENT_CLOSE_PROJECT,
    getKey: (p) => (p as CloseProjectPayload).projectRef,
    resetOn: [EVENT_PROJECT_CLOSED, EVENT_PROJECT_CLOSE_FAILED],
  },
]);

const uiHtmlPath = `file://${nodePath.join(__dirname, "../renderer/index.html")}`;

// The UI presenter owns the whole ui:state snapshot and both directions of the
// UI-view IPC. It privately owns the dialog/notification registries and exposes
// .dialog()/.notification() for any module to inject. Constructed early so the
// consumer modules below can take it as `ui`.
// Forwards the sidebar gear's open-settings ui event to the settings module,
// and the question mark's open-help to the help module. Assigned once those
// modules are constructed below (they need the presenter for their dialogs),
// so the presenter closes over mutable refs.
let openSettings: () => void = () => {};
let openHelp: () => void = () => {};
const presentationModule = createPresentationModule({
  loggingService,
  viewManager,
  windowManager,
  fileSystem: fileSystemLayer,
  pathProvider,
  dispatcher,
  sidebarWidthConfig,
  configService,
  stateService,
  onOpenSettings: () => openSettings(),
  onOpenHelp: () => openHelp(),
});
const settingsModule = createSettingsModule({
  ui: presentationModule,
  config: configService,
  app: appLayer,
  dialog: dialogLayer,
  // Built further down; read only when the dialog opens.
  extras: () => [workspacesRootModule.settingsRow],
  logger: loggingService.createLogger("settings"),
});
openSettings = settingsModule.openSettings;
const helpModule = createHelpModule({
  ui: presentationModule,
  fileSystem: fileSystemLayer,
  pathProvider,
  logger: loggingService.createLogger("help"),
});
openHelp = helpModule.openHelp;
const cloneNotificationModule = createCloneNotificationModule({ dispatcher });
const errorNotificationModule = createErrorNotificationModule({ dispatcher });

// Owns the transient per-workspace facts contributed to workspace:resolve:
// which teardown holds a workspace (`closing`), and which workspace is active.
const workspaceLifecycleModule = createWorkspaceLifecycleModule();

const viewModule = createViewModule({
  viewManager,
  logger: apiLogger,
  viewLayer,
  windowLayer,
  sessionLayer,
  dialogLayer,
  menuLayer,
  windowManager,
  appLayer,
  uiHtmlPath,
  uiPreloadPath,
});

const ideServerModule = createIdeServerModule({
  processRunner,
  httpClient: networkLayer,
  portManager: networkLayer,
  fileSystemLayer,
  sessionLayer,
  sessionPartition: GLOBAL_SESSION_PARTITION,
  pathProvider,
  buildInfo,
  platform,
  arch,
  logger: apiLogger,
  archiveExtractor,
  configService,
  ui: presentationModule,
});

// The CLI's scripts, token and published connection details. Constructed before
// the API server so its token can be read lazily from the handshake.
const cliModule = createCliModule({
  stateService,
  logger: loggingService.createLogger("cli"),
});

/** Where `ch.cjs` lands once script-module has synced the bin directory. */
const cliBundlePath = pathProvider.dataPath("bin/ch.cjs").toNative();

/**
 * How agents launch CodeHydra's MCP server.
 *
 * `ch mcp` is given everything explicitly at launch — interpreter, bundle, port
 * and token — so it reads no state file and needs nothing on PATH. Null until
 * the API server has bound and published a token, which is the same condition
 * under which no agent should be told to connect.
 */
const resolveMcpConfig = (): McpConfig | null => {
  const port = apiServerModule.port();
  const token = cliModule.token();
  const nodePath = ideServerModule.nodePath();
  if (port === null || token === null) return null;
  return { nodePath, cliPath: cliBundlePath, port, token };
};

/**
 * Every operation the outside world can reach, in one place.
 *
 * The MCP, API server and CLI adapters are generic loops over this; none of them
 * holds per-operation code, so an operation cannot exist on one surface and be
 * missing or behave differently on another.
 */
const deletionWaiter = createDeletionWaiter(dispatcher);

// Built before the registry because the `lock.*` entries reach its table.
const lockModule = createLockModule({
  dispatcher,
  logger: loggingService.createLogger("lock"),
});

const operationRegistry = createRegistry(
  {
    dispatcher,
    appLayer,
    awaitDeletion: (workspaceRef) => deletionWaiter.await(workspaceRef),
    locks: lockModule.locks,
    config: configService,
    readUserGuide: () => helpModule.readUserGuide(),
    plugins: () => pluginModule.api,
  },
  apiLogger
);

const apiServerModule = createApiServerModule({
  portManager: networkLayer,
  dispatcher,
  appLayer,
  logger: apiLogger,
  registry: operationRegistry,
  cliToken: () => cliModule.token(),
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
  binary: agentBinaryResolvers.claude,
  platform,
  logger: providerLogger,
  processRunner,
});
const claudeAgentModule = createAgentModule(claudeProvider, {
  dispatcher,
  logger: apiLogger,
  agentConfig,
  resolveMcpConfig,
});

const opencodeProvider = createOpenCodeModuleProvider({
  serverManager: agentServerManagers.opencode,
  binary: agentBinaryResolvers.opencode,
  logger: providerLogger,
});
const opencodeAgentModule = createAgentModule(opencodeProvider, {
  dispatcher,
  logger: apiLogger,
  agentConfig,
  resolveMcpConfig,
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
// A workspace's own log lines, in its IDE's "CodeHydra Log" output channel.
const workspaceLogModule = createWorkspaceLogModule({
  logging: loggingService,
  transport: apiServerModule,
  logger: loggingService.createLogger("workspace-log"),
});
const pluginModule = createPluginModule({
  fileSystem: fileSystemLayer,
  processRunner,
  logger: loggingService.createLogger("plugins"),
  config: configService,
  stateService,
  dispatcher,
  ui: presentationModule,
  pathProvider,
  // `ch` lives here, so a plugin script can call back into CodeHydra (set a
  // title, tag a workspace) without its author having to locate the binary.
  binDir: pathProvider.dataPath("bin"),
  sink: createHookOutputSink({
    transport: apiServerModule,
    logger: loggingService.createLogger("plugins"),
  }),
  // Built further down; read when app:start migrates.
  projectRefs: () => localProjectModule.projectRefs(),
  workspaceConnected: (listener) => apiServerModule.onWorkspaceConnected(listener),
  registry: () => operationRegistry,
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
});
// State module — loads state.json in app:start/init.
const stateModule = createStateModule({ stateService });
// Where worktrees and managed clones live (`paths.workspaces`); a requested move runs at app:start.
const workspacesRootModule = createWorkspacesRootModule({
  config: configService,
  stateService,
  pathProvider,
  fs: fileSystemLayer,
  gitClient,
  ui: presentationModule,
  dialog: dialogLayer,
  app: appLayer,
  dispatcher,
  logger: loggingService.createLogger("workspaces-root"),
});
const workspacesRoot = workspacesRootModule.root;
const localProjectModule = createLocalProjectModule({
  projectsDir: pathProvider.dataPath("projects").toString(),
  remotesDir: () => workspacesRoot.remotesDir().toString(),
  fs: fileSystemLayer,
  gitWorktreeProvider,
  ui: presentationModule,
  dispatcher,
  gitClient,
  logger: lifecycleLogger,
});
const remoteProjectModule = createRemoteProjectModule({
  fs: fileSystemLayer,
  gitClient,
  workspacesRoot,
  logger: lifecycleLogger,
  dispatcher,
});
const gitWorktreeWorkspaceModule = createGitWorktreeWorkspaceModule(
  gitWorktreeProvider,
  workspacesRoot,
  apiLogger,
  presentationModule,
  dispatcher
);
const badgeModule = createBadgeModule({
  platformInfo,
  appLayer,
  imageLayer,
  windowManager,
  logger: loggingService.createLogger("badge"),
});
const osNotificationModule = createOsNotificationModule({
  osNotificationLayer,
  windowManager,
  dispatcher,
  configService,
  logger: notificationLogger,
});
const powerModule = createPowerModule({
  appLayer,
  logger: loggingService.createLogger("power"),
});
const frameWatchdogModule = createFrameWatchdogModule({
  transport: apiServerModule,
  frames: presentationModule,
  logger: loggingService.createLogger("view"),
});
const deletionDialogModule = createDeletionDialogModule({
  ui: presentationModule,
  dispatcher,
  logger: apiLogger,
});
const creationModule = createCreationModule({
  ui: presentationModule,
  dispatcher,
  appBoundary: appLayer,
  agentConfig,
  getAvailableAgents,
  logger: apiLogger,
});
const workspaceSelectionModule = createWorkspaceSelectionModule();
const autoTaggingModule = createAutoTaggingModule({
  dispatcher,
  configService,
  logger: loggingService.createLogger("auto-tagging"),
});

// 7. New modules

const electronLifecycleModule = createElectronLifecycleModule({
  app,
  appLayer,
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
});

const scriptModule = createScriptModule({
  fileSystem: fileSystemLayer,
  pathProvider,
  logger: appLogger,
  // Read at sync time: the interpreter path follows the configured IDE version,
  // so it is only correct once config has loaded.
  templateVariables: () => ({ ideNode: ideServerModule.nodePath() }),
});

const tempDirModule = createTempDirModule({
  fileSystem: fileSystemLayer,
  pathProvider,
});

// Sweeps of the data root that nothing waits on. Order matters: `claude/configs`
// is retired before the `claude` bundle rule sweeps its parent, so the retired
// directory is never mistaken for a version. The temp root is deliberately absent
// — clearing it is order-critical and stays in tempDirModule, awaited in "init".
const cleanupModule = createCleanupModule({
  fileSystem: fileSystemLayer,
  pathProvider,
  logger: loggingService.createLogger("cleanup"),
  isPackagedBuild: !buildInfo.isDevelopment,
  rules: [
    // Agent hook/MCP configs. They bake in this launch's ports and API token,
    // so they were never data: they now live under the temp root.
    { kind: "retire", path: "claude/configs" },
    // The IDE server we shipped before VSCodium. Nothing has read it since the
    // `code-server.port` -> `ide-server.port` rename.
    { kind: "retire", path: "code-server" },
    // OpenCode's config is passed inline via OPENCODE_CONFIG_CONTENT; this file
    // is what the old on-disk approach left behind.
    { kind: "retire", path: "opencode/opencode.codehydra.json" },
    // One log file per launch, and electron-log only ever rotates the current
    // one, so nothing bounded the directory's growth.
    // Plugin run logs prune themselves per entry (plugin-module/run-log.ts).
    { kind: "keepRecent", path: "logs", keep: 20, exclude: ["plugins"] },
    // Hibernation screenshots are deleted on wake and on workspace delete; the
    // per-project directory is what outlives the project.
    { kind: "pruneEmpty", path: "screenshots" },
    {
      kind: "bundle",
      path: "claude",
      keep: () => claudeProvider.bundleVersionsInUse(),
      packagedOnly: true,
    },
    {
      kind: "bundle",
      path: "opencode",
      keep: () => opencodeProvider.bundleVersionsInUse(),
      packagedOnly: true,
    },
    {
      kind: "bundle",
      path: "vscodium",
      keep: () => [ideServerModule.version()],
      packagedOnly: true,
    },
  ],
});

const shortcutModule = createShortcutModule({
  viewManager,
  windowLayer,
  windowManager,
  ui: presentationModule,
  dispatcher,
  platform: platformInfo.platform,
  logger: loggingService.createLogger("shortcut"),
});

const devtoolsModule = createDevtoolsModule({
  viewManager,
});

const debugModule = createDebugModule({ configService, dispatcher });

const errorReportModule = createErrorReportModule({
  ui: presentationModule,
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

dispatcher.registerOperation(new AppShutdownOperation());
dispatcher.registerOperation(new AppResumeOperation());
dispatcher.registerOperation(
  new AppStartOperation(agentConfig, () => configService.wasConfigured())
);
dispatcher.registerOperation(new AppReadyOperation(agentConfig));
// config:set-values operation removed — config is now a plain service
dispatcher.registerOperation(new ResolveWorkspaceOperation());
dispatcher.registerOperation(new ResolveProjectOperation());
dispatcher.registerOperation(new SetupOperation());
dispatcher.registerOperation(new SetMetadataOperation());
dispatcher.registerOperation(new GetMetadataOperation());
dispatcher.registerOperation(new GetWorkspaceStatusOperation());
dispatcher.registerOperation(new GetAgentSessionOperation());
dispatcher.registerOperation(new RestartAgentOperation());
dispatcher.registerOperation(new SendAgentMessageOperation());
dispatcher.registerOperation(new AgentLifecycleOperation());
dispatcher.registerOperation(new GetActiveWorkspaceOperation());
dispatcher.registerOperation(new ListProjectsOperation());
dispatcher.registerOperation(new OpenWorkspaceOperation());
dispatcher.registerOperation(new GetProjectBasesOperation());
dispatcher.registerOperation(new AgentLaunchOptionsOperation());

dispatcher.registerOperation(new DeleteWorkspaceOperation());
dispatcher.registerOperation(new HibernateWorkspaceOperation());
dispatcher.registerOperation(new WakeWorkspaceOperation());

dispatcher.registerOperation(new OpenProjectOperation());
dispatcher.registerOperation(new CloseProjectOperation());

dispatcher.registerOperation(new SwitchWorkspaceOperation());
dispatcher.registerOperation(new UpdateAgentStatusOperation());
dispatcher.registerOperation(new ShortcutKeyOperation());
dispatcher.registerOperation(new SetShortcutActiveOperation());
dispatcher.registerOperation(new SubmitBugReportOperation());
dispatcher.registerOperation(new VscodeShowMessageOperation());
dispatcher.registerOperation(new ShowNotificationOperation());
dispatcher.registerOperation(new CloseNotificationOperation());
dispatcher.registerOperation(new VscodeModalChangedOperation());
dispatcher.registerOperation(new VscodeCommandOperation());

const terminalFocusModule = createTerminalFocusModule({
  dispatcher,
  isConnected: (workspaceRef) => apiServerModule.isConnected(workspaceRef),
  viewManager,
});

const hibernationScreenshotModule = createHibernationScreenshotModule({
  fileSystem: fileSystemLayer,
  pathProvider,
  viewManager,
  logger: loggingService.createLogger("view"),
});

// 9. Register all modules

dispatcher.registerModule(idempotencyModule);
dispatcher.registerModule(workspaceLifecycleModule);
dispatcher.registerModule(viewModule);
dispatcher.registerModule(apiServerModule.module);
dispatcher.registerModule(extensionModule);
dispatcher.registerModule(ideServerModule.module);
dispatcher.registerModule(workspaceAgentResolverModule);
dispatcher.registerModule(terminalFocusModule);
// A repository's open hooks run at their own hook points ("provision",
// "prepare"), which precede the agents' "setup" — so the tree is set up and its
// environment known before an agent server starts, whatever the order here.
dispatcher.registerModule(pluginModule);
dispatcher.registerModule(workspaceLogModule.module);
dispatcher.registerModule(claudeAgentModule);
dispatcher.registerModule(opencodeAgentModule);
dispatcher.registerModule(badgeModule);
dispatcher.registerModule(osNotificationModule);
dispatcher.registerModule(powerModule);
dispatcher.registerModule(frameWatchdogModule);
dispatcher.registerModule(deletionDialogModule);
dispatcher.registerModule(creationModule);
dispatcher.registerModule(workspaceSelectionModule);
dispatcher.registerModule(metadataModule);
dispatcher.registerModule(deleteWindowsLockModule);
dispatcher.registerModule(posixProcessCleanupModule);
dispatcher.registerModule(remoteProjectModule);
dispatcher.registerModule(localProjectModule);
dispatcher.registerModule(gitWorktreeWorkspaceModule);
dispatcher.registerModule(windowTitleModule);
dispatcher.registerModule(stateModule);
dispatcher.registerModule(workspacesRootModule.module);
dispatcher.registerModule(telemetryModule);
dispatcher.registerModule(autoUpdaterLifecycleModule);
dispatcher.registerModule(electronLifecycleModule);
dispatcher.registerModule(loggingModule);
dispatcher.registerModule(scriptModule);
dispatcher.registerModule(tempDirModule);
dispatcher.registerModule(cleanupModule);
dispatcher.registerModule(shortcutModule);
dispatcher.registerModule(devtoolsModule);
dispatcher.registerModule(debugModule);
dispatcher.registerModule(errorReportModule);
dispatcher.registerModule(settingsModule.module);
dispatcher.registerModule(autoTaggingModule);
dispatcher.registerModule(lockModule);
dispatcher.registerModule(cloneNotificationModule);
dispatcher.registerModule(errorNotificationModule);
dispatcher.registerModule(hibernationScreenshotModule);
dispatcher.registerModule(presentationModule);
dispatcher.registerModule(cliModule.module);

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

// Handle --download-binaries: fetch what a first start could need, then exit
// without starting the app.
if (downloadBinariesConfig.get()) {
  void downloadBinaries({
    steps: [
      { name: "vscodium", run: (onProgress) => ideServerModule.ensureDownloaded(onProgress) },
      { name: "claude", run: (onProgress) => claudeProvider.seedBinary(onProgress) },
      { name: "opencode", run: (onProgress) => opencodeProvider.seedBinary(onProgress) },
    ],
    write: (line) => process.stdout.write(`${line}\n`),
  }).then((exitCode) => app.exit(exitCode));
} else {
  startApp();
}

// 10. Dispatch app:start

function startApp(): void {
  // Dispatch app:start — orchestrates the entire startup flow via hook points
  void dispatcher
    .dispatch<AppStartIntent>(
      {
        type: INTENT_APP_START,
        payload: {},
      },
      { origin: "startup" }
    )
    .catch((error: unknown) => {
      appLogger.error(
        "Startup failed",
        { error: getErrorMessage(error) },
        error instanceof Error ? error : undefined
      );

      // The app:start "error" hook has already captured + flushed a diagnostic
      // report when telemetry is on (see error-report-module). Only tell the user a
      // report was sent when it actually was — with telemetry off nothing left the
      // machine, so we keep the bare message.
      const message = telemetryEnabledConfig.get()
        ? `${getErrorMessage(error)}\n\nA diagnostic report has been sent to the developers.`
        : getErrorMessage(error);
      dialogLayer.showErrorBox("Startup Failed", message);

      app.quit();
    });
}

// 11. App lifecycle handlers: `window-all-closed` and `before-quit` lead into
// app:shutdown from electron-lifecycle-module, which also owns the final quit.
