import type { ProcessRunner } from "../../boundaries/platform/process";
import type { HttpClient } from "../../boundaries/platform/network";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import { configString } from "../../boundaries/platform/config-definition";
import type { AutoWorkspaceSource, PollResult, PollItem } from "./source";
import { getErrorMessage } from "../../shared/error-utils";

// =============================================================================
// GitHub API Types (minimal)
// =============================================================================

interface GitHubSearchResponse {
  readonly items: readonly GitHubSearchItem[];
}

interface GitHubSearchItem {
  readonly number: number;
  readonly html_url: string;
  readonly pull_request?: { readonly html_url: string };
  readonly repository_url: string;
}

interface GitHubRepoDetail {
  readonly clone_url: string;
}

// =============================================================================
// Constants
// =============================================================================

const GITHUB_API_BASE = "https://api.github.com";

const CONFIG_KEYS = {
  query: "experimental.github.query",
} as const;

// =============================================================================
// Helpers
// =============================================================================

function repoFromApiUrl(repositoryUrl: string): string {
  const parts = repositoryUrl.split("/repos/");
  return parts[1] ?? repositoryUrl;
}

// =============================================================================
// Source Factory
// =============================================================================

export interface GitHubSourceDeps {
  readonly processRunner: ProcessRunner;
  readonly httpClient: HttpClient;
  readonly logger: Logger;
  readonly configService: Config;
}

export function createGitHubSource(deps: GitHubSourceDeps): AutoWorkspaceSource {
  const queryConfig = deps.configService.register(CONFIG_KEYS.query, {
    default: "is:open is:pr review-requested:@me",
    description: "GitHub search query (e.g. is:open is:pr review-requested:@me)",
    ...configString(),
  });

  let token: string | null = null;

  function githubHeaders(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async function fetchSearchResults(): Promise<GitHubSearchItem[]> {
    const query = encodeURIComponent(queryConfig.get());
    const url = `${GITHUB_API_BASE}/search/issues?q=${query}&sort=created&order=desc&per_page=100`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      throw new Error(`GitHub search API returned ${response.status}`);
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return [...data.items];
  }

  async function fetchPrDetail(
    repo: string,
    prNumber: number
  ): Promise<Record<string, unknown> | null> {
    const url = `${GITHUB_API_BASE}/repos/${repo}/pulls/${prNumber}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("GitHub PR detail API returned non-OK", {
        repo,
        prNumber,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async function fetchRepoDetail(repo: string): Promise<GitHubRepoDetail | null> {
    const url = `${GITHUB_API_BASE}/repos/${repo}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("GitHub repo detail API returned non-OK", {
        repo,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as GitHubRepoDetail;
  }

  return {
    name: "github",
    fetchBasesBeforeDelete: true,

    isConfigured(): boolean {
      return queryConfig.get() !== null;
    },

    async initialize(): Promise<boolean> {
      try {
        const proc = deps.processRunner.run("gh", ["auth", "token"]);
        const result = await proc.wait(5000);
        if (result.exitCode !== 0) {
          deps.logger.warn("gh auth token failed — github source disabled", {
            exitCode: result.exitCode ?? -1,
            stderr: result.stderr.slice(0, 200),
          });
          return false;
        }
        token = result.stdout.trim();
        return true;
      } catch (error) {
        deps.logger.warn("gh auth token threw — github source disabled", {
          error: getErrorMessage(error),
        });
        return false;
      }
    },

    async poll(trackedKeys: ReadonlySet<string>): Promise<PollResult> {
      const items = await fetchSearchResults();

      const activeKeys = new Set<string>();
      const newItems: PollItem[] = [];

      for (const item of items) {
        const prUrl = item.pull_request?.html_url ?? item.html_url;
        activeKeys.add(prUrl);

        if (trackedKeys.has(prUrl)) continue;

        // New PR — fetch details
        const repo = repoFromApiUrl(item.repository_url);
        const prDetail = await fetchPrDetail(repo, item.number);
        if (!prDetail) continue;

        const head = prDetail.head as { ref?: string } | undefined;
        const base = prDetail.base as { ref?: string } | undefined;
        if (!head?.ref || !base?.ref) continue;

        const repoDetail = await fetchRepoDetail(repo);
        if (!repoDetail) continue;

        newItems.push({
          key: prUrl,
          url: prUrl,
          data: { ...prDetail, clone_url: repoDetail.clone_url },
        });
      }

      return { activeKeys, newItems };
    },

    dispose(): void {
      token = null;
    },
  };
}
