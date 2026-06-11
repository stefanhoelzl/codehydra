/**
 * Generic agent module provider factory.
 *
 * Owns all provider-tracking machinery shared by the Claude and OpenCode
 * module providers: the per-workspace provider registry, status cache with
 * deduplication, server started/stopped callback wiring, restart-reconnect
 * handling, binary preflight/download scaffolding, and disposal.
 *
 * Per-agent behavior is supplied through an AgentModuleSpec: identity
 * constants, binary resolution, provider construction/connection, the
 * initial status seed, prompt plumbing, and terminal lifecycle routing.
 */

import type {
  AgentModuleProvider,
  WorkspaceStartOptions,
  WorkspaceStartResult,
} from "./agent-module-provider";
import type {
  AgentProvider,
  AgentServerManager,
  AgentSessionInfo,
  AgentStatus,
  McpConfig,
  StopServerResult,
  RestartServerResult,
} from "./types";
import type { AgentType, AgentLifecycleEvent } from "../../shared/plugin-protocol";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import type {
  DownloadDeps,
  DownloadProgressCallback,
  DownloadRequest,
} from "../../utils/binary-download";
import { downloadBinary, isBinaryInstalled } from "../../utils/binary-download";
import type { BinaryType } from "../../utils/binary-resolution/types";
import { AgentBinaryError, getErrorMessage } from "../../shared/errors/service-errors";
import type { Logger } from "../../boundaries/platform/logging";
import { createNoneStatus, convertToAggregatedStatus } from "./status-utils";

// =============================================================================
// Spec Interface
// =============================================================================

/**
 * Access to the core's per-workspace provider registry, handed to spec hooks
 * that need to reach a registered provider (e.g. terminal lifecycle routing).
 */
export interface SpecContext<P extends AgentProvider> {
  getProvider(path: WorkspacePath): P | undefined;
}

/**
 * Per-agent behavior consumed by createAgentModuleProvider().
 *
 * Generic over the concrete provider type so spec hooks can use
 * agent-specific provider methods without casts.
 */
export interface AgentModuleSpec<P extends AgentProvider> {
  // --- Identity ---

  /** Agent type identifier (e.g., "claude", "opencode") */
  readonly type: AgentType;

  /** Config key used for version overrides (e.g., "version.claude") */
  readonly configKey: string;

  /** Human-readable display name (e.g., "Claude Code") */
  readonly displayName: string;

  /** Icon name for UI display */
  readonly icon: string;

  /** MCP server name registered by this agent */
  readonly serverName: string;

  /** Script filenames to copy into workspaces */
  readonly scripts: readonly string[];

  // --- Binary ---

  /**
   * Resolve the binary install location and (lazily) the download request.
   * Returns null when there is nothing to download (e.g. Claude with no
   * version override uses the bundled binary).
   */
  resolveBinary(): { destDir: string; request: () => DownloadRequest } | null;

  // --- Server manager ---

  /** The agent's server manager (common subset used by the core). */
  readonly serverManager: Pick<
    AgentServerManager,
    | "stopServer"
    | "restartServer"
    | "onServerStarted"
    | "onServerStopped"
    | "setMcpConfig"
    | "dispose"
  >;

  // --- Provider lifecycle ---

  /** Construct the per-workspace provider (not yet connected). */
  createProvider(workspacePath: WorkspacePath): P;

  /** Connect the provider to the server (plus any initial fetch). */
  connectProvider(provider: P, port: number): Promise<void>;

  /** Status seed used on registration and after reconnect. */
  initialStatus(provider: P): AgentStatus;

  /**
   * Called after the provider is registered on first start. `extra` is the
   * third argument of the server manager's onServerStarted callback
   * (e.g. OpenCode's pending prompt), untyped at this boundary.
   */
  onProviderRegistered?(path: WorkspacePath, provider: P, extra: unknown): Promise<void>;

  // --- Workspace start ---

  /** Start the agent server for a workspace. */
  startServer(workspacePath: string, options: WorkspaceStartOptions | undefined): Promise<void>;

  /** Called after the provider is ready (e.g. Claude's prompt file plumbing). */
  afterProviderReady?(
    workspacePath: string,
    options: WorkspaceStartOptions | undefined
  ): Promise<void>;

  // --- Terminal lifecycle + per-workspace tracking ---

  /** Apply an agent terminal lifecycle transition (reported by the sidekick). */
  applyTerminalLifecycle(
    workspacePath: string,
    event: AgentLifecycleEvent,
    ctx: SpecContext<P>
  ): void;

  /** Wire agent-specific server callbacks (called once, alongside core wiring). */
  wireExtraCallbacks?(ctx: SpecContext<P>): void;

  /** Called when a provider is registered, before the status seed is emitted. */
  onProviderAdded?(path: WorkspacePath, provider: P): void;

  /** Remove agent-specific tracking state for a workspace. */
  clearWorkspaceTracking?(path: WorkspacePath): void;

  /** Clear agent-specific state on dispose. */
  onDispose?(): void;
}

/**
 * Shared dependencies of the core factory.
 */
