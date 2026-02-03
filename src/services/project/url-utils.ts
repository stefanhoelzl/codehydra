/**
 * URL utilities for git remote URL handling.
 *
 * Provides URL normalization and project ID generation from URLs.
 */

import * as crypto from "node:crypto";
import type { ProjectId } from "../../shared/api/types";

/**
 * Normalize a git remote URL to a canonical form for comparison.
 *
 * Normalization rules:
 * - Lowercase hostname
 * - Remove protocol (https://, git://, ssh://)
 * - Remove user credentials (user:pass@)
 * - Remove .git suffix
 * - Remove trailing slashes
 * - Convert SSH format (git@host:path) to standard format (host/path)
 * - Preserve port numbers
 *
 * @param url Git remote URL (HTTPS, SSH, or git:// format)
 * @returns Normalized URL string
 *
 * @example
 * normalizeGitUrl("https://GitHub.com/Org/Repo.git") // "github.com/org/repo"
 * normalizeGitUrl("git@github.com:Org/Repo.git") // "github.com/org/repo"
 * normalizeGitUrl("https://user:pass@github.com/org/repo.git") // "github.com/org/repo"
 * normalizeGitUrl("https://github.com:443/org/repo.git") // "github.com:443/org/repo"
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.trim();

  // First, try to handle URL format (https://, git://, ssh://)
  // These have :// in them which distinguishes from SSH git@host:path format
  if (/^[a-z]+:\/\//i.test(normalized)) {
    try {
      // Try to parse as URL
      const parsed = new URL(normalized);

      // Extract host (lowercase)
      let host = parsed.hostname.toLowerCase();

      // Include port if non-standard
      if (parsed.port) {
        host = `${host}:${parsed.port}`;
      }

      // Get path and normalize
      let path = parsed.pathname;

      // Remove leading slashes
      path = path.replace(/^\/+/, "");

      // Remove .git suffix
      if (path.endsWith(".git")) {
        path = path.slice(0, -4);
      }

      // Remove trailing slashes
      path = path.replace(/\/+$/, "");

      // Lowercase the path for case-insensitive comparison
      return `${host}/${path.toLowerCase()}`;
    } catch {
      // If URL parsing fails, fall through to simple path handling
    }
  }

  // Handle SSH format: git@host:path -> host/path
  // This regex matches patterns like:
  // - git@github.com:org/repo.git
  // - user@gitlab.com:group/project
  const sshMatch = normalized.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    // SSH format detected (git@host:path)
    const host = sshMatch[1].toLowerCase();
    let path = sshMatch[2];

    // Remove .git suffix
    if (path.endsWith(".git")) {
      path = path.slice(0, -4);
    }

    // Remove trailing slashes
    path = path.replace(/\/+$/, "");

    // Lowercase the path for case-insensitive comparison
    return `${host}/${path.toLowerCase()}`;
  }

  // Fallback: try to handle as a simple path
  // Remove any protocol-like prefix
  normalized = normalized.replace(/^[a-z]+:\/\//i, "");

  // Remove credentials
  normalized = normalized.replace(/^[^@]+@/, "");

  // Remove .git suffix
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }

  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, "");

  return normalized.toLowerCase();
}

/**
 * Extract a human-readable name from a git URL.
 * Returns the repository name (last path segment).
 *
 * @param url Git remote URL
 * @returns Repository name
 *
 * @example
 * extractRepoName("https://github.com/org/my-repo.git") // "my-repo"
 * extractRepoName("git@github.com:org/my-repo.git") // "my-repo"
 */
export function extractRepoName(url: string): string {
  const normalized = normalizeGitUrl(url);
  const segments = normalized.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "repo";
}

