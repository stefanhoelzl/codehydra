/**
 * Project-related type definitions.
 * All properties are readonly for immutability.
 */

/**
 * Configuration stored for a project.
 * Version field allows for future migrations.
 */
export interface ProjectConfig {
  /** Schema version for migrations */
  readonly version: number;
  /** Absolute path to the project directory */
  readonly path: string;
  /** Original git remote URL if project was cloned from URL */
  readonly remoteUrl?: string;
}

/**
 * Current schema version for ProjectConfig.
 * Version 2: Added optional remoteUrl field for cloned projects.
 */
export const CURRENT_PROJECT_VERSION = 2;
