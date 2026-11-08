// @vitest-environment node
/**
 * Commit checkouts side by side: made once, removed once neither kept nor
 * leased, and a checkout cut short never passing for a finished one.
 */

import { describe, it, expect, vi } from "vitest";
import { createFileSystemMock, directory } from "../../boundaries/platform/filesystem.state-mock";
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import { createBehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import { GitError } from "../../shared/errors/service-errors";
import { testPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import { createCommitTrees } from "./commit-trees";

const REPO = new Path(testPath("/repo"));
const DIR = new Path(testPath("/data/trees"));
const A = "a".repeat(40);
const B = "b".repeat(40);

function setup() {
  const fileSystem = createFileSystemMock({ entries: { [DIR.toString()]: directory() } });
  const git = createMockGitClient({
    fileSystem,
    repositories: { [REPO.toString()]: { branches: ["main"], currentBranch: "main" } },
  });
  const trees = createCommitTrees({ git, fileSystem, logger: createBehavioralLogger() });
  const exists = (path: Path): boolean => fileSystem.$.entries.has(path.toString());
  return { fileSystem, git, trees, exists };
}

describe("commit trees", () => {
  it("checks a commit out once", async () => {
    const { git, trees } = setup();
    const add = vi.spyOn(git, "addDetachedWorktree");

    const first = await trees.checkout(REPO, DIR, A);
    const second = await trees.checkout(REPO, DIR, A);

    expect(first.equals(new Path(DIR, A))).toBe(true);
    expect(second.equals(first)).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing of a checkout cut short, so the next one tries again", async () => {
    const { git, fileSystem, trees, exists } = setup();
    vi.spyOn(git, "addDetachedWorktree").mockImplementationOnce(async (_repo, tree) => {
      await fileSystem.mkdir(tree);
      throw new GitError("disk full");
    });

    await expect(trees.checkout(REPO, DIR, A)).rejects.toThrow("disk full");
    expect(exists(new Path(DIR, A))).toBe(false);

    await trees.checkout(REPO, DIR, A);
    expect(exists(new Path(DIR, A))).toBe(true);
  });

  it("removes what is neither kept nor leased, and a leased one once released", async () => {
    const { trees, exists } = setup();
    const old = await trees.checkout(REPO, DIR, A);
    await trees.checkout(REPO, DIR, B);
    const onIdle = vi.fn();
    const release = trees.acquire(old, onIdle);

    await trees.prune(REPO, DIR, B);
    expect(exists(old)).toBe(true);
    expect(trees.leased(DIR)).toBe(true);

    release();
    expect(onIdle).toHaveBeenCalledTimes(1);
    await trees.prune(REPO, DIR, B);
    expect(exists(old)).toBe(false);
    expect(exists(new Path(DIR, B))).toBe(true);
  });
});
