/**
 * CodeServerModule - Manages code-server lifecycle, extensions, and per-workspace files.
 *
 * Consolidates these concerns into a single extracted module:
 * - Binary preflight (code-server part)
 * - Extension preflight
 * - Binary download (code-server part)
 * - Extension install
 * - Code-server lifecycle (start/stop)
 * - Per-workspace file creation (finalize hook)
 * - Per-workspace file deletion (delete hook)
 *
 * Internal state: code-server port set by `start` hook, read by `finalize` hook.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { CodeServerManager } from "../../services/code-server/code-server-manager";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { ProcessRunner } from "../../services/platform/process";
import type { PathProvider } from "../../services/platform/path-provider";
import type { IWorkspaceFileService } from "../../services/vscode-workspace/types";
import type { Logger } from "../../services/logging/types";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { SupportedPlatform, SupportedArch } from "../../agents/types";
import type { DownloadRequest } from "../../services/binary-download";
import type { BinaryType } from "../../services/vscode-setup/types";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  StartHookResult,
  RegisterConfigResult,
} from "../operations/app-start";
import type { BinaryHookInput, ExtensionsHookInput } from "../operations/setup";
import type { FinalizeHookInput, FinalizeHookResult } from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { urlForWorkspace, urlForFolder } from "../../services/code-server/code-server-manager";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrlForVersion,
  getCodeServerSubPathForVersion,
  getCodeServerExecutablePath,
} from "../../services/code-server/setup-info";
import {
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "../../services/vscode-setup/extension-utils";
import { Path } from "../../services/platform/path";
import { configString, configCustom } from "../../services/config/config-definition";
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
    | "setCodeServerVersion"
    | "setPort"
    | "stop"
  >;
  readonly processRunner: Pick<ProcessRunner, "run">;
  readonly fileSystemLayer: Pick<
    FileSystemLayer,
    "mkdir" | "readdir" | "rm" | "readFile" | "writeFile"
  >;
  readonly workspaceFileService: IWorkspaceFileService;
  readonly pathProvider: Pick<PathProvider, "bundlePath" | "dataPath">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly codeServerBinaryPath: string;
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
  const { codeServerManager, processRunner, fileSystemLayer, logger } = deps;

  // Internal state: port set by start hook, read by finalize hook
  let codeServerPort = 0;
  // Binary path tracked in closure — updated by config:updated events
  let codeServerBinaryPath = deps.codeServerBinaryPath;

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
                description: "Code-server version override (null = built-in)",
                ...configString({ nullable: true }),
              },
              {
                name: "code-server.port",
                default: codeServerManager.getConfig().port,
                description: "Code-server port",
                ...configCustom<number>({
                  parse: (raw) => {
                    const n = Number(raw);
                    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : undefined;
                  },
                  validate: (v) =>
                    typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535
                      ? v
                      : undefined,
                  validValues: "1024-65535",
                }),
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
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { extensionRequirements } = ctx as CheckDepsHookContext;
            const missingBinaries: BinaryType[] = [];

            // Check code-server binary
            const codeServerResult = await codeServerManager.preflight();
            if (codeServerResult.success && codeServerResult.needsDownload) {
              missingBinaries.push("code-server");
            }

            // Compare requirements against installed extensions
            if (extensionRequirements.length === 0) {
              return { missingBinaries };
            }

            try {
              const extensionsDir = deps.pathProvider.dataPath("vscode/extensions");
              const installed = await listInstalledExtensions(fileSystemLayer, extensionsDir);
              const extensionInstallPlan = extensionRequirements
                .filter((req) => {
                  const installedVersion = installed.get(req.id);
                  return !installedVersion || installedVersion !== req.version;
                })
                .map((req) => ({ id: req.id, vsixPath: req.vsixPath }));

              logger.debug("Extension check completed", {
                installPlanCount: extensionInstallPlan.length,
              });

              return { missingBinaries, extensionInstallPlan };
            } catch (error) {
              logger.warn("Extension check failed", { error: getErrorMessage(error) });
              return { missingBinaries };
            }
          },
        },

        // -------------------------------------------------------------------
        // app-start → start: start code-server, update port
        // -------------------------------------------------------------------
        start: {
          handler: async (): Promise<StartHookResult> => {
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
      // app-shutdown → stop: stop code-server
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await codeServerManager.stop();
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
        // setup → extensions: install extensions from install plan
        // -------------------------------------------------------------------
        extensions: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as ExtensionsHookInput;
            const installPlan = hookCtx.extensionInstallPlan ?? [];
            const { report } = hookCtx;

            if (installPlan.length === 0) {
              report("setup", "done");
              return;
            }

            report("setup", "running", "Installing extensions...");

            const extensionsDir = deps.pathProvider.dataPath("vscode/extensions");

            try {
              // Scan installed to find old dirs to remove
              const installed = await listInstalledExtensions(fileSystemLayer, extensionsDir);

              for (const entry of installPlan) {
                report("setup", "running", `Installing ${entry.id}...`);

                // Remove old directory if present
                const oldVersion = installed.get(entry.id);
                if (oldVersion) {
                  const oldDirName = `${entry.id}-${oldVersion}`;
                  const oldPath = new Path(extensionsDir, oldDirName);
                  logger.debug("Cleaning extension", { extId: entry.id, path: oldPath.toString() });
                  await fileSystemLayer.rm(oldPath, { recursive: true, force: true });
                }

                // Clean stale entry from extensions.json
                await removeFromExtensionsJson(fileSystemLayer, extensionsDir, [entry.id]);

                // Install via code-server
                const proc = processRunner.run(codeServerBinaryPath, [
                  "--install-extension",
                  entry.vsixPath,
                  "--extensions-dir",
                  extensionsDir.toNative(),
                ]);
                const result = await proc.wait();
                if (result.exitCode !== 0) {
                  throw new Error(
                    result.stderr.includes("ENOENT") || result.stderr.includes("spawn")
                      ? `Failed to run code-server: ${result.stderr || "Binary not found"}`
                      : `Failed to install extension: ${entry.id}`
                  );
                }
                logger.info("Extension installed", { extId: entry.id });
              }
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
        if (values["code-server.port"] !== undefined) {
          codeServerManager.setPort(values["code-server.port"] as number);
        }
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
            subPath: getCodeServerSubPathForVersion(version, deps.platform, deps.arch),
          };
          codeServerManager.setCodeServerVersion(
            binaryPath,
            codeServerDir.toNative(),
            downloadRequest
          );
          codeServerBinaryPath = binaryPath;
        }
      },
    },
  };
}
