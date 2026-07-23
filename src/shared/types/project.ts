/**
 * Project-related type definitions.
 * All properties are readonly for immutability.
 */

import type { ProjectPath } from "../../intents/contract";

/**
 * Configuration stored for a project.
 */
export interface ProjectConfig {
  /**
   * Absolute path to the project directory.
   *
   * Branded: this config is read back from JSON on disk, which is one of the few places an
   * unvalidated string genuinely enters the system, so the loader mints the brand by parsing.
   */
  readonly path: ProjectPath;
  /** Original git remote URL if project was cloned from URL */
  readonly remoteUrl?: string;
}
