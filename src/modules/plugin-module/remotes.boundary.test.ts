// @vitest-environment node
/**
 * Remote plugin sources against real git and a real filesystem: a clone's
 * checkout holds the repository's files, a fetch that lands a new commit
 * switches to a fresh tree, and the old one goes once nothing runs in it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import nodePath from "node:path";
import { simpleGit } from "simple-git";
import { SimpleGitClient } from "../../boundaries/platform/simple-git-client";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { createTempDir, createTestGitRepo } from "../../utils/testing/test-utils";
import { Path } from "../../utils/path/path";
import { createRemoteCheckouts, type RemoteSpec } from "./remotes";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function exists(path: Path): Promise<boolean> {
  try {
    await access(path.toNative());
    return true;
  } catch {
    return false;
  }
}

async function commit(repo: string, file: string, text: string): Promise<string> {
  await mkdir(nodePath.dirname(nodePath.join(repo, file)), { recursive: true });
  await writeFile(nodePath.join(repo, file), text);
  const git = simpleGit(repo);
  await git.add(file);
  await git.commit(`write ${file}`);
  return (await git.revparse(["HEAD"])).trim();
}

describe("remote checkouts, for real", () => {
  it("checks a repository out, then switches to a fetched commit", async () => {
    const source = await createTestGitRepo();
    const data = await createTempDir();
    cleanups.push(source.cleanup, data.cleanup);
    const first = await commit(source.path, "plugins/deploy.yaml", "hooks: {}\n");

    const checkouts = createRemoteCheckouts({
      git: new SimpleGitClient(SILENT_LOGGER),
      fileSystem: new DefaultFileSystemBoundary(SILENT_LOGGER),
      logger: SILENT_LOGGER,
      root: new Path(data.path, "remotes"),
    });
    const spec: RemoteSpec = { key: "acme", url: source.path };

    expect(await checkouts.update(spec)).toMatchObject({ state: "ready", commit: first });
    const tree = (await checkouts.tree(spec))!;
    // Git may check text out with CRLF (Windows), so compare the lines.
    const text = await readFile(new Path(tree, "plugins", "deploy.yaml").toNative(), "utf-8");
    expect(text.replace(/\r\n/g, "\n")).toBe("hooks: {}\n");

    const release = checkouts.acquire(tree);
    const second = await commit(source.path, "plugins/deploy.yaml", "hooks: {}\n# v2\n");
    expect(await checkouts.update(spec)).toMatchObject({ state: "ready", commit: second });
    const next = (await checkouts.tree(spec))!;
    expect(await readFile(new Path(next, "plugins", "deploy.yaml").toNative(), "utf-8")).toContain(
      "# v2"
    );
    // Leased: still there for the script running in it.
    expect(await exists(tree)).toBe(true);

    release();
    await vi.waitFor(async () => expect(await exists(tree)).toBe(false));
    expect(await exists(next)).toBe(true);

    // A pin to the first commit checks it out again, beside nothing stale.
    expect(await checkouts.update({ ...spec, ref: first })).toMatchObject({ commit: first });
  });
});
