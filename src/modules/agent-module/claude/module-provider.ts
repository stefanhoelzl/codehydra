/**
 * Claude Module Provider - AgentModuleProvider implementation for Claude Code.
 *
 * Defines the Claude-specific AgentModuleSpec consumed by the generic
 * createAgentModuleProvider() core: provider construction, prompt-file
 * plumbing (initial prompt + no-session marker), and wrapper lifecycle
 * routing. All provider-tracking machinery lives in the core.
 */

import type { AgentModuleProvider } from "../agent-module-provider";
import type { ArchiveExtension, DownloadDeps } from "../../../utils/binary-download";
import type { PersistedAccessor } from "../../../boundaries/platform/store-definition";
import type { Logger } from "../../../boundaries/platform/logging";
import type { ClaudeCodeServerManager } from "./server-manager";
import { ClaudeCodeProvider } from "./provider";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { SupportedPlatform, SupportedArch } from "../../../boundaries/platform/platform-info";
import type { ProcessRunner } from "../../../boundaries/platform/process";
import { getClaudeUrlForVersion, getClaudeSubPath, getClaudeExecutablePath } from "./setup-info";
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
  const {
    serverManager,
    downloadDeps,
    binaryConfig,
    versionConfig,
    pathProvider,
    platform,
    arch,
    logger,
    processRunner,
  } = deps;

  // Owned by the module: parse `claude --help` once (cached) for the permission
  // modes the creation form offers. Pinned version.claude relies on the binary
  // being on PATH; otherwise detection degrades to the default mode only. A
  // failed run is not cached, so a later call can retry.
  let permissionModesCache: readonly string[] | undefined;
  const detectPermissionModes = async (): Promise<readonly string[]> => {
    if (permissionModesCache !== undefined) return permissionModesCache;
    try {
      const proc = processRunner.run(getClaudeExecutablePath(platform), ["--help"]);
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
      scripts: ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "claude-code-hook-handler.cjs"],

      serverManager,

      // --- Binary: version null = bundled binary, nothing to download ---
      resolveBinary() {
        const version = versionConfig.get();
        if (version === null) return null;
        const destDir = pathProvider.bundlePath(`claude/${version}`).toNative();
        return {
          destDir,
          request: () => ({
            name: binaryConfig.name,
            url: getClaudeUrlForVersion(version, platform, arch),
            destDir,
            archiveExtension: binaryConfig.archiveExtension,
            executablePath: binaryConfig.executablePath,
            subPath: getClaudeSubPath(platform, arch),
          }),
        };
      },

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
    { logger, downloadDeps, binaryName: binaryConfig.name }
  );
}
