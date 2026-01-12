/**
 * Agent Abstraction Layer - factory functions for pluggable agent implementations.
 *
 * This module provides factory functions to create agent components without
 * tight coupling to specific agent implementations (currently OpenCode).
 *
 * Usage:
 * ```typescript
 * const setupInfo = getAgentSetupInfo("opencode", setupDeps);
 * const serverManager = createAgentServerManager("opencode", serverDeps);
 * const provider = createAgentProvider("opencode", providerDeps);
 * ```
 */

import type { ProcessRunner } from "../services/platform/process";
import type { PortManager, HttpClient } from "../services/platform/network";
import type { PathProvider } from "../services/platform/path-provider";
import type { FileSystemLayer } from "../services/platform/filesystem";
import type { Logger } from "../services/logging";
import type { SupportedArch } from "../services/platform/platform-info";
import type { SdkClientFactory } from "./opencode/client";

import type { AgentType, AgentSetupInfo, AgentServerManager, AgentProvider } from "./types";
import { OpenCodeSetupInfo } from "./opencode/setup-info";
import { OpenCodeServerManager } from "./opencode/server-manager";
import { OpenCodeProvider } from "./opencode/provider";
import { ClaudeCodeSetupInfo } from "./claude/setup-info";
import { ClaudeCodeServerManager } from "./claude/server-manager";
import { ClaudeCodeProvider } from "./claude/provider";

// Re-export types for convenience
export type {
  AgentType,
  AgentSetupInfo,
  AgentServerManager,
  AgentProvider,
  AgentSessionInfo,
  AgentError,
  StopServerResult,
  RestartServerResult,
} from "./types";

// Re-export status manager
export { AgentStatusManager, type StatusChangedCallback } from "./status-manager";

/**
 * Dependencies for creating AgentSetupInfo instances.
 */
export interface SetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly httpClient: HttpClient;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: SupportedArch;
}

/**
 * Dependencies for creating AgentServerManager instances.
 */
export interface ServerManagerDeps {
  readonly processRunner: ProcessRunner;
  readonly portManager: PortManager;
  readonly httpClient: HttpClient;
  readonly pathProvider: PathProvider;
  readonly fileSystem: FileSystemLayer;
  readonly logger: Logger;
}

/**
 * Dependencies for creating AgentProvider instances.
 */
export interface ProviderDeps {
  readonly workspacePath: string;
  readonly logger: Logger;
  /** SDK factory for OpenCode provider (optional, can be undefined) */
  readonly sdkFactory?: SdkClientFactory | undefined;
  /** Server manager for Claude Code provider (optional, can be undefined) */
  readonly serverManager?: ClaudeCodeServerManager | undefined;
}

/**
 * Get the setup info for an agent type.
 * Returns static information about the agent (version, URLs, config generation).
 *
 * @param type - The agent type
 * @param deps - Dependencies for creating the setup info
 * @returns AgentSetupInfo instance
 */
export function getAgentSetupInfo(type: AgentType, deps: SetupInfoDeps): AgentSetupInfo {
  switch (type) {
    case "opencode":
      return new OpenCodeSetupInfo({
        fileSystem: deps.fileSystem,
        platform: deps.platform,
        arch: deps.arch,
      });
    case "claude":
      return new ClaudeCodeSetupInfo({
        fileSystem: deps.fileSystem,
        httpClient: deps.httpClient,
        platform: deps.platform,
        arch: deps.arch,
      });
  }
}

/**
 * Create an agent server manager for the given type.
 * The server manager handles spawning and managing agent servers per workspace.
 *
 * @param type - The agent type
 * @param deps - Dependencies for creating the server manager
 * @returns AgentServerManager instance
 */
export function createAgentServerManager(
  type: AgentType,
  deps: ServerManagerDeps
): AgentServerManager {
  switch (type) {
    case "opencode":
      return new OpenCodeServerManager(
        deps.processRunner,
        deps.portManager,
        deps.httpClient,
        deps.pathProvider,
        deps.logger
      );
    case "claude":
      return new ClaudeCodeServerManager({
        portManager: deps.portManager,
        pathProvider: deps.pathProvider,
        fileSystem: deps.fileSystem,
        logger: deps.logger,
      });
  }
}

/**
 * Create an agent provider for the given type.
 * The provider manages the connection to an agent server for a single workspace.
 *
 * @param type - The agent type
 * @param deps - Dependencies for creating the provider
 * @returns AgentProvider instance
 */
export function createAgentProvider(type: AgentType, deps: ProviderDeps): AgentProvider {
  switch (type) {
    case "opencode":
      return new OpenCodeProvider(deps.workspacePath, deps.logger, deps.sdkFactory);
    case "claude":
      if (!deps.serverManager) {
        throw new Error("ClaudeCodeProvider requires serverManager in deps");
      }
      return new ClaudeCodeProvider({
        serverManager: deps.serverManager,
        workspacePath: deps.workspacePath,
        logger: deps.logger,
      });
  }
}
