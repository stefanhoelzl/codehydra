/**
 * Claude Module Provider - AgentModuleProvider implementation for Claude Code.
 *
 * Wraps ClaudeCodeServerManager and ClaudeCodeProvider to implement the
 * unified AgentModuleProvider interface. Absorbs all per-workspace provider
 * management, status tracking, and server lifecycle coordination that was
 * previously scattered across the intent module closure.
 *
 * The generic agent module factory delegates all Claude-specific behavior
 * to this provider, keeping the module itself a thin intent adapter.
 */

import type {
  AgentModuleProvider,
  WorkspaceStartOptions,
  WorkspaceStartResult,
} from "../agent-module-provider";
import type { AgentProvider, AgentSessionInfo, AgentStatus, McpConfig } from "../types";
import type { AgentLifecycleEvent } from "../../../shared/plugin-protocol";
import type { AggregatedAgentStatus, WorkspacePath } from "../../../shared/ipc";
import type {
  ArchiveExtension,
  DownloadDeps,
  DownloadProgressCallback,
  DownloadRequest,
} from "../../../utils/binary-download";
import { downloadBinary, isBinaryInstalled } from "../../../utils/binary-download";
import type { BinaryType } from "../../../utils/binary-resolution/types";
import { AgentBinaryError, getErrorMessage } from "../../../shared/errors/service-errors";
import type { PersistedAccessor } from "../../../boundaries/platform/store-definition";
import type { StopServerResult, RestartServerResult } from "../types";
import type { Logger } from "../../../boundaries/platform/logging";
import type { ClaudeCodeServerManager } from "./server-manager";
import { ClaudeCodeProvider } from "./provider";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { SupportedPlatform, SupportedArch } from "../../../boundaries/platform/platform-info";
import { getClaudeUrlForVersion, getClaudeSubPath } from "./setup-info";

// =============================================================================
// Dependency Interface
// =============================================================================

/**
 * Dependencies for creating a Claude module provider.
 */