export interface AgentModuleCoreDeps {
  readonly logger: Logger;
  readonly downloadDeps: DownloadDeps;
  /** Binary name used for binaryType and download error messages. */
  readonly binaryName: string;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an AgentModuleProvider from a per-agent spec.
 *
 * Uses factory function pattern (not a class) to keep state in a closure,
 * consistent with the existing module pattern.
 */
export function createAgentModuleProvider<P extends AgentProvider>(
  spec: AgentModuleSpec<P>,
  deps: AgentModuleCoreDeps
): AgentModuleProvider {
  const { logger, downloadDeps, binaryName } = deps;

  // ===========================================================================
  // Internal closure state
  // ===========================================================================

  /** Per-workspace provider instances. */
  const providers = new Map<WorkspacePath, P>();

  /** Cached aggregated status per workspace (for deduplication and queries). */
  const statusCache = new Map<WorkspacePath, AggregatedAgentStatus>();

  /** Tracks pending handleServerStarted() promises for startWorkspace(). */
  const serverStartedPromises = new Map<string, Promise<void>>();

  /** Status change subscribers. */
  const statusChangeListeners = new Set<
    (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void
  >();

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: (() => void) | null = null;
  let serverStoppedCleanupFn: (() => void) | null = null;

  /** Whether server callbacks have been wired. */
  let callbacksWired = false;

  const ctx: SpecContext<P> = {
    getProvider: (path) => providers.get(path),
  };

  // ===========================================================================
  // Provider management helpers
  // ===========================================================================

  function notifyStatusChange(path: WorkspacePath, status: AggregatedAgentStatus): void {
    for (const listener of statusChangeListeners) {
      listener(path, status);
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

  function addProvider(path: WorkspacePath, provider: P): void {
    if (providers.has(path)) return;

    provider.onStatusChange((status) => handleStatusUpdate(path, status));

    spec.onProviderAdded?.(path, provider);

    providers.set(path, provider);
    handleStatusUpdate(path, spec.initialStatus(provider));
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
      handleStatusUpdate(path, spec.initialStatus(provider));
    }
  }

  // ===========================================================================
  // Server callback wiring
  // ===========================================================================

  async function handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    extra: unknown
  ): Promise<void> {
    try {
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspacePath)) {
        try {
          await reconnectProvider(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: spec.type,
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: spec.type },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create the agent-specific provider
      const provider = spec.createProvider(workspacePath);

      try {
        await spec.connectProvider(provider, port);
        addProvider(workspacePath, provider);
        await spec.onProviderRegistered?.(workspacePath, provider, extra);
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: spec.type },
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

    spec.wireExtraCallbacks?.(ctx);

    serverStartedCleanupFn = spec.serverManager.onServerStarted((workspacePath, port, ...extra) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port, extra[0]);
      serverStartedPromises.set(workspacePath, promise);
    });

    serverStoppedCleanupFn = spec.serverManager.onServerStopped((workspacePath, ...args) => {
      const isRestart = args[0] === true;
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
    type: spec.type,
    configKey: spec.configKey,
    displayName: spec.displayName,
    icon: spec.icon,
    serverName: spec.serverName,
    scripts: spec.scripts,

    // --- Binary ---
    binaryType: binaryName as BinaryType,

    async preflight(): Promise<{ success: boolean; needsDownload: boolean }> {
      try {
        const resolved = spec.resolveBinary();
        if (resolved === null) {
          return { success: true, needsDownload: false };
        }
        const installed = await isBinaryInstalled(resolved.destDir, downloadDeps);
        return { success: true, needsDownload: !installed };
      } catch {
        return { success: false, needsDownload: false };
      }
    },

    async downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
      const resolved = spec.resolveBinary();
      if (resolved === null) return;
      try {
        await downloadBinary(resolved.request(), downloadDeps, onProgress);
      } catch (error) {
        throw new AgentBinaryError(`Failed to download ${binaryName}: ${getErrorMessage(error)}`);
      }
    },

    // --- Lifecycle ---
    initialize(mcpConfig: McpConfig | null): void {
      wireServerCallbacks();
      if (mcpConfig !== null) {
        spec.serverManager.setMcpConfig(mcpConfig);
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

      await spec.serverManager.dispose();

      for (const provider of providers.values()) {
        provider.dispose();
      }
      providers.clear();
      statusCache.clear();
      statusChangeListeners.clear();
      spec.onDispose?.();
    },

    // --- Per-workspace ---
    async startWorkspace(
      workspacePath: string,
      options?: WorkspaceStartOptions
    ): Promise<WorkspaceStartResult> {
      await spec.startServer(workspacePath, options);

      // Wait for the handleServerStarted callback to complete
      const promise = serverStartedPromises.get(workspacePath);
      if (promise) {
        await promise;
      }

      await spec.afterProviderReady?.(workspacePath, options);

      return {
        envVars: providers.get(workspacePath as WorkspacePath)?.getEnvironmentVariables() ?? {},
      };
    },

    async stopWorkspace(workspacePath: string): Promise<StopServerResult> {
      return spec.serverManager.stopServer(workspacePath);
    },

    async restartWorkspace(workspacePath: string): Promise<RestartServerResult> {
      return spec.serverManager.restartServer(workspacePath);
    },

    applyTerminalLifecycle(workspacePath: string, event: AgentLifecycleEvent): void {
      spec.applyTerminalLifecycle(workspacePath, event, ctx);
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
      spec.clearWorkspaceTracking?.(workspacePath);
    },
  };
}
