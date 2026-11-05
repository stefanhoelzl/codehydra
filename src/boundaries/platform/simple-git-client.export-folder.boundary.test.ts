// @vitest-environment node
/**
 * `exportFolder` against real git: one folder of a commit lands in a directory,
 * from a normal and from a bare repository, and the repository is left as it was.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import nodePath from "node:path";
import { simpleGit } from "simple-git";
import { SimpleGitClient } from "./simple-git-client";
import { SILENT_LOGGER } from "./logging";
import { createTempDir, createTestGitRepo } from "../../utils/testing/test-utils";
import { Path } from "../../utils/path/path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FOLDER = ".codehydra/plugins";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function commitFile(repo: string, file: string, text: string): Promise<string> {
  await mkdir(nodePath.dirname(nodePath.join(repo, file)), { recursive: true });
  await writeFile(nodePath.join(repo, file), text);
  const git = simpleGit(repo);
  await git.add(file);
  await git.commit(`write ${file}`);
  return (await git.revparse(["HEAD"])).trim();
}

async function setup(): Promise<{ repo: string; destination: Path; index: Path }> {
  const repo = await createTestGitRepo();
  const out = await createTempDir();
  cleanups.push(repo.cleanup, out.cleanup);
  const destination = new Path(out.path, "tree");
  await mkdir(destination.toNative());
  return { repo: repo.path, destination, index: new Path(out.path, "index") };
}

describe("SimpleGitClient.exportFolder", () => {
  const client = new SimpleGitClient(SILENT_LOGGER);

  it("writes the folder's files, nested ones too, and nothing else", async () => {
    const { repo, destination, index } = await setup();
    await commitFile(repo, "outside.txt", "no\n");
    await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    const commit = await commitFile(repo, `${FOLDER}/two/plugin.yaml`, "automations: {}\n");

    expect(await client.exportFolder(new Path(repo), commit, FOLDER, destination, index)).toBe(
      true
    );

    expect((await readdir(destination.toNative())).sort()).toEqual(["one.yaml", "two"]);
    const nested = await readFile(new Path(destination, "two", "plugin.yaml").toNative(), "utf-8");
    expect(nested.replace(/\r\n/g, "\n")).toBe("automations: {}\n");
  });

  it("reads the commit, not the working tree", async () => {
    const { repo, destination, index } = await setup();
    const commit = await commitFile(repo, `${FOLDER}/one.yaml`, "committed: 1\n");
    await writeFile(nodePath.join(repo, FOLDER, "one.yaml"), "edited: 1\n");

    await client.exportFolder(new Path(repo), commit, FOLDER, destination, index);

    expect(await readFile(new Path(destination, "one.yaml").toNative(), "utf-8")).toContain(
      "committed"
    );
  });

  it("works on a bare repository", async () => {
    const { repo, destination, index } = await setup();
    const commit = await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    const bare = await createTempDir();
    cleanups.push(bare.cleanup);
    const barePath = nodePath.join(bare.path, "repo.git");
    await simpleGit().clone(repo, barePath, ["--bare"]);

    expect(await client.exportFolder(new Path(barePath), commit, FOLDER, destination, index)).toBe(
      true
    );

    expect(await readdir(destination.toNative())).toEqual(["one.yaml"]);
  });

  it.skipIf(process.platform === "win32")("keeps a script's executable bit", async () => {
    const { repo, destination, index } = await setup();
    await mkdir(nodePath.join(repo, FOLDER), { recursive: true });
    await writeFile(nodePath.join(repo, FOLDER, "run.sh"), "#!/bin/sh\n");
    await chmod(nodePath.join(repo, FOLDER, "run.sh"), 0o755);
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("script");
    const commit = (await git.revparse(["HEAD"])).trim();

    await client.exportFolder(new Path(repo), commit, FOLDER, destination, index);

    const mode = (await stat(new Path(destination, "run.sh").toNative())).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("answers false, writing nothing, when the commit has no such folder", async () => {
    const { repo, destination, index } = await setup();
    const commit = await commitFile(repo, "outside.txt", "no\n");

    expect(await client.exportFolder(new Path(repo), commit, FOLDER, destination, index)).toBe(
      false
    );

    expect(await readdir(destination.toNative())).toEqual([]);
  });

  it("answers false when the path is a file", async () => {
    const { repo, destination, index } = await setup();
    const commit = await commitFile(repo, ".codehydra/plugins", "a file\n");

    expect(await client.exportFolder(new Path(repo), commit, FOLDER, destination, index)).toBe(
      false
    );
  });

  it("leaves the repository's index, HEAD and worktree list alone", async () => {
    const { repo, destination, index } = await setup();
    const commit = await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    await writeFile(nodePath.join(repo, "staged.txt"), "staged\n");
    const git = simpleGit(repo);
    await git.add("staged.txt");
    const before = {
      status: await git.raw(["status", "--porcelain"]),
      head: await git.revparse(["HEAD"]),
      worktrees: await git.raw(["worktree", "list"]),
    };

    await client.exportFolder(new Path(repo), commit, FOLDER, destination, index);

    expect({
      status: await git.raw(["status", "--porcelain"]),
      head: await git.revparse(["HEAD"]),
      worktrees: await git.raw(["worktree", "list"]),
    }).toEqual(before);
  });
});
