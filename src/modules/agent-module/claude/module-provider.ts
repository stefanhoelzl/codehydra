/**
 * Claude Module Provider - AgentModuleProvider implementation for Claude Code.
 *
 * Defines the Claude-specific AgentModuleSpec consumed by the generic
 * createAgentModuleProvider() core: provider construction, prompt-file
 * plumbing (initial prompt + no-session marker), and wrapper lifecycle
 * routing. All provider-tracking machinery lives in the core.
 */

import type { AgentModuleProvider } from "../agent-module-provider";
import type { Logger } from "../../../boundaries/platform/logging";
import type { ClaudeCodeServerManager } from "./server-manager";
import { ClaudeCodeProvider } from "./provider";
import type { SupportedPlatform } from "../../../boundaries/platform/platform-info";
import type { ProcessRunner } from "../../../boundaries/platform/process";
import { runAgentBinary, type AgentBinaryResolver } from "../binary-resolver";
import { createAgentModuleProvider } from "../module-provider";
import { getErrorMessage } from "../../../shared/error-utils";

/**
 * Matches the `(choices: ...)` list on the `--permission-mode` line of
 * `claude --help` — parsed rather than hardcoded so the form tracks whatever
 * the installed Claude version supports.
 */
const PERMISSION_MODE_CHOICES_REGEX = /--permission-mode\b[\s\S]*?\(choices:\s*([^)]*)\)/;

/** Parse the permission-mode choices from `claude --help` output ([] if none). */
function parsePermissionModes(helpText: string): string[] {
  const match = PERMISSION_MODE_CHOICES_REGEX.exec(helpText);
  if (match === null || match[1] === undefined) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

// =============================================================================
// Dependency Interface
// =============================================================================

/**
 * Dependencies for creating a Claude module provider.
 */
export interface ClaudeModuleProviderDeps {
  readonly serverManager: ClaudeCodeServerManager;
  /** Which `claude` to run (system install or a download). */
  readonly binary: AgentBinaryResolver;
  readonly platform: SupportedPlatform;
  readonly logger: Logger;
  /** Process runner used to detect permission modes via `claude --help`. */
  readonly processRunner: Pick<ProcessRunner, "run">;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an AgentModuleProvider for Claude Code.
 */
export function createClaudeModuleProvider(deps: ClaudeModuleProviderDeps): AgentModuleProvider {
  const { serverManager, binary, platform, logger, processRunner } = deps;

  // Owned by the module: parse `claude --help` once (cached) for the permission
  // modes the creation form offers, from the same binary workspaces run. Before
  // that binary is known, or when the run fails, detection degrades to the
  // default mode only and is not cached, so a later call can retry.
  let permissionModesCache: readonly string[] | undefined;
  const detectPermissionModes = async (): Promise<readonly string[]> => {
    if (permissionModesCache !== undefined) return permissionModesCache;
    const resolved = binary.current();
    if (resolved === null) return [];
    try {
      const proc = runAgentBinary(processRunner, resolved.path, ["--help"], platform);
      const { stdout } = await proc.wait();
      permissionModesCache = parsePermissionModes(stdout);
      return permissionModesCache;
    } catch (error) {
      logger.warn("Failed to detect Claude permission modes", { error: getErrorMessage(error) });
      return [];
    }
  };

  return createAgentModuleProvider<ClaudeCodeProvider>(
    {
      // --- Identity ---
      type: "claude",
      configKey: "version.claude",
      displayName: "Claude Code",
      icon: "sparkle",
      serverName: "Claude Code hook",
      // No launcher of its own: `ch claude` lives in the ch.cjs bundle that
      // cli-module declares, and the sidekick types that into the agent
      // terminal. What remains is Claude-specific: the hook handler its settings
      // file points at, and the background wrapper only Claude's
      // background_tasks can report.
      scripts: ["claude-code-hook-handler.cjs", "ch-bg", "ch-bg.cmd"],

      serverManager,

      // --- Binary ---
      binary,
      binaryEnv: (resolved) => ({
        _CH_CLAUDE_BIN: resolved.path,
        // CodeHydra updates the binaries it downloads; a system install is the
        // user's to manage.
        ...(resolved.source === "download" && { DISABLE_AUTOUPDATER: "1" }),
      }),

      // --- Provider lifecycle ---
      createProvider: (workspacePath) =>
        new ClaudeCodeProvider({ serverManager, workspacePath, logger }),

      connectProvider: (provider, port) => provider.connect(port),

      // Status comes via onStatusChange from the ServerManager hooks; the
      // registration/reconnect seed is always "none".
      initialStatus: () => "none",

      // --- Workspace start ---
      startServer: async (workspacePath) => {
        await serverManager.startServer(workspacePath);
      },

      afterProviderReady: async (workspacePath, options) => {
        if (options?.initialPrompt) {
          await serverManager.setInitialPrompt(workspacePath, options.initialPrompt);
        }
        if (options?.isNewWorkspace) {
          await serverManager.setNoSessionMarker(workspacePath);
        }
      },

      // --- Terminal lifecycle ---
      applyTerminalLifecycle: (workspacePath, event) => {
        serverManager.triggerWrapperLifecycle(
          workspacePath,
          event === "open" ? "WrapperStart" : "WrapperEnd"
        );
      },

      // --- Launch options ---
      getLaunchOptions: async () => ({ permissionModes: await detectPermissionModes() }),
    },
    { logger, binaryName: "claude" }
  );
}
