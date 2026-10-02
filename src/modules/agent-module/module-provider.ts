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
  AgentLaunchOptions,
  WorkspaceStartOptions,
  WorkspaceStartResult,
} from "./agent-module-provider";
import type {
  AgentMessage,
  AgentMessageOptions,
  AgentProvider,
  AgentServerManager,
  AgentSessionInfo,
  AgentActivity,
  McpConfig,
  StopServerResult,
  RestartServerResult,
} from "./types";
import type { AgentType, AgentLifecycleEvent } from "../../shared/api-protocol";
import type { AggregatedAgentStatus } from "../../shared/ipc";
import type { WorkspaceRef } from "../../intents/contract";
import type { Path } from "../../utils/path/path";
import type { DownloadProgressCallback } from "../../utils/binary-download";
import {
  binaryNotReadyError,
  type AgentBinaryResolver,
  type ResolvedAgentBinary,
} from "./binary-resolver";
import type { BinaryType } from "../../utils/binary-resolution/types";
import { AgentBinaryError, getErrorMessage } from "../../shared/errors/service-errors";
import { toError } from "../../shared/error-utils";
import type { Logger } from "../../boundaries/platform/logging";
import { createNoneStatus, convertToAggregatedStatus } from "./status-utils";
import { AgentUnreachableError } from "./types";

// =============================================================================
// Spec Interface
// =============================================================================

/**
 * Access to the core's per-workspace provider registry, handed to spec hooks
 * that need to reach a registered provider (e.g. terminal lifecycle routing).
 */
export interface SpecContext<P extends AgentProvider> {
  getProvider(workspaceRef: WorkspaceRef): P | undefined;
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

  /** Decides which executable the agent runs, and downloads it when needed. */
  readonly binary: AgentBinaryResolver;

  /**
   * Environment for the agent terminal that points it at `binary` (e.g.
   * `_CH_CLAUDE_BIN`), merged over the provider's own variables.
   */
  binaryEnv(binary: ResolvedAgentBinary): Record<string, string>;

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
  createProvider(workspaceRef: WorkspaceRef): P;

  /** Connect the provider to the server (plus any initial fetch). */
  connectProvider(provider: P, port: number): Promise<void>;

  /** Status seed used on registration and after reconnect. */
  initialStatus(provider: P): AgentActivity;

  /**
   * Called after the provider is registered on first start. `extra` is the
   * third argument of the server manager's onServerStarted callback
   * (e.g. OpenCode's pending prompt), untyped at this boundary.
   */
  onProviderRegistered?(workspaceRef: WorkspaceRef, provider: P, extra: unknown): Promise<void>;

  // --- Workspace start ---

  /** Start the agent server for a workspace, running `binary`. */
  startServer(
    workspaceRef: WorkspaceRef,
    workspacePath: Path,
    options: WorkspaceStartOptions,
    binary: ResolvedAgentBinary
  ): Promise<void>;

  /** Called after the provider is ready (e.g. Claude's prompt file plumbing). */
  afterProviderReady?(workspaceRef: WorkspaceRef, options: WorkspaceStartOptions): Promise<void>;

  // --- Terminal lifecycle + per-workspace tracking ---

  /** Apply an agent terminal lifecycle transition (reported by the sidekick). */
  applyTerminalLifecycle(
    workspaceRef: WorkspaceRef,
    event: AgentLifecycleEvent,
    ctx: SpecContext<P>
  ): void;

  /** Wire agent-specific server callbacks (called once, alongside core wiring). */
  wireExtraCallbacks?(ctx: SpecContext<P>): void;

  /** Called when a provider is registered, before the status seed is emitted. */
  onProviderAdded?(workspaceRef: WorkspaceRef, provider: P): void;

  /** Remove agent-specific tracking state for a workspace. */
  clearWorkspaceTracking?(workspaceRef: WorkspaceRef): void;

  /** Clear agent-specific state on dispose. */
  onDispose?(): void;

  // --- Launch options ---

  /** Launch options this agent offers the creation form (e.g. permission modes). */
  getLaunchOptions?(): Promise<AgentLaunchOptions>;
}

/**
 * Shared dependencies of the core factory.
 */
export interface AgentModuleCoreDeps {
  readonly logger: Logger;
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
  const { logger, binaryName } = deps;

  // ===========================================================================
  // Internal closure state
  // ===========================================================================

  /** Per-workspace provider instances. */
  const providers = new Map<WorkspaceRef, P>();

  /** Cached aggregated status per workspace, as the agent reported it (for deduplication). */
  const statusCache = new Map<WorkspaceRef, AggregatedAgentStatus>();

  /**
   * Workspaces with a modal open in their editor. Overlaid on `statusCache`:
   * such a workspace reads idle whatever its agent reports (see `effectiveStatus`).
   */
  const modalOpen = new Set<WorkspaceRef>();

