// @vitest-environment node
/**
 * Remote plugin sources: cloning, fetching, switching trees, and never pulling
 * a tree out from under a script that runs in it.
 */

import { describe, it, expect, vi } from "vitest";
import { createFileSystemMock, directory } from "../../boundaries/platform/filesystem.state-mock";
import { createMockGitClient, fakeCommit } from "../../boundaries/platform/git-client.state-mock";
import { createBehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import { GitError } from "../../shared/errors/service-errors";
import { testPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import {
  createRemoteCheckouts,
  remoteDirName,
  scrubCredentials,
  type RemoteSpec,
  type RemoteStatus,
} from "./remotes";

const ROOT = new Path(testPath("/data/plugins/remotes"));
const URL = "https://example.com/acme/ch-plugins.git";
const ACME: RemoteSpec = { key: "acme", url: URL };
const MAIN = fakeCommit(URL, "main");
const NEXT = "b".repeat(40);

function setup() {
  const fileSystem = createFileSystemMock({ entries: { [ROOT.toString()]: directory() } });
  const git = createMockGitClient({ fileSystem });
  const results: Array<[string, RemoteStatus]> = [];
  const checkouts = createRemoteCheckouts({
    git,
    fileSystem,
    logger: createBehavioralLogger(),
    root: ROOT,
    onResult: (spec, status) => results.push([spec.key, status]),
    now: () => new Date("2026-10-08T10:00:00.000Z"),
  });
  const dir = new Path(ROOT, remoteDirName(ACME));
  const repo = new Path(dir, "repo.git");
  /** What the remote's clone answers for a revision from now on (a fetch landing it). */
  const land = (rev: string, commit: string): void => {
    git.$.repositories.get(repo.toString())!.revisions.set(rev, commit);
  };
  const exists = (path: Path): boolean => fileSystem.$.entries.has(path.toString());
  return { fileSystem, git, checkouts, results, dir, repo, land, exists };
}

describe("remote checkouts", () => {
  it("clones a remote on first update and checks out its default branch", async () => {
    const { checkouts, results, dir, exists, git, repo } = setup();

    const status = await checkouts.update(ACME);

    expect(status).toEqual({ state: "ready", commit: MAIN, fetchedAt: "2026-10-08T10:00:00.000Z" });
    expect(git.$.repositories.get(repo.toString())?.remoteUrl).toBe(URL);
    const tree = await checkouts.tree(ACME);
    expect(tree?.equals(new Path(dir, "trees", MAIN))).toBe(true);
    expect(exists(new Path(dir, "current.json"))).toBe(true);
    expect(results).toEqual([["acme", status]]);
  });

  it("has no tree until a first clone lands, and starts that clone itself", async () => {
    const { checkouts } = setup();

    expect(await checkouts.tree(ACME)).toBeUndefined();
    expect(checkouts.status(ACME)).toEqual({ state: "cloning" });

    await vi.waitFor(() => expect(checkouts.status(ACME)?.state).toBe("ready"));
    expect(await checkouts.tree(ACME)).toBeDefined();
  });

  it("checks out what a branch, a tag or a commit names", async () => {
    const { checkouts, land } = setup();
    await checkouts.update(ACME);
    land("origin/dev", "d".repeat(40));
    land("v1.0", "e".repeat(40));

    expect(await checkouts.update({ ...ACME, ref: "dev" })).toMatchObject({
      commit: "d".repeat(40),
    });
    expect(await checkouts.update({ ...ACME, ref: "v1.0" })).toMatchObject({
      commit: "e".repeat(40),
    });
    expect(await checkouts.update({ ...ACME, ref: MAIN })).toMatchObject({ commit: MAIN });
  });

  it("switches to a fetched commit and removes the old tree once nothing runs in it", async () => {
    const { checkouts, dir, land, exists } = setup();
    await checkouts.update(ACME);
    const old = (await checkouts.tree(ACME))!;
    const release = checkouts.acquire(old);

    land("origin/HEAD", NEXT);
    await checkouts.update(ACME);

    expect((await checkouts.tree(ACME))?.equals(new Path(dir, "trees", NEXT))).toBe(true);
    // A script still runs in the old tree: it stays.
    expect(exists(old)).toBe(true);

    release();
    await vi.waitFor(() => expect(exists(old)).toBe(false));
    expect(exists(new Path(dir, "trees", NEXT))).toBe(true);
  });

  it("keeps the last tree when a fetch fails, and says why", async () => {
    const { checkouts, results } = setup();
    await checkouts.update(ACME);

    const status = await checkouts.update({ ...ACME, ref: "nope" });

    expect(status).toEqual({
      state: "failed",
      message: "nope is not a branch, tag or commit of the repository",
      commit: MAIN,
      fetchedAt: "2026-10-08T10:00:00.000Z",
    });
    expect(results.at(-1)).toEqual(["acme", status]);
    // Still running what it had, not retrying the ref on every read.
    expect(await checkouts.tree({ ...ACME, ref: "nope" })).toBeDefined();
    expect(checkouts.status({ ...ACME, ref: "nope" })?.state).toBe("failed");
  });

  it("reports a clone that fails without the credentials in its URL", async () => {
    const { fileSystem } = setup();
    const git = createMockGitClient({ fileSystem });
    const checkouts = createRemoteCheckouts({
      git: {
        ...git,
        clone: async () => {
          throw new GitError("could not read from https://me:s3cret@example.com/acme.git");
        },
      },
      fileSystem,
      logger: createBehavioralLogger(),
      root: ROOT,
    });

    const status = await checkouts.update(ACME);

    expect(status).toEqual({
      state: "failed",
      message: "could not read from https://example.com/acme.git",
    });
    expect(await checkouts.tree(ACME)).toBeUndefined();
  });

  it("fetches a changed ref in the background, running the old tree meanwhile", async () => {
    const { checkouts, land, dir } = setup();
    await checkouts.update(ACME);
    land("origin/dev", NEXT);

    const during = await checkouts.tree({ ...ACME, ref: "dev" });

    expect(during?.equals(new Path(dir, "trees", MAIN))).toBe(true);
    await vi.waitFor(async () =>
      expect((await checkouts.tree({ ...ACME, ref: "dev" }))?.basename).toBe(NEXT)
    );
  });

  it("does not fetch a commit pin it already has at start", async () => {
    const { checkouts, git } = setup();
    await checkouts.update({ ...ACME, ref: MAIN });
    const fetch = vi.spyOn(git, "fetch");

    checkouts.refresh([{ ...ACME, ref: MAIN }]);
    checkouts.refresh([ACME]);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("removes the directories of remotes no longer configured", async () => {
    const { checkouts, dir, exists } = setup();
    await checkouts.update(ACME);
    const other: RemoteSpec = { key: "other", url: "https://example.com/other.git" };
    await checkouts.update(other);

    await checkouts.forgetOthers([other]);

    expect(exists(dir)).toBe(false);
    expect(exists(new Path(ROOT, remoteDirName(other)))).toBe(true);
  });
});

describe("scrubCredentials", () => {
  it("drops a URL's user and password, leaving the rest", () => {
    expect(scrubCredentials("fatal: https://u:p@h/x and ssh://git@h/y")).toBe(
      "fatal: https://h/x and ssh://h/y"
    );
  });
});
