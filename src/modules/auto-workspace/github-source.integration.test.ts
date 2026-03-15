// @vitest-environment node

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { createMockProcessRunner } from "../../boundaries/platform/process/process.state-mock";
import { createMockHttpClient } from "../../boundaries/platform/network/http-client.state-mock";
import type { ConfigService } from "../../boundaries/platform/config/config-service";
import type { ConfigKeyDefinition } from "../../boundaries/platform/config/config-definition";
import { createGitHubSource } from "./github-source";

function createMockConfigService(values?: Record<string, unknown>): ConfigService {
  const store = new Map<string, unknown>(Object.entries(values ?? {}));
  return {
    register: (_key: string, def: ConfigKeyDefinition<unknown>) => {
      if (!store.has(def.name)) store.set(def.name, def.default);
    },
    load: () => {},
    get: (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getDefinitions: () => new Map(),
    getEffective: () => Object.fromEntries(store),
  };
}

// =============================================================================
// GitHub API Response Helpers
// =============================================================================

function searchResponse(
  items: Array<{
    number: number;
    htmlUrl: string;
    repositoryUrl: string;
  }>
): string {
  return JSON.stringify({
    items: items.map((item) => ({
      number: item.number,
      html_url: item.htmlUrl,
      pull_request: { html_url: item.htmlUrl },
      repository_url: item.repositoryUrl,
    })),
  });
}

function prDetailResponse(headRef: string, baseRef: string): string {
  return JSON.stringify({
    number: 42,
    title: "Add login feature",
    body: "This PR adds a login feature with OAuth support.",
    html_url: "https://github.com/org/repo/pull/42",
    head: { ref: headRef, sha: "abc123" },
    base: { ref: baseRef, sha: "def456" },
    user: { login: "johndoe", id: 12345 },
    draft: false,
    labels: [{ name: "enhancement" }],
  });
}

function repoDetailResponse(cloneUrl: string): string {
  return JSON.stringify({ clone_url: cloneUrl });
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_QUERY = "is:open is:pr review-requested:@me";

function searchUrl(query: string = DEFAULT_QUERY): string {
  return `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=100`;
}

const SEARCH_URL = searchUrl();
const PR_DETAIL_URL = "https://api.github.com/repos/org/repo/pulls/42";
const REPO_DETAIL_URL = "https://api.github.com/repos/org/repo";

// =============================================================================
// Tests
// =============================================================================

describe("GitHubSource", () => {
  function createSource(options?: { ghAuthFails?: boolean; query?: string }) {
    const processRunner = createMockProcessRunner({
      onSpawn: (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          if (options?.ghAuthFails) {
            return { exitCode: 1, stderr: "not logged in" };
          }
          return { exitCode: 0, stdout: "ghp_test_token_123\n" };
        }
        return {};
      },
    });

    const httpClient = createMockHttpClient();
    const configService = createMockConfigService({
      "experimental.github.query": options?.query ?? DEFAULT_QUERY,
    });
    const source = createGitHubSource({
      processRunner,
      httpClient,
      logger: SILENT_LOGGER,
      configService,
    });

    return { source, httpClient, processRunner };
  }

  describe("initialization", () => {
    it("returns true when gh auth succeeds", async () => {
      const { source } = createSource();
      expect(await source.initialize()).toBe(true);
    });

    it("returns false when gh auth fails", async () => {
      const { source } = createSource({ ghAuthFails: true });
      expect(await source.initialize()).toBe(false);
    });
  });

  describe("isConfigured", () => {
    it("returns true when query has default value", () => {
      const { source } = createSource();
      expect(source.isConfigured()).toBe(true);
    });
  });

  describe("poll", () => {
    it("returns empty result when search returns no items", async () => {
      const { source, httpClient } = createSource();
      await source.initialize();

      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      const result = await source.poll(new Set());

      expect(result.activeKeys.size).toBe(0);
      expect(result.newItems).toHaveLength(0);
    });

    it("returns new items for PRs not in trackedKeys", async () => {
      const { source, httpClient } = createSource();
      await source.initialize();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, {
        body: prDetailResponse("feature-login", "main"),
      });
      httpClient.setResponse(REPO_DETAIL_URL, {
        body: repoDetailResponse("https://github.com/org/repo.git"),
      });

      const result = await source.poll(new Set());

      expect(result.activeKeys).toEqual(new Set(["https://github.com/org/repo/pull/42"]));
      expect(result.newItems).toHaveLength(1);
      expect(result.newItems[0]!.key).toBe("https://github.com/org/repo/pull/42");
      expect(result.newItems[0]!.url).toBe("https://github.com/org/repo/pull/42");
      expect(result.newItems[0]!.data).toHaveProperty(
        "clone_url",
        "https://github.com/org/repo.git"
      );
    });

    it("skips detail fetches for already-tracked PRs", async () => {
      const { source, httpClient } = createSource();
      await source.initialize();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      const result = await source.poll(new Set(["https://github.com/org/repo/pull/42"]));

      expect(result.activeKeys).toEqual(new Set(["https://github.com/org/repo/pull/42"]));
      expect(result.newItems).toHaveLength(0);
      expect(httpClient).not.toHaveRequested(PR_DETAIL_URL);
      expect(httpClient).not.toHaveRequested(REPO_DETAIL_URL);
    });

    it("skips PR when detail fetch fails", async () => {
      const { source, httpClient } = createSource();
      await source.initialize();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, { status: 404 });

      const result = await source.poll(new Set());

      expect(result.activeKeys).toEqual(new Set(["https://github.com/org/repo/pull/42"]));
      expect(result.newItems).toHaveLength(0);
    });

    it("uses configured query in search URL", async () => {
      const customQuery = "is:open is:pr reviewed-by:@me";
      const { source, httpClient } = createSource({ query: customQuery });
      await source.initialize();

      const customSearchUrl = searchUrl(customQuery);
      httpClient.setResponse(customSearchUrl, { body: searchResponse([]) });

      const result = await source.poll(new Set());

      expect(result.activeKeys.size).toBe(0);
      expect(httpClient).toHaveRequested(customSearchUrl);
      expect(httpClient).not.toHaveRequested(SEARCH_URL);
    });

    it("returns empty on search API failure", async () => {
      const { source, httpClient } = createSource();
      await source.initialize();

      httpClient.setResponse(SEARCH_URL, { status: 403, body: "rate limited" });

      const result = await source.poll(new Set());

      expect(result.activeKeys.size).toBe(0);
      expect(result.newItems).toHaveLength(0);
    });
  });
});
