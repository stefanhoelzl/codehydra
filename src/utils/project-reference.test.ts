/**
 * Focused tests for reading a project target.
 *
 * `ch project open` takes one argument and works out what it is, so the cost of
 * a wrong guess is high: mistaking a directory for a repository would clone
 * something, and mistaking a repository for a directory would fail confusingly.
 */

import { describe, it, expect } from "vitest";
import {
  looksLikeGitUrl,
  looksLikeProjectPath,
  matchOpenProject,
  resolveLocalPath,
} from "./project-reference";

describe("looksLikeGitUrl", () => {
  it("recognizes a url with a scheme", () => {
    expect(looksLikeGitUrl("https://github.com/org/repo.git")).toBe(true);
    expect(looksLikeGitUrl("ssh://git@github.com/org/repo")).toBe(true);
  });

  it("recognizes the scp-style form git accepts", () => {
    expect(looksLikeGitUrl("git@github.com:org/repo.git")).toBe(true);
  });

  it("recognizes the org/repo shorthand", () => {
    expect(looksLikeGitUrl("org/repo")).toBe(true);
    expect(looksLikeGitUrl("my-org/my.repo")).toBe(true);
  });

  it("treats an absolute path as local", () => {
    expect(looksLikeGitUrl("/home/me/projects/repo")).toBe(false);
  });

  it("treats an explicitly relative path as local", () => {
    // The case someone types most: open the repository they are standing in.
    expect(looksLikeGitUrl(".")).toBe(false);
    expect(looksLikeGitUrl("./repo")).toBe(false);
    expect(looksLikeGitUrl("../sibling/repo")).toBe(false);
  });

  it("does not mistake a deeper relative path for a shorthand", () => {
    // The shorthand is exactly two segments; three is a directory.
    expect(looksLikeGitUrl("src/api/entries")).toBe(false);
  });

  it("does not mistake a parent-relative pair for a shorthand", () => {
    expect(looksLikeGitUrl("../repo")).toBe(false);
  });

  it("still reads a bare two-segment path as a shorthand", () => {
    // Genuinely ambiguous: `org/repo` and `dir/subdir` look identical. The
    // shorthand wins because that is what someone means by `project open`, and
    // --git's counterpart is writing `./dir/subdir`.
    expect(looksLikeGitUrl("dir/subdir")).toBe(true);
  });
});

describe("resolveLocalPath", () => {
  it("resolves a relative target against the caller's directory", () => {
    expect(resolveLocalPath(".", "/home/me/repo")).toBe("/home/me/repo");
    expect(resolveLocalPath("../other", "/home/me/repo")).toBe("/home/me/other");
  });

  it("leaves an absolute target alone", () => {
    expect(resolveLocalPath("/srv/repo", "/home/me")).toBe("/srv/repo");
  });

  it("returns a relative target unchanged when there is no directory to resolve against", () => {
    // An in-app caller has no working directory; reporting the value the caller
    // gave beats inventing one from the app's own cwd.
    expect(resolveLocalPath("./repo", null)).toBe("./repo");
  });
});

describe("matchOpenProject", () => {
  const PROJECTS = [
    { name: "ohi", path: "/home/me/ohi" },
    { name: "dup", path: "/a/dup" },
    { name: "dup", path: "/b/dup" },
  ];

  it("matches an open project by name", () => {
    expect(matchOpenProject(PROJECTS, "ohi")).toEqual({ path: "/home/me/ohi" });
  });

  it("declines a name that matches nothing, so the caller can open it", () => {
    // Not an error: the reference may name a project that simply is not open.
    expect(matchOpenProject(PROJECTS, "unopened")).toBeUndefined();
  });

  it("declines a path, which the caller opens directly", () => {
    expect(matchOpenProject(PROJECTS, "/somewhere/else")).toBeUndefined();
  });

  it("declines a git url, which the caller clones", () => {
    expect(matchOpenProject(PROJECTS, "https://github.com/org/repo")).toBeUndefined();
  });

  it("reports an ambiguous name rather than guessing", () => {
    const result = matchOpenProject(PROJECTS, "dup");
    expect((result as { error: string }).error).toContain("2 open projects");
  });
});

describe("looksLikeProjectPath", () => {
  it("separates a location from a name", () => {
    expect(looksLikeProjectPath("/home/me/ohi")).toBe(true);
    expect(looksLikeProjectPath("ohi")).toBe(false);
  });
});
