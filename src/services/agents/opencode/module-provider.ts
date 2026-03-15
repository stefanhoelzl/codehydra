/**
 * OpenCode agent module provider implementation.
 *
 * Implements the AgentModuleProvider interface by wrapping OpenCodeServerManager
 * and OpenCodeProvider. Absorbs all closure state and helper functions that were
 * previously in opencode-agent-module.ts into a reusable provider that the
 * generic module factory can delegate to.
 */

import type {
  AgentModuleProvider,
  WorkspaceStartOptions,
  WorkspaceStartResult,
} from "../agent-module-provider";
import type {
  AgentProvider,
  AgentStatus,
  McpConfig,
  StopServerResult,
  RestartServerResult,
} from "../types";
import type { AgentSessionInfo } from "../types";
import type { AggregatedAgentStatus, WorkspacePath } from "../../../shared/ipc";
import type { AgentBinaryManager, DownloadProgressCallback } from "../../binary-download";
import type { BinaryType } from "../../binary-resolution/types";
import type { ConfigKeyDefinition } from "../../config/config-definition";
import type { Logger } from "../../logging";
import type { Unsubscribe } from "../../../shared/api/interfaces";
import type { OpenCodeServerManager, PendingPrompt } from "./server-manager";
import { configString } from "../../config/config-definition";
import { OpenCodeProvider } from "./provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for the OpenCode module provider.
 */
export interface OpenCodeModuleProviderDeps {
  readonly serverManager: OpenCodeServerManager;
  readonly binaryManager: AgentBinaryManager;
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
  const { serverManager, binaryManager, logger } = deps;

  // ===========================================================================
  // Internal closure state
  // ===========================================================================

  /** Tracks pending handleServerStarted() promises for waitForProvider(). */
  const serverStartedPromises = new Map<string, Promise<void>>();

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: Unsubscribe | null = null;
  let serverStoppedCleanupFn: Unsubscribe | null = null;

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

  /** Status change subscribers. */
  const statusChangeListeners = new Set<
    (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void
  >();

  /** Whether server callbacks have been wired. */
  let callbacksWired = false;

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

  function getProviderStatus(provider: AgentProvider): AgentStatus {
    if (provider instanceof OpenCodeProvider) {
      const counts = provider.getEffectiveCounts();
      if (counts.idle === 0 && counts.busy === 0) return "none";
      if (counts.busy > 0) return "busy";
      return "idle";
    }
    return "none";
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
      for (const listener of statusChangeListeners) {
        listener(path, status);
      }
    }
  }

  function addProvider(path: WorkspacePath, provider: AgentProvider): void {
    if (providers.has(path)) return;

    provider.onStatusChange((status) => handleStatusUpdate(path, status));

    if (tuiAttachedWorkspaces.has(path)) {
      provider.markActive();
    }

    providers.set(path, provider);
    handleStatusUpdate(path, getProviderStatus(provider));
  }

  function removeProvider(path: WorkspacePath): void {
    const provider = providers.get(path);
    if (provider) {
      provider.dispose();
      providers.delete(path);
      statusCache.delete(path);
      for (const listener of statusChangeListeners) {
        listener(path, createNoneStatus());
      }
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
      handleStatusUpdate(path, getProviderStatus(provider));
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
  // Internal functions
  // ===========================================================================

  async function waitForProvider(workspacePath: string): Promise<void> {
    const promise = serverStartedPromises.get(workspacePath);
    if (promise) {
      await promise;
    }
  }

  async function handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    try {
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspacePath)) {
        try {
          await reconnectProvider(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: "opencode",
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: "opencode" },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create OpenCode-specific provider directly
      const provider = new OpenCodeProvider(workspacePath, logger, undefined);

      try {
        await provider.connect(port);
        await provider.fetchStatus();

        // Set bridge port so getEnvironmentVariables() includes it
        const bridgePort = serverManager.getBridgePort();
        if (bridgePort !== null) {
          provider.setBridgePort(bridgePort);
        }

        addProvider(workspacePath, provider);

        // Send initial prompt if provided
        if (pendingPrompt) {
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
        }
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: "opencode" },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      serverStartedPromises.delete(workspacePath);
    }
  }

  function wireServerCallbacks(): void {
    if (callbacksWired) return;
    callbacksWired = true;

    serverManager.setMarkActiveHandler((wp) => markProviderActive(wp as WorkspacePath));

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port, pendingPrompt) => {
      const promise = handleServerStarted(
        workspacePath as WorkspacePath,
        port,
        pendingPrompt as PendingPrompt | undefined
      );
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
    type: "opencode",
    configKey: "version.opencode",
    displayName: "OpenCode",
    icon: "terminal",
    serverName: "OpenCode",
    scripts: ["ch-opencode", "ch-opencode.cjs", "ch-opencode.cmd"],

    // --- Binary ---
    binaryType: binaryManager.getBinaryType() as BinaryType,

    async preflight(): Promise<{ success: boolean; needsDownload: boolean }> {
      const result = await binaryManager.preflight();
      if (result.success) {
        return { success: true, needsDownload: result.needsDownload };
      }
      return { success: false, needsDownload: false };
    },

    async downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
      await binaryManager.downloadBinary(onProgress);
    },

    // --- Config ---
    getConfigDefinition(): ConfigKeyDefinition<string | null> {
      return {
        name: "version.opencode",
        default: null,
        description: "OpenCode agent version override",
        ...configString({ nullable: true }),
      };
    },

    // --- Lifecycle ---
    initialize(mcpConfig: McpConfig | null): void {
      wireServerCallbacks();
      if (mcpConfig !== null) {
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
      callbacksWired = false;

      await serverManager.dispose();

      for (const provider of providers.values()) {
        provider.dispose();
      }
      providers.clear();
      statusCache.clear();
      tuiAttachedWorkspaces.clear();
      statusChangeListeners.clear();
    },

    // --- Per-workspace ---
    async startWorkspace(
      workspacePath: string,
      options?: WorkspaceStartOptions
    ): Promise<WorkspaceStartResult> {
      // Start with initial prompt options for OpenCode
      if (options?.initialPrompt) {
        await serverManager.startServer(workspacePath, {
          initialPrompt: options.initialPrompt,
        });
      } else {
        await serverManager.startServer(workspacePath);
      }

      await waitForProvider(workspacePath);

      const envVars: Record<string, string> = {
        ...(providers.get(workspacePath as WorkspacePath)?.getEnvironmentVariables() ?? {}),
      };

      return { envVars };
    },

    async stopWorkspace(workspacePath: string): Promise<StopServerResult> {
      return serverManager.stopServer(workspacePath);
    },

    async restartWorkspace(workspacePath: string): Promise<RestartServerResult> {
      return serverManager.restartServer(workspacePath);
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
      statusChangeListeners.add(callback);
      return () => statusChangeListeners.delete(callback);
    },

    // --- Cleanup ---
    clearWorkspaceTracking(workspacePath: WorkspacePath): void {
      tuiAttachedWorkspaces.delete(workspacePath);
    },
  };
}