/**
 * Generate a deterministic ProjectId from a git remote URL.
 *
 * The ID format is: `<repo-name>-<8-char-hex-hash>`
 * - repo-name: Repository name extracted from URL
 * - hash: first 8 characters of SHA-256 hash of normalized URL
 *
 * @param url Git remote URL
 * @returns A deterministic ProjectId
 *
 * @example
 * generateProjectIdFromUrl("https://github.com/org/my-repo.git") // "my-repo-abcd1234"
 * // Same URL variants produce same ID:
 * generateProjectIdFromUrl("git@github.com:org/my-repo.git") // "my-repo-abcd1234"
 */
export function generateProjectIdFromUrl(url: string): ProjectId {
  const normalized = normalizeGitUrl(url);
  const repoName = extractRepoName(url);

  // Create safe name:
  // 1. Replace non-alphanumeric characters with dashes
  // 2. Collapse consecutive dashes
  // 3. Remove leading/trailing dashes
  // 4. Use "repo" as fallback for empty result
  const safeName =
    repoName
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "repo";

  // Generate hash from normalized URL
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);

  return `${safeName}-${hash}` as ProjectId;
}

/**
 * Expand shorthand git URLs to full URLs.
 *
 * Supports:
 * - Full URLs (returned as-is): "https://github.com/org/repo.git"
 * - GitHub shorthand: "org/repo" -> "https://github.com/org/repo.git"
 * - Partial URLs: "github.com/org/repo" -> "https://github.com/org/repo.git"
 *
 * @param input User input (may be shorthand or full URL)
 * @returns Expanded URL (may still be invalid if input is malformed)
 *
 * @example
 * expandGitUrl("org/repo") // "https://github.com/org/repo.git"
 * expandGitUrl("github.com/org/repo") // "https://github.com/org/repo.git"
 * expandGitUrl("https://github.com/org/repo") // "https://github.com/org/repo.git"
 * expandGitUrl("git@github.com:org/repo.git") // "git@github.com:org/repo.git" (unchanged)
 */
export function expandGitUrl(input: string): string {
  const trimmed = input.trim();

  // Already a full URL - return as-is
  if (isValidGitUrl(trimmed)) {
    return trimmed;
  }

  // Shorthand: org/repo (no dots in first segment, no protocol)
  // e.g., "stefanhoelzl/codehydra" -> "https://github.com/stefanhoelzl/codehydra.git"
  const shorthandMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthandMatch && shorthandMatch[1] && shorthandMatch[2]) {
    return `https://github.com/${shorthandMatch[1]}/${shorthandMatch[2]}.git`;
  }

  // Partial URL: github.com/org/repo (domain without protocol)
  // e.g., "github.com/org/repo" -> "https://github.com/org/repo.git"
  if (/^[a-z0-9.-]+\/[^\s]+$/i.test(trimmed) && trimmed.includes(".")) {
    const withProtocol = `https://${trimmed}`;
    // Add .git suffix if not present
    return withProtocol.endsWith(".git") ? withProtocol : `${withProtocol}.git`;
  }

  // Unknown format - return as-is (will fail validation)
  return trimmed;
}

/**
 * Validate that a string looks like a git URL.
 * Supports HTTPS, SSH, and git:// protocols.
 *
 * @param url String to validate
 * @returns true if the string appears to be a valid git URL
 *
 * @example
 * isValidGitUrl("https://github.com/org/repo.git") // true
 * isValidGitUrl("git@github.com:org/repo.git") // true
 * isValidGitUrl("not-a-url") // false
 */
export function isValidGitUrl(url: string): boolean {
  const trimmed = url.trim();

  // Check for HTTPS/HTTP/GIT protocol
  if (/^https?:\/\/[^\s]+/.test(trimmed)) {
    return true;
  }

  // Check for git:// protocol
  if (/^git:\/\/[^\s]+/.test(trimmed)) {
    return true;
  }

  // Check for SSH format (git@host:path or user@host:path)
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+/.test(trimmed)) {
    return true;
  }

  // Check for ssh:// protocol
  if (/^ssh:\/\/[^\s]+/.test(trimmed)) {
    return true;
  }

  return false;
}
