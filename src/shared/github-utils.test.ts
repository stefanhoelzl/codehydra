/**
 * Focused tests for GitHub URL utilities.
 */

import { describe, it, expect } from "vitest";
import { extractGitHubOwnerRepo, buildGitHubNewRepoUrl } from "./github-utils";

describe("extractGitHubOwnerRepo", () => {
  describe("shorthand format", () => {
    it("extracts from org/repo shorthand", () => {
      expect(extractGitHubOwnerRepo("org/repo")).toEqual({ owner: "org", repo: "repo" });
    });

    it("handles hyphens and underscores in owner and repo", () => {
      expect(extractGitHubOwnerRepo("my-org/my_repo")).toEqual({
        owner: "my-org",
        repo: "my_repo",
      });
    });

    it("handles dots in repo name", () => {
      expect(extractGitHubOwnerRepo("org/my.repo")).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("strips .git suffix from shorthand", () => {
      expect(extractGitHubOwnerRepo("org/repo.git")).toEqual({ owner: "org", repo: "repo" });
    });
  });

  describe("HTTPS format", () => {
    it("extracts from full HTTPS URL", () => {
      expect(extractGitHubOwnerRepo("https://github.com/org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("extracts from HTTPS URL without .git suffix", () => {
      expect(extractGitHubOwnerRepo("https://github.com/org/repo")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("handles HTTP protocol", () => {
      expect(extractGitHubOwnerRepo("http://github.com/org/repo")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("handles mixed case hostname", () => {
      expect(extractGitHubOwnerRepo("https://GitHub.COM/org/repo")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("handles trailing slash", () => {
      expect(extractGitHubOwnerRepo("https://github.com/org/repo/")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });
  });

  describe("SSH format", () => {
    it("extracts from git@github.com:org/repo.git", () => {
      expect(extractGitHubOwnerRepo("git@github.com:org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("extracts from SSH without .git suffix", () => {
      expect(extractGitHubOwnerRepo("git@github.com:org/repo")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("handles custom SSH user", () => {
      expect(extractGitHubOwnerRepo("user@github.com:org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });
  });

  describe("SSH protocol format", () => {
    it("extracts from ssh://git@github.com/org/repo.git", () => {
      expect(extractGitHubOwnerRepo("ssh://git@github.com/org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });
  });

  describe("git protocol format", () => {
    it("extracts from git://github.com/org/repo.git", () => {
      expect(extractGitHubOwnerRepo("git://github.com/org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });
  });

  describe("partial URL format", () => {
    it("extracts from github.com/org/repo", () => {
      expect(extractGitHubOwnerRepo("github.com/org/repo")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });

    it("extracts from github.com/org/repo.git", () => {
      expect(extractGitHubOwnerRepo("github.com/org/repo.git")).toEqual({
        owner: "org",
        repo: "repo",
      });
    });
  });

  describe("non-GitHub URLs", () => {
    it("returns null for GitLab HTTPS URL", () => {
      expect(extractGitHubOwnerRepo("https://gitlab.com/org/repo.git")).toBeNull();
    });

    it("returns null for GitLab SSH URL", () => {
      expect(extractGitHubOwnerRepo("git@gitlab.com:org/repo.git")).toBeNull();
    });

    it("returns null for Bitbucket URL", () => {
      expect(extractGitHubOwnerRepo("https://bitbucket.org/org/repo.git")).toBeNull();
    });

    it("returns null for custom domain partial URL", () => {
      expect(extractGitHubOwnerRepo("gitlab.com/org/repo")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(extractGitHubOwnerRepo("")).toBeNull();
    });

    it("returns null for whitespace", () => {
      expect(extractGitHubOwnerRepo("   ")).toBeNull();
    });

    it("returns null for plain text", () => {
      expect(extractGitHubOwnerRepo("not-a-url")).toBeNull();
    });

    it("handles leading and trailing whitespace", () => {
      expect(extractGitHubOwnerRepo("  org/repo  ")).toEqual({ owner: "org", repo: "repo" });
    });

    it("returns null for GitHub URL with only owner (no repo)", () => {
      expect(extractGitHubOwnerRepo("https://github.com/org")).toBeNull();
    });
  });
});

describe("buildGitHubNewRepoUrl", () => {
  it("builds URL with owner and name params", () => {
    expect(buildGitHubNewRepoUrl("org", "repo")).toBe("https://github.com/new?owner=org&name=repo");
  });

  it("encodes special characters", () => {
    const url = buildGitHubNewRepoUrl("my org", "my repo");
    expect(url).toContain("owner=my+org");
    expect(url).toContain("name=my+repo");
  });
});
