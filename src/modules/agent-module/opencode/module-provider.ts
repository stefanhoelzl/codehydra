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
import type { WorkspaceRef } from "../../../intents/contract";
import type { Logger } from "../../../boundaries/platform/logging";
import type { OpenCodeServerManager, PendingPrompt } from "./server-manager";
import type { AgentBinaryResolver } from "../binary-resolver";
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
  /** Which `opencode` to run (system install or a download). */
  readonly binary: AgentBinaryResolver;
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
  const { serverManager, binary, logger } = deps;

  /**
   * Track workspaces that have had TUI attached.
   * Persists across provider recreations (e.g., server restart) so we can
   * restore the attached state without waiting for a new MCP request.
   */
  const tuiAttachedWorkspaces = new Set<WorkspaceRef>();

  /**
   * Workspaces whose initial prompt the server has accepted. Cleared per start:
   * `onProviderRegistered` fills it, `afterProviderReady` consumes it. Only an
   * accepted prompt counts as delivered — a refused one must leave the pending
   * prompt in the workspace's metadata, so a reopen delivers it again.
   */
  const initialPromptAccepted = new Set<WorkspaceRef>();

  return createAgentModuleProvider<OpenCodeProvider>(
    {
      // --- Identity ---
      type: "opencode",
      configKey: "version.opencode",
      displayName: "OpenCode",
      icon: "terminal",
      serverName: "OpenCode",
      // No scripts of its own: the launcher is `ch opencode`, inside the ch.cjs
      // bundle that cli-module declares, and the sidekick types that directly.
      scripts: [],

      serverManager,

      // --- Binary ---
      binary,
      // The TUI (`ch opencode` → `opencode attach`) runs the same binary as the
      // server it attaches to.
      binaryEnv: (resolved) => ({ _CH_OPENCODE_BIN: resolved.path }),

      // --- Provider lifecycle ---
      createProvider: (workspaceRef) => {
        const workspacePath = serverManager.getWorkspacePath(workspaceRef);
        if (workspacePath === undefined) {
          throw new Error(`No OpenCode server is tracked for ${workspaceRef}`);
        }
        return new OpenCodeProvider(workspaceRef, workspacePath, logger);
      },

      connectProvider: async (provider, port) => {
        await provider.connect(port);
        await provider.fetchStatus();
      },

      initialStatus: (provider) => countsToStatus(provider.getEffectiveCounts()),

      onProviderAdded: (workspaceRef, provider) => {
        if (tuiAttachedWorkspaces.has(workspaceRef)) {
          provider.markActive();
        }
      },

      // Queue the initial prompt (if any) once the provider is registered.
      // Queued, never awaited as a turn: the turn a prompt starts can outlast
      // a workspace:open by minutes, and the open must not sit in loading
      // until it ends.
      onProviderRegistered: async (workspaceRef, provider, extra) => {
        // Before the early return: an acceptance left over from a start whose
        // afterProviderReady never ran must not count for this one.
        initialPromptAccepted.delete(workspaceRef);

        const pendingPrompt = extra as PendingPrompt | undefined;
        if (!pendingPrompt) return;

        // The primary session is the one the TUI attaches to, so the prompt
        // must be queued there — a session of its own would run the turn
        // where nobody sees it. Creating one (which becomes the primary) is
        // only the fallback for a connect that established no primary.
        let sessionId = provider.getSession()?.sessionId ?? null;
        if (sessionId === null) {
          const sessionResult = await provider.createSession();
          if (sessionResult.ok) {
            sessionId = sessionResult.value.id;
          } else {
            logger
              .scoped({ workspace: workspaceRef })
              .error("Failed to create session for initial prompt", {
                error: sessionResult.error.message,
              });
            return;
          }
        }

        const promptResult = await provider.sendPromptAsync(sessionId, pendingPrompt.prompt, {
          ...(pendingPrompt.agent !== undefined && { agent: pendingPrompt.agent }),
          ...(pendingPrompt.model !== undefined && { model: pendingPrompt.model }),
        });
        if (promptResult.ok) {
          initialPromptAccepted.add(workspaceRef);
        } else {
          logger
            .scoped({ workspace: workspaceRef })
            .error("Failed to send initial prompt", { error: promptResult.error.message });
        }
      },

      // --- Workspace start ---
      startServer: async (workspaceRef, workspacePath, options, resolved) => {
        // OpenCode applies the named agent/model per message, so a prompt is
        // required to act on them; without a prompt there's nothing to send.
        const ip = options.initialPrompt;
        await serverManager.startServer(workspaceRef, workspacePath, {
          ...(ip?.prompt && {
            initialPrompt: {
              prompt: ip.prompt,
              ...(ip.agentName !== undefined && { agentName: ip.agentName }),
              ...(ip.model !== undefined && { model: ip.model }),
            },
          }),
          // The bash tool runs inside this server, so this is where the
          // workspace environment has to be for the agent's commands to see it.
          ...(options.env !== undefined && { env: options.env }),
          binary: resolved,
        });
      },

      // onProviderRegistered has queued the prompt by now (startWorkspace
      // awaits it). Delivered means the server accepted it — from then on the
      // session holds it; a refused or failed queue leaves the pending prompt
      // in the workspace's metadata for the next open to deliver.
      afterProviderReady: async (workspaceRef, options) => {
        if (initialPromptAccepted.delete(workspaceRef)) {
          options.onInitialPromptDelivered?.();
        }
      },

      // --- Terminal lifecycle + TUI tracking ---
      wireExtraCallbacks: (ctx) => {
        serverManager.setMarkActiveHandler((workspaceRef) => {
          tuiAttachedWorkspaces.add(workspaceRef);
          ctx.getProvider(workspaceRef)?.markActive();
        });
      },

      applyTerminalLifecycle: (workspaceRef, event, ctx) => {
        if (event === "open") {
          // Clears the loading screen (workspace-ready) and marks active (TUI attached),
          // mirroring the old WrapperStart bridge route.
          serverManager.triggerWrapperStart(workspaceRef);
        } else {
          tuiAttachedWorkspaces.delete(workspaceRef);
          ctx.getProvider(workspaceRef)?.detachTui();
        }
      },

      clearWorkspaceTracking: (workspaceRef) => {
        tuiAttachedWorkspaces.delete(workspaceRef);
        initialPromptAccepted.delete(workspaceRef);
      },

      onDispose: () => {
        tuiAttachedWorkspaces.clear();
        initialPromptAccepted.clear();
      },
    },
    { logger, binaryName: "opencode" }
  );
}
