/**
 * Utility functions for OpenCode session operations.
 * Extracted for reuse by OpenCodeProvider and CLI wrapper.
 */

import { Path } from "../../services/platform/path";
import type { Session } from "./types";

/**
 * Find the most recent matching session for a directory.
 *
 * Filters by:
 * - Directory match (using Path comparison for cross-platform)
 * - Excludes sub-agent sessions (those with parentID)
 * - Returns most recently updated session
 *
 * @param sessions - Array of sessions from OpenCode API
 * @param directory - Current working directory to match
 * @returns Most recent matching session or null
 */
export function findMatchingSession(sessions: Session[], directory: string): Session | null {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  // Create a Path object for the target directory
  let targetPath: Path;
  try {
    targetPath = new Path(directory);
  } catch {
    // Invalid directory path - no match possible
    return null;
  }

  // Filter and find matching sessions
  const matching = sessions.filter((session) => {
    // Exclude sub-agent sessions (have parentID)
    if (session.parentID !== null && session.parentID !== undefined) {
      return false;
    }

    // Match directory using Path.equals() for cross-platform comparison
    if (!session.directory) {
      return false;
    }

    return targetPath.equals(session.directory);
  });

  if (matching.length === 0) {
    return null;
  }

  // Sort by time.updated descending (most recent first)
  // Missing time.updated is treated as 0
  matching.sort((a, b) => {
    const timeA = a.time?.updated ?? 0;
    const timeB = b.time?.updated ?? 0;
    return timeB - timeA;
  });

  return matching[0] ?? null;
}
