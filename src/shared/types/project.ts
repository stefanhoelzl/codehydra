/**
 * Project-related type definitions.
 * All properties are readonly for immutability.
 */

/**
 * Configuration stored for a project.
 */
export interface ProjectConfig {
  /** Absolute path to the project directory */
  readonly path: string;
  /** Original git remote URL if project was cloned from URL */
  readonly remoteUrl?: string;
}
