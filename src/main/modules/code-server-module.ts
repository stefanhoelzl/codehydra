/**
 * CodeServerModule - Manages code-server lifecycle, extensions, and per-workspace files.
 *
 * Consolidates seven inline bootstrap modules into a single extracted module:
 * - Binary preflight (code-server part)
 * - Extension preflight
 * - Binary download (code-server part)
 * - Extension install
 * - Code-server lifecycle (start/stop + PluginServer)
 * - Per-workspace file creation (finalize hook)
 * - Per-workspace file deletion (delete hook)
 *
 * Internal state: code-server port set by `start` hook, read by `finalize` hook.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { CodeServerManager } from "../../services/code-server/code-server-manager";
import type { ExtensionManager } from "../../services/vscode-setup/extension-manager";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { PathProvider } from "../../services/platform/path-provider";
import type { IWorkspaceFileService } from "../../services/vscode-workspace/types";
import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server/plugin-server";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Logger } from "../../services/logging/types";
import type { Workspace } from "../../shared/api/types";
import type {
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  PluginResult,
} from "../../shared/plugin-protocol";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { SupportedPlatform, SupportedArch } from "../../agents/types";
import type { DownloadRequest } from "../../services/binary-download";
import type { BinaryType } from "../../services/vscode-setup/types";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type {
  CheckDepsResult,
  ConfigureResult,
  StartHookResult,
  RegisterConfigResult,
} from "../operations/app-start";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import type {
  FinalizeHookInput,
  FinalizeHookResult,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../operations/delete-workspace";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import type { GetAgentSessionIntent } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import type { RestartAgentIntent } from "../operations/restart-agent";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import type { GetMetadataIntent } from "../operations/get-metadata";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import { urlForWorkspace, urlForFolder } from "../../services/code-server/code-server-manager";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrlForVersion,
  getCodeServerExecutablePath,
} from "../../services/code-server/setup-info";
import { Path } from "../../services/platform/path";
import { SetupError, getErrorMessage } from "../../services/errors";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * All dependencies for CodeServerModule.
 */