  /** Tracks pending handleServerStarted() promises for startWorkspace(). */
  const serverStartedPromises = new Map<WorkspaceRef, Promise<void>>();

  /** Status change subscribers. */
  const statusChangeListeners = new Set<
    (workspaceRef: WorkspaceRef, status: AggregatedAgentStatus) => void
  >();

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: (() => void) | null = null;
  let serverStoppedCleanupFn: (() => void) | null = null;

  /** Whether server callbacks have been wired. */
  let callbacksWired = false;

  const ctx: SpecContext<P> = {
    getProvider: (workspaceRef) => providers.get(workspaceRef),
  };

  // ===========================================================================
  // Provider management helpers
  // ===========================================================================

  function notifyStatusChange(workspaceRef: WorkspaceRef, status: AggregatedAgentStatus): void {
    for (const listener of statusChangeListeners) {
      listener(workspaceRef, status);
    }
  }

  /**
   * The status the rest of the app sees: the agent's own, unless a modal is open,
   * which parks the workspace on the user — idle even when the agent is still
   * working or has no session.
   */
  function effectiveStatus(workspaceRef: WorkspaceRef): AggregatedAgentStatus {
    if (modalOpen.has(workspaceRef)) return convertToAggregatedStatus("idle");
    return statusCache.get(workspaceRef) ?? createNoneStatus();
  }

  function handleStatusUpdate(workspaceRef: WorkspaceRef, agentStatus: AgentActivity): void {
    const status = convertToAggregatedStatus(agentStatus);
    const previous = statusCache.get(workspaceRef);
    const hasChanged =
      !previous ||
      previous.status !== status.status ||
      previous.counts.idle !== status.counts.idle ||
      previous.counts.busy !== status.counts.busy;

    if (hasChanged) {
      statusCache.set(workspaceRef, status);
      // While parked, the agent's changes are recorded but not reported: the
      // workspace keeps reading idle until the modal closes.
      if (!modalOpen.has(workspaceRef)) notifyStatusChange(workspaceRef, status);
    }
  }

  function addProvider(workspaceRef: WorkspaceRef, provider: P): void {
    if (providers.has(workspaceRef)) return;

    provider.onStatusChange((status) => handleStatusUpdate(workspaceRef, status));

    spec.onProviderAdded?.(workspaceRef, provider);

    providers.set(workspaceRef, provider);
    handleStatusUpdate(workspaceRef, spec.initialStatus(provider));
  }

  function removeProvider(workspaceRef: WorkspaceRef): void {
    const provider = providers.get(workspaceRef);
    if (provider) {
      provider.dispose();
      providers.delete(workspaceRef);
      statusCache.delete(workspaceRef);
      notifyStatusChange(workspaceRef, effectiveStatus(workspaceRef));
    }
  }

  function disconnectProvider(workspaceRef: WorkspaceRef): void {
    const provider = providers.get(workspaceRef);
    if (provider) {
      provider.disconnect();
    }
  }

  async function reconnectProvider(workspaceRef: WorkspaceRef): Promise<void> {
    const provider = providers.get(workspaceRef);
    if (provider) {
      await provider.reconnect();
      handleStatusUpdate(workspaceRef, spec.initialStatus(provider));
    }
  }

  // ===========================================================================
  // Server callback wiring
  // ===========================================================================

  async function handleServerStarted(
    workspaceRef: WorkspaceRef,
    port: number,
    extra: unknown
  ): Promise<void> {
    const log = logger.scoped({ workspace: workspaceRef });
    try {
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspaceRef)) {
        try {
          await reconnectProvider(workspaceRef);
          log.info("Reconnected agent provider after restart", { port, agentType: spec.type });
        } catch (error) {
          log.error(
            "Failed to reconnect agent provider",
            { port, agentType: spec.type },
            toError(error)
          );
        }
        return;
      }

