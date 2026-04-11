/**
 * GitHub-specific URL utilities.
 *
 * Used by the renderer to detect GitHub URLs and build repo creation links.
 * Self-contained — no dependency on src/utils/url-utils.ts (not importable from renderer).
 */

interface GitHubOwnerRepo {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Extract the GitHub owner and repo name from a user-provided URL or shorthand.
 *
 * Returns null for non-GitHub URLs or unrecognizable input.
 *
 * @example
 * extractGitHubOwnerRepo("org/repo") // { owner: "org", repo: "repo" }
 * extractGitHubOwnerRepo("github.com/org/repo") // { owner: "org", repo: "repo" }
 * extractGitHubOwnerRepo("https://github.com/org/repo.git") // { owner: "org", repo: "repo" }
 * extractGitHubOwnerRepo("git@github.com:org/repo.git") // { owner: "org", repo: "repo" }
 * extractGitHubOwnerRepo("https://gitlab.com/org/repo") // null
 */
export function extractGitHubOwnerRepo(input: string): GitHubOwnerRepo | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Shorthand: org/repo (no dots in first segment, no protocol, no @)
  const shorthandMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1]!, repo: stripGitSuffix(shorthandMatch[2]!) };
  }

  // SSH format: git@github.com:org/repo.git
  const sshMatch = trimmed.match(/^[^@]+@([^:/]+):([^/]+)\/([^/]+)$/);
  if (sshMatch && isGitHubHost(sshMatch[1]!)) {
    return { owner: sshMatch[2]!, repo: stripGitSuffix(sshMatch[3]!) };
  }

  // URL formats: https://github.com/org/repo, ssh://git@github.com/org/repo, git://github.com/org/repo
  // Also partial: github.com/org/repo
  try {
    const urlString = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(urlString);
    if (!isGitHubHost(parsed.hostname)) return null;

    const segments = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter((s) => s.length > 0);

    if (segments.length >= 2) {
      return { owner: segments[0]!, repo: stripGitSuffix(segments[1]!) };
    }
  } catch {
    // Not a parseable URL
  }

  return null;
}

/**
 * Build a GitHub "new repository" URL with pre-filled owner and name.
 *
 * @example
 * buildGitHubNewRepoUrl("org", "repo") // "https://github.com/new?owner=org&name=repo"
 */
export function buildGitHubNewRepoUrl(owner: string, repo: string): string {
  const params = new URLSearchParams({ owner, name: repo });
  return `https://github.com/new?${params.toString()}`;
}

function isGitHubHost(hostname: string): boolean {
  return hostname.toLowerCase() === "github.com";
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}
