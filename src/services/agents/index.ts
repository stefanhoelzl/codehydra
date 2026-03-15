/**
 * Agent Abstraction Layer - factory functions for pluggable agent implementations.
 *
 * This module provides factory functions to create agent components without
 * tight coupling to specific agent implementations.
 *
 * Usage:
 * ```typescript
 * const setupInfo = getAgentSetupInfo("opencode", setupDeps);
 * ```
 */

import type { HttpClient } from "../../boundaries/platform/network/network";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem/filesystem";
import type { SupportedArch } from "../../boundaries/platform/env/platform-info";

import type { AgentType, AgentSetupInfo } from "./types";
import { OpenCodeSetupInfo } from "./opencode/setup-info";
import { ClaudeSetupInfo } from "./claude/setup-info";

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

export type { AgentModuleProvider } from "./agent-module-provider";
export { createClaudeModuleProvider } from "./claude/module-provider";
export { createOpenCodeModuleProvider } from "./opencode/module-provider";

/**
 * Dependencies for creating AgentSetupInfo instances.
 */
export interface SetupInfoDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly httpClient: HttpClient;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: SupportedArch;
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
      return new ClaudeSetupInfo({
        fileSystem: deps.fileSystem,
        httpClient: deps.httpClient,
        platform: deps.platform,
        arch: deps.arch,
      });
  }
}