export interface ClaudeModuleProviderDeps {
  readonly serverManager: ClaudeCodeServerManager;
  readonly downloadDeps: DownloadDeps;
  readonly binaryConfig: {
    readonly name: string;
    readonly executablePath: string;
    readonly archiveExtension: ArchiveExtension;
  };
  readonly versionConfig: PersistedAccessor<string | null>;
  readonly pathProvider: Pick<PathProvider, "bundlePath">;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an AgentModuleProvider for Claude Code.
 *
 * Uses factory function pattern (not a class) to keep state in a closure,
 * consistent with the existing module pattern.
 */
export function createClaudeModuleProvider(deps: ClaudeModuleProviderDeps): AgentModuleProvider {
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

  // ===========================================================================
  // Internal closure state
  // ===========================================================================

  /** Per-workspace provider instances. */
  const providers = new Map<WorkspacePath, AgentProvider>();

  /** Cached aggregated status per workspace (for deduplication and queries). */
  const statusCache = new Map<WorkspacePath, AggregatedAgentStatus>();

  /**
   * Track workspaces that have had TUI attached.
   * Persists across provider recreations (e.g., server restart) so we can
   * restore the attached state without waiting for a new MCP request.
   */
  const tuiAttachedWorkspaces = new Set<WorkspacePath>();

  /** Tracks pending handleServerStarted() promises for waitForProvider(). */
  const serverStartedPromises = new Map<string, Promise<void>>();

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: (() => void) | null = null;
  let serverStoppedCleanupFn: (() => void) | null = null;

  /** Registered status change callbacks. */
  const statusChangeCallbacks: Array<
    (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void
  > = [];

  // ===========================================================================
  // Provider management helpers
  // ===========================================================================

  function createNoneStatus(): AggregatedAgentStatus {
    return { status: "none", counts: { idle: 0, busy: 0 } };
  }

  function convertToAggregatedStatus(status: AgentStatus): AggregatedAgentStatus {
    switch (status) {
      case "none":
        return { status: "none", counts: { idle: 0, busy: 0 } };
      case "idle":
        return { status: "idle", counts: { idle: 1, busy: 0 } };
      case "busy":
        return { status: "busy", counts: { idle: 0, busy: 1 } };
    }
  }

  function notifyStatusChange(path: WorkspacePath, status: AggregatedAgentStatus): void {
    for (const callback of statusChangeCallbacks) {
      callback(path, status);
    }
  }

  function handleStatusUpdate(path: WorkspacePath, agentStatus: AgentStatus): void {
    const status = convertToAggregatedStatus(agentStatus);
    const previous = statusCache.get(path);
    const hasChanged =
      !previous ||
      previous.status !== status.status ||
      previous.counts.idle !== status.counts.idle ||
      previous.counts.busy !== status.counts.busy;

    if (hasChanged) {
      statusCache.set(path, status);
      notifyStatusChange(path, status);
    }
  }

  function addProvider(path: WorkspacePath, provider: AgentProvider): void {
    if (providers.has(path)) return;

    provider.onStatusChange((status) => handleStatusUpdate(path, status));

    if (tuiAttachedWorkspaces.has(path)) {
      provider.markActive();
    }

    providers.set(path, provider);
    // ClaudeCodeProvider: initial status is "none" (status comes via onStatusChange from ServerManager)
    handleStatusUpdate(path, "none");
  }

  function removeProvider(path: WorkspacePath): void {
    const provider = providers.get(path);
    if (provider) {
      provider.dispose();
      providers.delete(path);
      statusCache.delete(path);
      notifyStatusChange(path, createNoneStatus());
    }
  }

  function disconnectProvider(path: WorkspacePath): void {
    const provider = providers.get(path);
    if (provider) {
      provider.disconnect();
    }
  }

  async function reconnectProvider(path: WorkspacePath): Promise<void> {
    const provider = providers.get(path);
    if (provider) {
      await provider.reconnect();
      // ClaudeCodeProvider: status comes via onStatusChange, initial reconnect status is "none"
      handleStatusUpdate(path, "none");
    }
  }

  function markProviderActive(path: WorkspacePath): void {
    tuiAttachedWorkspaces.add(path);
    const provider = providers.get(path);
    if (provider) {
      provider.markActive();
    }
  }

  // ===========================================================================
  // Server callback wiring
  // ===========================================================================

  async function handleServerStarted(workspacePath: WorkspacePath, port: number): Promise<void> {
    try {
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspacePath)) {
        try {
          await reconnectProvider(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: "claude",
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: "claude" },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create Claude-specific provider directly
      const provider = new ClaudeCodeProvider({
        serverManager,
        workspacePath,
        logger,
      });

      try {
        await provider.connect(port);
        addProvider(workspacePath, provider);
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: "claude" },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      serverStartedPromises.delete(workspacePath);
    }
  }

  function wireServerCallbacks(): void {
    serverManager.setMarkActiveHandler((wp) => markProviderActive(wp as WorkspacePath));

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port);
      serverStartedPromises.set(workspacePath, promise);
    });

