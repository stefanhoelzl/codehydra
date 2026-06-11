/**
 * OpenCode agent module provider implementation.
 *
 * Defines the OpenCode-specific AgentModuleSpec consumed by the generic
 * createAgentModuleProvider() core: provider construction (+ initial status
 * fetch), pending-prompt delivery after registration, and TUI-attached
 * tracking that survives provider recreation across server restarts. All
 * provider-tracking machinery lives in the core.
 */

import type { AgentModuleProvider } from "../agent-module-provider";
import type { WorkspacePath } from "../../../shared/ipc";
import { Path } from "../../../utils/path/path";
import type { ArchiveExtension, DownloadDeps } from "../../../utils/binary-download";
import type { PersistedAccessor } from "../../../boundaries/platform/store-definition";
import type { Logger } from "../../../boundaries/platform/logging";
import type { OpenCodeServerManager, PendingPrompt } from "./server-manager";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { SupportedPlatform, SupportedArch } from "../../../boundaries/platform/platform-info";
import { getOpencodeBundleDir, getOpencodeUrlForVersion } from "./setup-info";
import { OpenCodeProvider } from "./provider";
import { countsToStatus } from "../status-utils";
import { createAgentModuleProvider } from "../module-provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for the OpenCode module provider.
 */
export interface OpenCodeModuleProviderDeps {
  readonly serverManager: OpenCodeServerManager;
  readonly downloadDeps: DownloadDeps;
  readonly binaryConfig: {
    readonly name: string;
    readonly executablePath: string;
    readonly archiveExtension: ArchiveExtension;
  };
  readonly versionConfig: PersistedAccessor<string>;
  readonly pathProvider: Pick<PathProvider, "bundlePath">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenCode AgentModuleProvider that manages per-workspace server
 * lifecycle, provider instances, and status tracking.
 */
export function createOpenCodeModuleProvider(
  deps: OpenCodeModuleProviderDeps
): AgentModuleProvider {
  const {
    serverManager,
    downloadDeps,
    binaryConfig,
    versionConfig,
    pathProvider,
    platform,
    arch,
    logger,
  } = deps;

  /**
   * Track workspaces that have had TUI attached.
   * Persists across provider recreations (e.g., server restart) so we can
   * restore the attached state without waiting for a new MCP request.
   */
  const tuiAttachedWorkspaces = new Set<WorkspacePath>();

  return createAgentModuleProvider<OpenCodeProvider>(
    {
      // --- Identity ---
      type: "opencode",
      configKey: "version.opencode",
      displayName: "OpenCode",
      icon: "terminal",
      serverName: "OpenCode",
      scripts: ["ch-opencode", "ch-opencode.cjs", "ch-opencode.cmd"],

      serverManager,

      // --- Binary ---
      resolveBinary() {
        const version = versionConfig.get();
        const destDir = getOpencodeBundleDir(pathProvider, version).toNative();
        return {
          destDir,
          request: () => ({
            name: binaryConfig.name,
            url: getOpencodeUrlForVersion(version, platform, arch),
            destDir,
            archiveExtension: binaryConfig.archiveExtension,
            executablePath: binaryConfig.executablePath,
          }),
        };
      },

      // --- Provider lifecycle ---
      createProvider: (workspacePath) => new OpenCodeProvider(workspacePath, logger),

      connectProvider: async (provider, port) => {
        await provider.connect(port);
        await provider.fetchStatus();
      },

      initialStatus: (provider) => countsToStatus(provider.getEffectiveCounts()),

      onProviderAdded: (path, provider) => {
        if (tuiAttachedWorkspaces.has(path)) {
          provider.markActive();
        }
      },

      // Send the initial prompt (if any) once the provider is registered.
      onProviderRegistered: async (workspacePath, provider, extra) => {
        const pendingPrompt = extra as PendingPrompt | undefined;
        if (!pendingPrompt) return;

        const sessionResult = await provider.createSession();
        if (sessionResult.ok) {
          const promptResult = await provider.sendPrompt(
            sessionResult.value.id,
            pendingPrompt.prompt,
            {
              ...(pendingPrompt.agent !== undefined && { agent: pendingPrompt.agent }),
              ...(pendingPrompt.model !== undefined && { model: pendingPrompt.model }),
            }
          );
          if (!promptResult.ok) {
            logger.error("Failed to send initial prompt", {
              workspacePath,
              error: promptResult.error.message,
            });
          }
        } else {
          logger.error("Failed to create session for initial prompt", {
            workspacePath,
            error: sessionResult.error.message,
          });
        }
      },

      // --- Workspace start ---
      startServer: async (workspacePath, options) => {
        if (options?.initialPrompt) {
          await serverManager.startServer(workspacePath, {
            initialPrompt: options.initialPrompt,
          });
        } else {
          await serverManager.startServer(workspacePath);
        }
      },

      // --- Terminal lifecycle + TUI tracking ---
      wireExtraCallbacks: (ctx) => {
        serverManager.setMarkActiveHandler((wp) => {
          const path = wp as WorkspacePath;
          tuiAttachedWorkspaces.add(path);
          ctx.getProvider(path)?.markActive();
        });
      },

      applyTerminalLifecycle: (workspacePath, event, ctx) => {
        if (event === "open") {
          // Clears the loading screen (workspace-ready) and marks active (TUI attached),
          // mirroring the old WrapperStart bridge route.
          serverManager.triggerWrapperStart(workspacePath);
        } else {
          const path = new Path(workspacePath).toString() as WorkspacePath;
          tuiAttachedWorkspaces.delete(path);
          ctx.getProvider(path)?.detachTui();
        }
      },

      clearWorkspaceTracking: (path) => {
        tuiAttachedWorkspaces.delete(path);
      },

      onDispose: () => {
        tuiAttachedWorkspaces.clear();
      },
    },
    { logger, downloadDeps, binaryName: binaryConfig.name }
  );
}