export interface CodeServerModuleDeps {
  readonly codeServerManager: Pick<
    CodeServerManager,
    | "preflight"
    | "downloadBinary"
    | "ensureRunning"
    | "port"
    | "getConfig"
    | "setPluginPort"
    | "setCodeServerVersion"
    | "stop"
  >;
  readonly extensionManager: Pick<
    ExtensionManager,
    "preflight" | "install" | "cleanOutdated" | "setCodeServerBinaryPath"
  >;
  readonly pluginServer: Pick<
    PluginServer,
    "start" | "close" | "setWorkspaceConfig" | "removeWorkspaceConfig" | "onApiCall" | "sendCommand"
  > | null;
  readonly dispatcher: Dispatcher;
  readonly fileSystemLayer: Pick<FileSystemLayer, "mkdir">;
  readonly workspaceFileService: IWorkspaceFileService;
  readonly pathProvider: Pick<PathProvider, "bundlePath">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly wrapperPath: string;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a CodeServerModule that manages code-server lifecycle, extensions,
 * and per-workspace .code-workspace files.
 */
export function createCodeServerModule(deps: CodeServerModuleDeps): IntentModule {
  const { codeServerManager, extensionManager, pluginServer, dispatcher, fileSystemLayer, logger } =
    deps;

  // Internal state: port set by start hook, read by finalize hook
  let codeServerPort = 0;

  return {
    name: "code-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        // -------------------------------------------------------------------
        // app-start → register-config: declare version.code-server key
        // -------------------------------------------------------------------
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "version.code-server",
                default: null,
                parse: (s: string) => (s === "" ? null : s),
                validate: (v: unknown) => (v === null || typeof v === "string" ? v : undefined),
              },
            ],
          }),
        },

        // -------------------------------------------------------------------
        // app-start → before-ready: declare required scripts
        // -------------------------------------------------------------------
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            return { scripts: ["code", "code.cmd"] };
          },
        },

        // -------------------------------------------------------------------
        // app-start → check-deps: preflight code-server binary + extensions
        // -------------------------------------------------------------------
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            const missingBinaries: BinaryType[] = [];

            // Check code-server binary
            const codeServerResult = await codeServerManager.preflight();
            if (codeServerResult.success && codeServerResult.needsDownload) {
              missingBinaries.push("code-server");
            }

            // Check extensions
            const extResult = await extensionManager.preflight();
            if (extResult.success) {
              return {
                missingBinaries,
                missingExtensions: extResult.missingExtensions,
                outdatedExtensions: extResult.outdatedExtensions,
              };
            }

            // Extension preflight failed -- return binaries only
            return { missingBinaries };
          },
        },

        // -------------------------------------------------------------------
        // app-start → start: start PluginServer + code-server, update port
        // -------------------------------------------------------------------
        start: {
          handler: async (): Promise<StartHookResult> => {
            // Start PluginServer BEFORE code-server (graceful degradation)
            let pluginPort: number | undefined;
            if (pluginServer) {
              try {
                pluginPort = await pluginServer.start();

                // Pass pluginPort to CodeServerManager so extensions can connect
                codeServerManager.setPluginPort(pluginPort);

                // Register plugin API handlers (dispatch intents directly)
                pluginServer.onApiCall(createPluginApiHandlers(pluginServer, dispatcher, logger));
                logger.info("Plugin API handlers registered");
              } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                logger.warn("PluginServer start failed", { error: message });
              }
            }

            // Ensure required directories exist
            const config = codeServerManager.getConfig();
            await Promise.all([
              fileSystemLayer.mkdir(config.runtimeDir),
              fileSystemLayer.mkdir(config.extensionsDir),
              fileSystemLayer.mkdir(config.userDataDir),
            ]);

            // Start code-server
            await codeServerManager.ensureRunning();
            const port = codeServerManager.port()!;

            // Update internal port (consumed by finalize hook for workspace URLs)
            codeServerPort = port;

            return { codeServerPort: port };
          },
        },
      },

      // -------------------------------------------------------------------
      // app-shutdown → stop: stop code-server + PluginServer
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            // Stop code-server
            await codeServerManager.stop();

            // Close PluginServer AFTER code-server (extensions disconnect first)
            if (pluginServer) {
              await pluginServer.close();
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // setup → binary: download code-server if missing
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        binary: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];
            const { report } = hookCtx;

            if (missingBinaries.includes("code-server")) {
              report("vscode", "running", "Downloading...");
              try {
                await codeServerManager.downloadBinary((p) => {
                  if (p.phase === "downloading" && p.totalBytes) {
                    const pct = Math.floor((p.bytesDownloaded / p.totalBytes) * 100);
                    report("vscode", "running", "Downloading...", undefined, pct);
                  } else if (p.phase === "extracting") {
                    report("vscode", "running", "Extracting...");
                  }
                });
                report("vscode", "done");
              } catch (error) {
                report("vscode", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to download code-server: ${getErrorMessage(error)}`,
                  "BINARY_DOWNLOAD_FAILED"
                );
              }
            } else {
              report("vscode", "done");
            }
          },
        },

        // -------------------------------------------------------------------
        // setup → extensions: install missing/outdated extensions
        // -------------------------------------------------------------------
        extensions: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as ExtensionsHookInput;
            const missingExtensions = hookCtx.missingExtensions ?? [];
            const outdatedExtensions = hookCtx.outdatedExtensions ?? [];
            const { report } = hookCtx;

            const extensionsToInstall = [...missingExtensions, ...outdatedExtensions];
            if (extensionsToInstall.length === 0) {
              report("setup", "done");
              return;
            }

            report("setup", "running", "Installing extensions...");

            // Clean outdated extensions before reinstalling
            if (outdatedExtensions.length > 0) {
              try {
                await extensionManager.cleanOutdated(outdatedExtensions);
              } catch (error) {
                report("setup", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to clean outdated extensions: ${getErrorMessage(error)}`,
                  "EXTENSION_INSTALL_FAILED"
                );
              }
            }

            // Install extensions
            try {
              await extensionManager.install(extensionsToInstall, (message) => {
                report("setup", "running", message);
              });
              report("setup", "done");
            } catch (error) {
              report("setup", "failed", undefined, getErrorMessage(error));
              throw new SetupError(
                `Failed to install extensions: ${getErrorMessage(error)}`,
                "EXTENSION_INSTALL_FAILED"
              );
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // open-workspace → finalize: create .code-workspace file, return URL
      // -------------------------------------------------------------------
      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<FinalizeHookResult> => {
            const finalizeCtx = ctx as FinalizeHookInput;

            // Push config to PluginServer so connecting extensions get env vars + agent type
            if (pluginServer && finalizeCtx.agentType) {
              const intent = ctx.intent as OpenWorkspaceIntent;
              const resetWorkspace = intent.payload.existingWorkspace === undefined;
              pluginServer.setWorkspaceConfig(
                finalizeCtx.workspacePath,
                finalizeCtx.envVars,
                finalizeCtx.agentType,
                resetWorkspace
              );
            }

            try {
              const workspacePathObj = new Path(finalizeCtx.workspacePath);
              const projectWorkspacesDir = workspacePathObj.dirname;
              const envVarsArray = Object.entries(finalizeCtx.envVars).map(([name, value]) => ({
                name,
                value,
              }));
              const agentSettings: Record<string, unknown> = {
                "claudeCode.useTerminal": true,
                "claudeCode.claudeProcessWrapper": deps.wrapperPath,
                "claudeCode.environmentVariables": envVarsArray,
              };
              const workspaceFilePath = await deps.workspaceFileService.ensureWorkspaceFile(
                workspacePathObj,
                projectWorkspacesDir,
                agentSettings
              );
              return {
                workspaceUrl: urlForWorkspace(codeServerPort, workspaceFilePath.toString()),
              };
            } catch (error) {
              logger.warn("Failed to ensure workspace file, using folder URL", {
                workspacePath: finalizeCtx.workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                workspaceUrl: urlForFolder(codeServerPort, finalizeCtx.workspacePath),
              };
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace → delete: delete .code-workspace file
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            // Clean up PluginServer config for this workspace
            if (pluginServer) {
              pluginServer.removeWorkspaceConfig(wsPath);
            }

            try {
              const workspacePath = new Path(wsPath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await deps.workspaceFileService.deleteWorkspaceFile(
                workspaceName,
                projectWorkspacesDir
              );
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {};
              }
              throw error;
            }
          },
        },
      },
    },
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        if (values["version.code-server"] !== undefined) {
          const version = (values["version.code-server"] as string | null) ?? CODE_SERVER_VERSION;
          const codeServerDir = deps.pathProvider.bundlePath(`code-server/${version}`);
          const execPath = getCodeServerExecutablePath(deps.platform);
          const binaryPath = new Path(codeServerDir, execPath).toNative();
          const downloadRequest: DownloadRequest = {
            name: "code-server",
            url: getCodeServerUrlForVersion(version, deps.platform, deps.arch),
            destDir: codeServerDir.toNative(),
            executablePath: execPath,
          };
          codeServerManager.setCodeServerVersion(
            binaryPath,
            codeServerDir.toNative(),
            downloadRequest
          );
          extensionManager.setCodeServerBinaryPath(binaryPath);
        }
      },
    },
  };
}