    serverStoppedCleanupFn = serverManager.onServerStopped((workspacePath, isRestart) => {
      if (isRestart) {
        disconnectProvider(workspacePath as WorkspacePath);
      } else {
        removeProvider(workspacePath as WorkspacePath);
      }
    });
  }

  // ===========================================================================
  // AgentModuleProvider implementation
  // ===========================================================================

  return {
    // --- Identity ---

    type: "claude",
    configKey: "version.claude",
    displayName: "Claude Code",
    icon: "sparkle",
    serverName: "Claude Code hook",
    scripts: [
      "ch-claude",
      "ch-claude.cjs",
      "ch-claude.cmd",
      "claude-code-hook-handler.cjs",
    ] as const,

    // --- Binary ---

    get binaryType(): BinaryType {
      return binaryConfig.name as BinaryType;
    },

    async preflight(): Promise<{ success: boolean; needsDownload: boolean }> {
      const version = versionConfig.get();
      if (version === null) {
        return { success: true, needsDownload: false };
      }
      try {
        const destDir = pathProvider.bundlePath(`claude/${version}`).toNative();
        const installed = await isBinaryInstalled(destDir, downloadDeps);
        return { success: true, needsDownload: !installed };
      } catch {
        return { success: false, needsDownload: false };
      }
    },

    async downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
      const version = versionConfig.get();
      if (version === null) return;
      const destDir = pathProvider.bundlePath(`claude/${version}`).toNative();
      const request: DownloadRequest = {
        name: binaryConfig.name,
        url: getClaudeUrlForVersion(version, platform, arch),
        destDir,
        archiveExtension: binaryConfig.archiveExtension,
        executablePath: binaryConfig.executablePath,
        subPath: getClaudeSubPath(platform, arch),
      };
      try {
        await downloadBinary(request, downloadDeps, onProgress);
      } catch (error) {
        throw new AgentBinaryError(
          `Failed to download ${binaryConfig.name}: ${getErrorMessage(error)}`
        );
      }
    },

    // --- Lifecycle ---

    initialize(mcpConfig: McpConfig | null): void {
      wireServerCallbacks();
      if (mcpConfig) {
        serverManager.setMcpConfig(mcpConfig);
      }
    },

    async dispose(): Promise<void> {
      if (serverStartedCleanupFn) {
        serverStartedCleanupFn();
        serverStartedCleanupFn = null;
      }
      if (serverStoppedCleanupFn) {
        serverStoppedCleanupFn();
        serverStoppedCleanupFn = null;
      }

      await serverManager.dispose();

      for (const provider of providers.values()) {
        provider.dispose();
      }
      providers.clear();
      statusCache.clear();
      tuiAttachedWorkspaces.clear();
    },

    // --- Per-workspace ---

    async startWorkspace(
      workspacePath: string,
      options?: WorkspaceStartOptions
    ): Promise<WorkspaceStartResult> {
      await serverManager.startServer(workspacePath);

      // Wait for the handleServerStarted callback to complete
      const promise = serverStartedPromises.get(workspacePath);
      if (promise) {
        await promise;
      }

      if (options?.initialPrompt && serverManager.setInitialPrompt) {
        await serverManager.setInitialPrompt(workspacePath, options.initialPrompt);
      }

      if (options?.isNewWorkspace && serverManager.setNoSessionMarker) {
        await serverManager.setNoSessionMarker(workspacePath);
      }

      return {
        envVars: providers.get(workspacePath as WorkspacePath)?.getEnvironmentVariables() ?? {},
      };
    },

    async stopWorkspace(workspacePath: string): Promise<StopServerResult> {
      return serverManager.stopServer(workspacePath);
    },

    async restartWorkspace(workspacePath: string): Promise<RestartServerResult> {
      return serverManager.restartServer(workspacePath);
    },

    applyTerminalLifecycle(workspacePath: string, event: AgentLifecycleEvent): void {
      serverManager.triggerWrapperLifecycle(
        workspacePath,
        event === "open" ? "WrapperStart" : "WrapperEnd"
      );
    },

    // --- Query ---

    getStatus(workspacePath: WorkspacePath): AggregatedAgentStatus {
      return statusCache.get(workspacePath) ?? createNoneStatus();
    },

    getSession(workspacePath: WorkspacePath): AgentSessionInfo | null {
      return providers.get(workspacePath)?.getSession() ?? null;
    },

    // --- Events ---

    onStatusChange(
      callback: (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void
    ): () => void {
      statusChangeCallbacks.push(callback);
      return () => {
        const index = statusChangeCallbacks.indexOf(callback);
        if (index >= 0) {
          statusChangeCallbacks.splice(index, 1);
        }
      };
    },

    // --- Cleanup ---

    clearWorkspaceTracking(workspacePath: WorkspacePath): void {
      tuiAttachedWorkspaces.delete(workspacePath);
    },
  };
}
