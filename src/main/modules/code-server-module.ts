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
import type { IWorkspaceFileService } from "../../services/vscode-workspace/types";
import type { PluginServer } from "../../services/plugin-server/plugin-server";
import type { Logger } from "../../services/logging/types";
import type { CheckDepsResult, StartHookResult } from "../operations/app-start";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import type { FinalizeHookInput, FinalizeHookResult } from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { urlForWorkspace, urlForFolder } from "../../services/code-server/code-server-manager";
import { Path } from "../../services/platform/path";
import { SetupError, getErrorMessage } from "../../services/errors";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies resolved when lifecycle hooks execute (after startServices).
 */
export interface CodeServerLifecycleDeps {
  readonly pluginServer: PluginServer | null;
  readonly codeServerManager: Pick<
    CodeServerManager,
    "ensureRunning" | "port" | "getConfig" | "setPluginPort" | "stop"
  >;
  readonly fileSystemLayer: Pick<FileSystemLayer, "mkdir">;
  readonly onPortChanged: (port: number) => void;
}

/**
 * Dependencies resolved when per-workspace hooks execute (after startServices).
 */
export interface CodeServerWorkspaceDeps {
  readonly workspaceFileService: IWorkspaceFileService;
  readonly wrapperPath: string;
}

/**
 * All dependencies for CodeServerModule.
 *
 * Split into eager (available at creation) and lazy (resolved at hook execution).
 */
export interface CodeServerModuleDeps {
  // Eager: available at creation time
  readonly codeServerManager: Pick<CodeServerManager, "preflight" | "downloadBinary">;
  readonly extensionManager: Pick<ExtensionManager, "preflight" | "install" | "cleanOutdated">;
  readonly logger: Logger;

  // Lazy: resolved when lifecycle hooks execute (after startServices)
  readonly getLifecycleDeps: () => CodeServerLifecycleDeps;

  // Lazy: resolved when per-workspace hooks execute (after startServices)
  readonly getWorkspaceDeps: () => CodeServerWorkspaceDeps;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a CodeServerModule that manages code-server lifecycle, extensions,
 * and per-workspace .code-workspace files.
 */
export function createCodeServerModule(deps: CodeServerModuleDeps): IntentModule {
  const { codeServerManager, extensionManager, logger } = deps;

  // Internal state: port set by start hook, read by finalize hook
  let codeServerPort = 0;

  return {
    hooks: {
      // -------------------------------------------------------------------
      // app-start → check-deps: preflight code-server binary + extensions
      // -------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            const missingBinaries: import("../../services/vscode-setup/types").BinaryType[] = [];

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
            const lifecycle = deps.getLifecycleDeps();

            // Start PluginServer BEFORE code-server (graceful degradation)
            let pluginPort: number | undefined;
            if (lifecycle.pluginServer) {
              try {
                pluginPort = await lifecycle.pluginServer.start();
                logger.info("PluginServer started", { port: pluginPort });

                // Pass pluginPort to CodeServerManager so extensions can connect
                lifecycle.codeServerManager.setPluginPort(pluginPort);
              } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                logger.warn("PluginServer start failed", { error: message });
                pluginPort = undefined;
              }
            }

            // Ensure required directories exist
            const config = lifecycle.codeServerManager.getConfig();
            await Promise.all([
              lifecycle.fileSystemLayer.mkdir(config.runtimeDir),
              lifecycle.fileSystemLayer.mkdir(config.extensionsDir),
              lifecycle.fileSystemLayer.mkdir(config.userDataDir),
            ]);

            // Start code-server
            await lifecycle.codeServerManager.ensureRunning();
            const port = lifecycle.codeServerManager.port()!;

            // Update internal port and notify
            codeServerPort = port;
            lifecycle.onPortChanged(port);

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
            try {
              const lifecycle = deps.getLifecycleDeps();

              // Stop code-server
              await lifecycle.codeServerManager.stop();

              // Close PluginServer AFTER code-server (extensions disconnect first)
              if (lifecycle.pluginServer) {
                await lifecycle.pluginServer.close();
              }
            } catch (error) {
              logger.error(
                "CodeServer lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
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
            const workspace = deps.getWorkspaceDeps();

            // Push config to PluginServer so connecting extensions get env vars + agent type
            const lifecycle = deps.getLifecycleDeps();
            if (lifecycle.pluginServer && finalizeCtx.agentType) {
              lifecycle.pluginServer.setWorkspaceConfig(
                finalizeCtx.workspacePath,
                finalizeCtx.envVars,
                finalizeCtx.agentType
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
                "claudeCode.claudeProcessWrapper": workspace.wrapperPath,
                "claudeCode.environmentVariables": envVarsArray,
              };
              const workspaceFilePath = await workspace.workspaceFileService.ensureWorkspaceFile(
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
            const workspace = deps.getWorkspaceDeps();

            // Clean up PluginServer config for this workspace
            const lifecycle = deps.getLifecycleDeps();
            if (lifecycle.pluginServer) {
              lifecycle.pluginServer.removeWorkspaceConfig(wsPath);
            }

            try {
              const workspacePath = new Path(wsPath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await workspace.workspaceFileService.deleteWorkspaceFile(
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
  };
}
