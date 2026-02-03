/**
 * Focused tests for URL normalization utilities.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeGitUrl,
  extractRepoName,
  generateProjectIdFromUrl,
  isValidGitUrl,
  expandGitUrl,
} from "./url-utils";

describe("normalizeGitUrl", () => {
  it("normalizes HTTPS URLs", () => {
    expect(normalizeGitUrl("https://GitHub.com/Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("normalizes SSH URLs", () => {
    expect(normalizeGitUrl("git@github.com:Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("strips user credentials from HTTPS URLs", () => {
    expect(normalizeGitUrl("https://user:pass@github.com/org/repo.git")).toBe(
      "github.com/org/repo"
    );
  });

  it("preserves non-default port numbers", () => {
    // Note: Default ports (443 for HTTPS, 80 for HTTP) are stripped by URL API
    expect(normalizeGitUrl("https://github.com:8443/org/repo.git")).toBe(
      "github.com:8443/org/repo"
    );
  });

  it("removes trailing slashes", () => {
    expect(normalizeGitUrl("https://github.com/org/repo/")).toBe("github.com/org/repo");
  });

  it("removes .git suffix", () => {
    expect(normalizeGitUrl("https://github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  it("handles URLs without .git suffix", () => {
    expect(normalizeGitUrl("https://github.com/org/repo")).toBe("github.com/org/repo");
  });

  it("normalizes case for hostname and path", () => {
    expect(normalizeGitUrl("https://GITHUB.COM/ORG/REPO.git")).toBe("github.com/org/repo");
  });

  it("handles ssh:// protocol", () => {
    expect(normalizeGitUrl("ssh://git@github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  it("handles git:// protocol", () => {
    expect(normalizeGitUrl("git://github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  it("handles complex paths", () => {
    expect(normalizeGitUrl("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "gitlab.com/group/subgroup/repo"
    );
  });
});

describe("extractRepoName", () => {
  it("extracts repo name from HTTPS URL", () => {
    expect(extractRepoName("https://github.com/org/my-repo.git")).toBe("my-repo");
  });

  it("extracts repo name from SSH URL", () => {
    expect(extractRepoName("git@github.com:org/my-repo.git")).toBe("my-repo");
  });

  it("handles nested paths", () => {
    expect(extractRepoName("https://gitlab.com/group/subgroup/repo.git")).toBe("repo");
  });
});

describe("generateProjectIdFromUrl", () => {
  it("generates a ProjectId from URL", () => {
    const id = generateProjectIdFromUrl("https://github.com/org/my-repo.git");
    expect(id).toMatch(/^my-repo-[a-f0-9]{8}$/);
  });

  it("generates consistent IDs for equivalent URLs", () => {
    const httpsId = generateProjectIdFromUrl("https://github.com/org/my-repo.git");
    const sshId = generateProjectIdFromUrl("git@github.com:org/my-repo.git");
    expect(httpsId).toBe(sshId);
  });

  it("generates different IDs for different URLs", () => {
    const id1 = generateProjectIdFromUrl("https://github.com/org/repo-a.git");
    const id2 = generateProjectIdFromUrl("https://github.com/org/repo-b.git");
    expect(id1).not.toBe(id2);
  });

  it("handles repo names with special characters", () => {
    const id = generateProjectIdFromUrl("https://github.com/org/my.cool-repo.git");
    expect(id).toMatch(/^my-cool-repo-[a-f0-9]{8}$/);
  });
});

describe("isValidGitUrl", () => {
  it("validates HTTPS URLs", () => {
    expect(isValidGitUrl("https://github.com/org/repo.git")).toBe(true);
    expect(isValidGitUrl("http://github.com/org/repo.git")).toBe(true);
  });

  it("validates SSH URLs", () => {
    expect(isValidGitUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isValidGitUrl("user@gitlab.com:group/repo.git")).toBe(true);
  });

  it("validates git:// URLs", () => {
    expect(isValidGitUrl("git://github.com/org/repo.git")).toBe(true);
  });

  it("validates ssh:// URLs", () => {
    expect(isValidGitUrl("ssh://git@github.com/org/repo.git")).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(isValidGitUrl("not-a-url")).toBe(false);
    expect(isValidGitUrl("just-text")).toBe(false);
    expect(isValidGitUrl("")).toBe(false);
    expect(isValidGitUrl("   ")).toBe(false);
  });

  it("handles URLs with whitespace", () => {
    expect(isValidGitUrl("  https://github.com/org/repo.git  ")).toBe(true);
  });
});

describe("expandGitUrl", () => {
  it("returns full HTTPS URLs unchanged", () => {
    expect(expandGitUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("returns full SSH URLs unchanged", () => {
    expect(expandGitUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });

  it("expands org/repo shorthand to GitHub URL", () => {
    expect(expandGitUrl("stefanhoelzl/codehydra")).toBe(
      "https://github.com/stefanhoelzl/codehydra.git"
    );
  });

  it("expands partial URL with domain to full URL", () => {
    expect(expandGitUrl("github.com/org/repo")).toBe("https://github.com/org/repo.git");
  });

  it("expands gitlab.com partial URL", () => {
    expect(expandGitUrl("gitlab.com/group/project")).toBe("https://gitlab.com/group/project.git");
  });

  it("does not double-add .git suffix", () => {
    expect(expandGitUrl("github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("handles HTTPS URL without .git suffix", () => {
    expect(expandGitUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("handles whitespace", () => {
    expect(expandGitUrl("  org/repo  ")).toBe("https://github.com/org/repo.git");
  });

  it("returns invalid input unchanged for validation to catch", () => {
    expect(expandGitUrl("not-valid")).toBe("not-valid");
  });

  it("handles repo names with dots", () => {
    expect(expandGitUrl("org/my.repo")).toBe("https://github.com/org/my.repo.git");
  });

  it("handles repo names with hyphens and underscores", () => {
    expect(expandGitUrl("org/my-cool_repo")).toBe("https://github.com/org/my-cool_repo.git");
  });
});