      try {
        // First start: create the agent-specific provider
        const provider = spec.createProvider(workspaceRef);
        await spec.connectProvider(provider, port);
        addProvider(workspaceRef, provider);
        await spec.onProviderRegistered?.(workspaceRef, provider, extra);
      } catch (error) {
        log.error(
          "Failed to initialize agent provider",
          { port, agentType: spec.type },
          toError(error)
        );
      }
    } finally {
      serverStartedPromises.delete(workspaceRef);
    }
  }

  function wireServerCallbacks(): void {
    if (callbacksWired) return;
    callbacksWired = true;

    spec.wireExtraCallbacks?.(ctx);

    serverStartedCleanupFn = spec.serverManager.onServerStarted((workspaceRef, port, ...extra) => {
      const promise = handleServerStarted(workspaceRef, port, extra[0]);
      serverStartedPromises.set(workspaceRef, promise);
    });

    serverStoppedCleanupFn = spec.serverManager.onServerStopped((workspaceRef, ...args) => {
      const isRestart = args[0] === true;
      if (isRestart) {
        disconnectProvider(workspaceRef);
      } else {
        removeProvider(workspaceRef);
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

    // --- Launch options (optional per spec) ---
    ...(spec.getLaunchOptions && { getLaunchOptions: spec.getLaunchOptions }),

    async preflight(): Promise<{ success: boolean; needsDownload: boolean }> {
      try {
        const { needsDownload } = await spec.binary.prepare();
        return { success: true, needsDownload };
      } catch (error) {
        logger.warn("Binary preflight failed", {
          binary: binaryName,
          error: getErrorMessage(error),
        });
        return { success: false, needsDownload: false };
      }
    },

    async downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
      try {
        await spec.binary.download(onProgress);
      } catch (error) {
        // Callers add the "Failed to download <binary>" context.
        throw new AgentBinaryError(getErrorMessage(error));
      }
    },

    async seedBinary(onProgress?: DownloadProgressCallback): Promise<string> {
      return spec.binary.seed(onProgress);
    },

    bundleVersionsInUse: () => spec.binary.bundleVersionsInUse(),

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
      modalOpen.clear();
      statusChangeListeners.clear();
      spec.onDispose?.();
    },

    // --- Per-workspace ---
    async startWorkspace(
      workspaceRef: WorkspaceRef,
      workspacePath: Path,
      options: WorkspaceStartOptions = {}
    ): Promise<WorkspaceStartResult> {
      // Snapshot once: the server and the terminal must run the same binary
      // even if a background download lands meanwhile.
      const binary = spec.binary.current();
      if (binary === null) {
        throw binaryNotReadyError(binaryName);
      }
      await spec.startServer(workspaceRef, workspacePath, options, binary);

      // Wait for the handleServerStarted callback to complete
      const promise = serverStartedPromises.get(workspaceRef);
      if (promise) {
        await promise;
      }

      await spec.afterProviderReady?.(workspaceRef, options);

      const providerEnv = providers.get(workspaceRef)?.getEnvironmentVariables() ?? {};
      return {
        envVars: { ...providerEnv, ...spec.binaryEnv(binary) },
      };
    },

    async stopWorkspace(workspaceRef: WorkspaceRef): Promise<StopServerResult> {
      return spec.serverManager.stopServer(workspaceRef);
    },

    async restartWorkspace(workspaceRef: WorkspaceRef): Promise<RestartServerResult> {
      return spec.serverManager.restartServer(workspaceRef);
    },

    applyTerminalLifecycle(workspaceRef: WorkspaceRef, event: AgentLifecycleEvent): void {
      spec.applyTerminalLifecycle(workspaceRef, event, ctx);
    },

    setModalOpen(workspaceRef: WorkspaceRef, open: boolean): void {
      if (open) modalOpen.add(workspaceRef);
      else modalOpen.delete(workspaceRef);
      // Reported unconditionally rather than deduplicated: an `agent.status.set`
      // nudge reaches the UI without passing through here, so the last status
      // this core reported is not necessarily what the UI shows.
      notifyStatusChange(workspaceRef, effectiveStatus(workspaceRef));
    },

    // --- Query ---
    getStatus(workspaceRef: WorkspaceRef): AggregatedAgentStatus {
      return effectiveStatus(workspaceRef);
    },

    getSession(workspaceRef: WorkspaceRef): AgentSessionInfo | null {
      return providers.get(workspaceRef)?.getSession() ?? null;
    },

    // --- Messages ---
    async sendMessage(
      workspaceRef: WorkspaceRef,
      message: AgentMessage,
      options: AgentMessageOptions
    ): Promise<void> {
      // A provider that is still being registered (the server just started)
      // is the one the message is for.
      await serverStartedPromises.get(workspaceRef);
      const provider = providers.get(workspaceRef);
      if (provider === undefined) {
        throw new AgentUnreachableError(
          `No ${spec.displayName} agent is running in this workspace.`
        );
      }
      await provider.sendMessage(message, options);
    },

    // --- Events ---
    onStatusChange(
      callback: (workspaceRef: WorkspaceRef, status: AggregatedAgentStatus) => void
    ): () => void {
      statusChangeListeners.add(callback);
      return () => statusChangeListeners.delete(callback);
    },

    // --- Cleanup ---
    clearWorkspaceTracking(workspaceRef: WorkspaceRef): void {
      // The API server reports the close when the workspace's socket drops,
      // but that report resolves the agent from metadata that teardown may
      // already have removed, so it can land in another agent's module.
      modalOpen.delete(workspaceRef);
      spec.clearWorkspaceTracking?.(workspaceRef);
    },
  };
}
