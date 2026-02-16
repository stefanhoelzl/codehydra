/**
 * Application state management.
 * Manages agent lifecycle and server coordination.
 *
 * Note: Project/workspace state is now managed by:
 * - LocalProjectModule / RemoteProjectModule (project registration)
 * - GitWorktreeWorkspaceModule (workspace state)
 * - Workspace index in bootstrap.ts (event-driven Maps for API boundary resolution)
 */

import type { LoggingService, Logger } from "../services";
import type { WorkspacePath } from "../shared/ipc";
import { OpenCodeProvider } from "../agents/opencode/provider";
import type { AgentStatusManager } from "../agents";
import { createAgentProvider, type AgentType } from "../agents";
import type { AgentServerManager } from "../agents/types";
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { PendingPrompt } from "../agents/opencode/server-manager";
import type { McpServerManager } from "../services/mcp-server";

/**
 * Manages application state for agent lifecycle and server coordination.
 */
export class AppState {
  private readonly logger: Logger;
  private readonly agentType: AgentType;
  private agentStatusManager: AgentStatusManager | null = null;
  private serverManager: AgentServerManager | null = null;
  private mcpServerManager: McpServerManager | null = null;
  /**
   * Tracks pending handleServerStarted() promises so callers can await provider registration.
   */
  private readonly serverStartedPromises: Map<string, Promise<void>> = new Map();

  constructor(loggingService: LoggingService, agentType: AgentType) {
    this.logger = loggingService.createLogger("app");
    this.agentType = agentType;
  }

  /**
   * Set the agent status manager (injected from main process).
   */
  setAgentStatusManager(manager: AgentStatusManager): void {
    this.agentStatusManager = manager;
  }

  /**
   * Get the agent status manager.
   */
  getAgentStatusManager(): AgentStatusManager | null {
    return this.agentStatusManager;
  }

  /**
   * Get the agent type configured for this application.
   * Used by the sidekick extension to determine which CLI to launch.
   *
   * @returns The configured agent type ("opencode" or "claude")
   */
  getAgentType(): AgentType {
    return this.agentType;
  }

  /**
   * Wait for the agent provider to be registered for a workspace.
   * Use after startServer() to ensure environment variables are available.
   *
   * @param workspacePath - Workspace path to wait for
   */
  async waitForProvider(workspacePath: string): Promise<void> {
    const promise = this.serverStartedPromises.get(workspacePath);
    if (promise) {
      await promise;
    }
  }

  /**
   * Set the agent server manager and wire callbacks.
   * Called from main process after creating services.
   */
  setServerManager(manager: AgentServerManager): void {
    this.serverManager = manager;

    // Wire server callbacks to agent status manager
    // Note: OpenCode passes (workspacePath, port, pendingPrompt)
    // Claude Code only passes (workspacePath, port)
    manager.onServerStarted((workspacePath, port, ...args) => {
      const pendingPrompt = args[0] as PendingPrompt | undefined;
      // Store promise so callers can await provider registration via waitForProvider()
      const promise = this.handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
      this.serverStartedPromises.set(workspacePath, promise);
    });

    // Note: OpenCode passes (workspacePath, isRestart)
    // Claude Code only passes (workspacePath)
    manager.onServerStopped((workspacePath, ...args) => {
      const isRestart = args[0] as boolean | undefined;
      if (this.agentStatusManager) {
        if (isRestart) {
          // For restart: disconnect but keep provider
          this.agentStatusManager.disconnectWorkspace(workspacePath as WorkspacePath);
        } else {
          // For permanent stop: remove workspace completely
          this.agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
        }
      }
      // Clear from MCP seen set so onFirstRequest fires again after restart
      if (this.mcpServerManager) {
        this.mcpServerManager.clearFirstRequestTracking(workspacePath);
      }
    });
  }

  /**
   * Handle server started event.
   * For restart: reconnects existing provider.
   * For first start: creates provider, registers with AgentStatusManager.
   * For OpenCode: sends initial prompt if provided.
   */
  private async handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    try {
      if (!this.agentStatusManager) {
        return;
      }

      // Check if this is a restart (provider already exists from disconnect)
      if (this.agentStatusManager.hasProvider(workspacePath)) {
        // Restart: reconnect existing provider
        try {
          await this.agentStatusManager.reconnectWorkspace(workspacePath);
          this.logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: this.agentType,
          });
        } catch (error) {
          this.logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: this.agentType },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create provider using factory
      const provider = createAgentProvider(this.agentType, {
        workspacePath,
        logger: this.agentStatusManager.getLogger(),
        sdkFactory:
          this.agentType === "opencode" ? this.agentStatusManager.getSdkFactory() : undefined,
        serverManager:
          this.agentType === "claude" ? (this.serverManager as ClaudeCodeServerManager) : undefined,
      });

      try {
        // Connect to server
        await provider.connect(port);

        // OpenCode-specific: fetch initial status and send initial prompt
        if (this.agentType === "opencode" && provider instanceof OpenCodeProvider) {
          // Fetch initial status
          await provider.fetchStatus();

          // Register with AgentStatusManager
          this.agentStatusManager.addProvider(workspacePath, provider);

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
                this.logger.error("Failed to send initial prompt", {
                  workspacePath,
                  error: promptResult.error.message,
                });
              }
            } else {
              this.logger.error("Failed to create session for initial prompt", {
                workspacePath,
                error: sessionResult.error.message,
              });
            }
          }
        } else {
          // Claude Code: just register the provider (no initial status fetch or prompt)
          this.agentStatusManager.addProvider(workspacePath, provider);
        }
      } catch (error) {
        this.logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: this.agentType },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      // Clean up the promise so subsequent waitForProvider calls return immediately
      this.serverStartedPromises.delete(workspacePath);
    }
  }

  /**
   * Get the agent server manager.
   */
  getServerManager(): AgentServerManager | null {
    return this.serverManager;
  }

  /**
   * Set the MCP server manager.
   * Called from main process after creating services.
   */
  setMcpServerManager(manager: McpServerManager): void {
    this.mcpServerManager = manager;
  }

  /**
   * Get the MCP server manager.
   */
  getMcpServerManager(): McpServerManager | null {
    return this.mcpServerManager;
  }
}
