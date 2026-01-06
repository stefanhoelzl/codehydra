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
  readonly logger: Logger;
}

/**
 * Dependencies for creating AgentProvider instances.
 */
export interface ProviderDeps {
  readonly workspacePath: string;
  readonly logger: Logger;
  readonly sdkFactory?: SdkClientFactory;
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
  }
}
