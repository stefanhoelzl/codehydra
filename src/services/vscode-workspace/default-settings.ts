/**
 * Default VS Code settings for workspace files.
 *
 * These can be overridden by project-level configuration or agent-specific settings.
 */

import type { WorkspaceFileConfig } from "./types";

/**
 * Default VS Code settings for new workspaces.
 * Agent-specific settings are merged on top of these.
 */
export const DEFAULT_WORKSPACE_SETTINGS: Readonly<Record<string, unknown>> = {
  // Workspace settings can be added here as needed
};

/**
 * Recommended extensions for CodeHydra workspaces.
 */
export const RECOMMENDED_EXTENSIONS: readonly string[] = [
  // Extension IDs can be added here as needed
];

/**
 * Create workspace file configuration.
 *
 * @param customSettings - Additional settings to merge with defaults
 * @param customExtensions - Additional extension recommendations
 */
export function createWorkspaceFileConfig(
  customSettings?: Readonly<Record<string, unknown>>,
  customExtensions?: readonly string[]
): WorkspaceFileConfig {
  const extensions =
    customExtensions && customExtensions.length > 0
      ? [...RECOMMENDED_EXTENSIONS, ...customExtensions]
      : RECOMMENDED_EXTENSIONS.length > 0
        ? [...RECOMMENDED_EXTENSIONS]
        : null;

  return {
    defaultSettings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      ...customSettings,
    },
    ...(extensions && { recommendedExtensions: extensions }),
  };
}
