/**
 * Focused tests for how the git project type names its projects in a ref.
 */

import { describe, it, expect } from "vitest";
import { gitProjectIdentifier, gitProjectRef } from "./git-project-ref";

const isWindows = process.platform === "win32";

describe("gitProjectRef", () => {
  it("names a managed clone by its normalized origin", () => {
    expect(gitProjectRef("/data/remotes/x", "https://GitHub.com/Org/CodeHydra.git")).toBe(
      "ch::local::git::github.com/org/codehydra"
    );
  });

  it("gives the scp and https forms of one origin the same ref", () => {
    expect(gitProjectRef("/a", "git@github.com:org/repo.git")).toBe(
      gitProjectRef("/b", "https://github.com/org/repo")
    );
  });

  it("keeps a non-default port", () => {
    expect(gitProjectIdentifier("/a", "https://git.example.com:2222/org/repo.git")).toBe(
      "git.example.com:2222/org/repo"
    );
  });

  it.skipIf(isWindows)("names a checkout by its normalized path", () => {
    expect(gitProjectRef("/home/s/proj/")).toBe("ch::local::git::/home/s/proj");
  });
});