// =============================================================================
// Plugin API Handlers
// =============================================================================

/**
 * Wrap a dispatcher call with error handling, returning a PluginResult.
 */
async function handlePluginApiCall<T>(
  workspacePath: string,
  operation: string,
  fn: () => Promise<T>,
  logger: Logger,
  logContext?: Record<string, unknown>
): Promise<PluginResult<T>> {
  try {
    const result = await fn();
    logger.debug(`${operation} success`, { workspace: workspacePath, ...logContext });
    return { success: true, data: result };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`${operation} error`, {
      workspace: workspacePath,
      error: message,
      ...logContext,
    });
    return { success: false, error: message };
  }
}

/**
 * Create plugin API handlers that dispatch intents directly.
 */
function createPluginApiHandlers(
  pluginServer: Pick<PluginServer, "sendCommand">,
  dispatcher: Dispatcher,
  logger: Logger
): ApiCallHandlers {
  return {
    async getStatus(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getStatus",
        async () => {
          const intent: GetWorkspaceStatusIntent = {
            type: INTENT_GET_WORKSPACE_STATUS,
            payload: { workspacePath },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Get workspace status dispatch returned no result");
          }
          return result;
        },
        logger
      );
    },

    async getAgentSession(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getAgentSession",
        async () => {
          const intent: GetAgentSessionIntent = {
            type: INTENT_GET_AGENT_SESSION,
            payload: { workspacePath },
          };
          return dispatcher.dispatch(intent);
        },
        logger
      );
    },

    async restartAgentServer(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "restartAgentServer",
        async () => {
          const intent: RestartAgentIntent = {
            type: INTENT_RESTART_AGENT,
            payload: { workspacePath },
          };
          const result = await dispatcher.dispatch(intent);
          if (result === undefined) {
            throw new Error("Restart agent dispatch returned no result");
          }
          return result;
        },
        logger
      );
    },

    async getMetadata(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getMetadata",
        async () => {
          const intent: GetMetadataIntent = {
            type: INTENT_GET_METADATA,
            payload: { workspacePath },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Get metadata dispatch returned no result");
          }
          return result as Record<string, string>;
        },
        logger
      );
    },

    async setMetadata(workspacePath: string, request: SetMetadataRequest) {
      return handlePluginApiCall(
        workspacePath,
        "setMetadata",
        async () => {
          const intent: SetMetadataIntent = {
            type: INTENT_SET_METADATA,
            payload: {
              workspacePath,
              key: request.key,
              value: request.value,
            },
          };
          await dispatcher.dispatch(intent);
          return undefined;
        },
        logger,
        { key: request.key }
      );
    },

    async delete(workspacePath: string, request: DeleteWorkspaceRequest) {
      return handlePluginApiCall(
        workspacePath,
        "delete",
        async () => {
          const intent: DeleteWorkspaceIntent = {
            type: INTENT_DELETE_WORKSPACE,
            payload: {
              workspacePath,
              keepBranch: request.keepBranch ?? true,
              force: false,
              removeWorktree: true,
            },
          };
          const handle = dispatcher.dispatch(intent);
          if (!(await handle.accepted)) {
            return { started: false };
          }
          void handle;
          return { started: true };
        },
        logger,
        { keepBranch: request.keepBranch ?? true }
      );
    },

    async executeCommand(workspacePath: string, request: ExecuteCommandRequest) {
      return handlePluginApiCall(
        workspacePath,
        "executeCommand",
        async () => {
          const result = await pluginServer.sendCommand(
            workspacePath,
            request.command,
            request.args
          );
          if (!result.success) {
            throw new Error(result.error);
          }
          return result.data;
        },
        logger,
        { command: request.command }
      );
    },

    async create(workspacePath: string, request: WorkspaceCreateRequest) {
      return handlePluginApiCall(
        workspacePath,
        "create",
        async () => {
          const intent: OpenWorkspaceIntent = {
            type: INTENT_OPEN_WORKSPACE,
            payload: {
              callerWorkspacePath: workspacePath,
              workspaceName: request.name,
              base: request.base,
              ...(request.initialPrompt !== undefined && {
                initialPrompt: request.initialPrompt,
              }),
              ...(request.stealFocus !== undefined && {
                stealFocus: request.stealFocus,
              }),
            },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Create workspace dispatch returned no result");
          }
          return result as Workspace;
        },
        logger,
        { name: request.name }
      );
    },
  };
}
