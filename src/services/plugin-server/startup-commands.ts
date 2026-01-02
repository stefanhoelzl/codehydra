/**
 * Startup commands for VS Code workspace configuration.
 *
 * These commands are sent to each workspace when its extension connects
 * to configure the workspace layout for optimal AI workflow.
 */

import type { PluginServer } from "./plugin-server";
import type { Logger } from "../logging";

// ============================================================================
// Constants
// ============================================================================

/**
 * Timeout for startup commands (shorter than default since they're best-effort).
 */
const STARTUP_COMMAND_TIMEOUT_MS = 5000;

// ============================================================================
// Startup Commands Constant
// ============================================================================

/**
 * VS Code commands sent to each workspace on extension connection.
 *
 * These commands configure the workspace layout:
 * - Close sidebars to maximize editor space
 * - Open OpenCode terminal for AI workflow
 * - Unlock editor groups for flexible tab management
 * - Open dictation panel in background (no-op if not configured)
 * - Focus terminal to ensure OpenCode input is ready for typing
 */
export const STARTUP_COMMANDS = [
  "workbench.action.closeSidebar", // Hide left sidebar to maximize editor
  "workbench.action.closeAuxiliaryBar", // Hide right sidebar (auxiliary bar)
  "opencode.openTerminal", // Open OpenCode terminal for AI workflow
  "workbench.action.unlockEditorGroup", // Unlock editor group for tab reuse
  "workbench.action.closeEditorsInOtherGroups", // Clean up empty editor groups
  "codehydra.dictation.openPanel", // Open dictation tab in background (no-op if no API key)
  "workbench.action.terminal.focus", // Ensure terminal input is focused
] as const;

/**
 * Type for a valid startup command.
 */
export type StartupCommand = (typeof STARTUP_COMMANDS)[number];

// ============================================================================
// sendStartupCommands
// ============================================================================

/**
 * Send startup commands to configure workspace layout.
 * Commands are sent sequentially; failures are logged but don't stop execution.
 *
 * @param server - PluginServer instance to send commands through
 * @param workspacePath - Normalized workspace path
 * @param logger - Logger for command execution logging
 * @param delayMs - Delay before sending commands (default: 100ms for UI stabilization)
 */
export async function sendStartupCommands(
  server: PluginServer,
  workspacePath: string,
  logger: Logger,
  delayMs = 100
): Promise<void> {
  // Validate workspace path
  if (!workspacePath || typeof workspacePath !== "string") {
    logger.warn("Startup commands skipped: invalid workspace path", {
      workspacePath: String(workspacePath),
    });
    return;
  }

  // Wait for UI stabilization
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  logger.debug("Sending startup commands", {
    workspace: workspacePath,
    commandCount: STARTUP_COMMANDS.length,
  });

  // Send commands sequentially
  for (const command of STARTUP_COMMANDS) {
    const result = await server.sendCommand(workspacePath, command, [], STARTUP_COMMAND_TIMEOUT_MS);

    if (!result.success) {
      logger.warn("Startup command failed", {
        workspace: workspacePath,
        command,
        error: result.error,
      });
    } else {
      logger.debug("Startup command executed", {
        workspace: workspacePath,
        command,
      });
    }
  }

  logger.debug("Startup commands complete", { workspace: workspacePath });
}
