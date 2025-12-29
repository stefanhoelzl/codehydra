/**
 * Shared ID generation utilities for CodeHydra.
 *
 * This module provides deterministic ID generation for projects.
 * It's shared between main process and services to avoid duplication.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ProjectId, WorkspaceName } from "./types";

/**
 * Normalize a path to canonical form for consistent hashing.
 *
 * **Why this duplicates Path class logic:**
 * This module is in `shared/` which cannot import from `services/` because
 * `shared/` types are used by the renderer (browser environment) and must
 * not have Node.js service dependencies. The Path class in `services/platform/`
 * has the canonical implementation; this is a minimal duplicate for ID generation.
 *
 * Normalization rules:
 * - Convert backslashes to forward slashes (POSIX format)
 * - Collapse multiple slashes
 * - Remove trailing slashes (except root)
 * - Lowercase on Windows (case-insensitive filesystem)
 *
 * This ensures the same path produces the same ID regardless of:
 * - Input format (C:\foo vs C:/foo)
 * - Case on Windows (C:\FOO vs C:\foo)
 */
function normalizePathForId(absolutePath: string): string {
  // Use path.normalize first to handle . and .. segments
  let normalized = path.normalize(absolutePath);

  // Convert to POSIX format (forward slashes)
  normalized = normalized.replace(/\\/g, "/");

  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, "/");

  // Remove trailing slash (except root)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Lowercase on Windows for case-insensitive matching
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

/**
 * Generate a deterministic ProjectId from an absolute path.
 *
 * The ID format is: `<safe-name>-<8-char-hex-hash>`
 * - safe-name: basename with special characters replaced by dashes
 * - hash: first 8 characters of SHA-256 hash of normalized path
 *
 * Path normalization ensures consistent IDs regardless of:
 * - Separator style (backslash vs forward slash)
 * - Case on Windows (C:\FOO produces same ID as C:\foo)
 *
 * @param absolutePath Absolute path to the project directory
 * @returns A deterministic ProjectId
 *
 * @example
 * ```typescript
 * generateProjectId("/home/user/projects/my-app") // "my-app-12345678"
 * generateProjectId("/home/user/My Cool App")     // "My-Cool-App-abcdef12"
 * // On Windows, these produce the same ID:
 * generateProjectId("C:\\Users\\Foo")  // same as C:/users/foo
 * generateProjectId("C:/users/foo")
 * ```
 */
export function generateProjectId(absolutePath: string): ProjectId {
  // Normalize the path for consistent hashing across formats and platforms
  const normalizedPath = normalizePathForId(absolutePath);

  // Get basename from normalized path (forward slash separator)
  const basename = normalizedPath.split("/").pop() ?? "";

  // Create safe name:
  // 1. Replace non-alphanumeric characters with dashes
  // 2. Collapse consecutive dashes
  // 3. Remove leading/trailing dashes
  // 4. Use "root" as fallback for empty result
  const safeName =
    basename
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root";

  // Generate hash from normalized path
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);

  return `${safeName}-${hash}` as ProjectId;
}

/**
 * Extract the workspace name from a workspace path.
 * The workspace name is the basename of the path.
 *
 * Handles both forward slashes and backslashes for cross-platform compatibility.
 *
 * @param workspacePath Absolute path to the workspace directory
 * @returns The workspace name (basename of the path)
 *
 * @example
 * ```typescript
 * extractWorkspaceName("/home/user/projects/.worktrees/feature-1") // "feature-1"
 * extractWorkspaceName("C:\\Users\\projects\\.worktrees\\feature-1") // "feature-1"
 * ```
 */
export function extractWorkspaceName(workspacePath: string): WorkspaceName {
  // Handle both forward and backward slashes
  const normalized = workspacePath.replace(/\\/g, "/");
  // Remove trailing slash if present
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  // Get basename (last segment)
  const lastSlash = trimmed.lastIndexOf("/");
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return basename as WorkspaceName;
}
