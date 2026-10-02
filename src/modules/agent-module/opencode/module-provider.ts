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

      // Send the initial prompt (if any) once the provider is registered.
      onProviderRegistered: async (workspaceRef, provider, extra) => {
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
            logger
              .scoped({ workspace: workspaceRef })
              .error("Failed to send initial prompt", { error: promptResult.error.message });
          }
        } else {
          logger
            .scoped({ workspace: workspaceRef })
            .error("Failed to create session for initial prompt", {
              error: sessionResult.error.message,
            });
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

      // onProviderRegistered has sent the prompt by now (startWorkspace awaits it).
      afterProviderReady: async (_workspaceRef, options) => {
        options.onInitialPromptDelivered?.();
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
      },

      onDispose: () => {
        tuiAttachedWorkspaces.clear();
      },
    },
    { logger, binaryName: "opencode" }
  );
}
