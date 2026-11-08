// @vitest-environment node
/**
 * `hasFolder` against real git: it tells a folder from a file and from nothing,
 * in a normal and in a bare repository, and an unknown commit is an error, not
 * "no folder".
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
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

async function repository(): Promise<string> {
  const repo = await createTestGitRepo();
  cleanups.push(repo.cleanup);
  return repo.path;
}

describe("SimpleGitClient.hasFolder", () => {
  const client = new SimpleGitClient(SILENT_LOGGER);

  it("finds a folder a commit holds, nested in another", async () => {
    const repo = await repository();
    const commit = await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    expect(await client.hasFolder(new Path(repo), commit, FOLDER)).toBe(true);
    expect(await client.hasFolder(new Path(repo), commit, ".codehydra")).toBe(true);
  });

  it("answers false for an absent path and for a file", async () => {
    const repo = await repository();
    const commit = await commitFile(repo, ".codehydra/plugins", "a file, not a folder\n");
    expect(await client.hasFolder(new Path(repo), commit, FOLDER)).toBe(false);
    expect(await client.hasFolder(new Path(repo), commit, "missing/folder")).toBe(false);
  });

  it("reads the commit, not the working tree", async () => {
    const repo = await repository();
    const before = await commitFile(repo, "readme.txt", "x\n");
    await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    expect(await client.hasFolder(new Path(repo), before, FOLDER)).toBe(false);
  });

  it("works on a bare clone", async () => {
    const repo = await repository();
    const commit = await commitFile(repo, `${FOLDER}/one.yaml`, "hooks: {}\n");
    const out = await createTempDir();
    cleanups.push(out.cleanup);
    const bare = nodePath.join(out.path, "bare.git");
    await simpleGit().clone(repo, bare, ["--bare"]);
    expect(await client.hasFolder(new Path(bare), commit, FOLDER)).toBe(true);
  });

  it("throws for a commit the repository does not have", async () => {
    const repo = await repository();
    await commitFile(repo, "readme.txt", "x\n");
    await expect(
      client.hasFolder(new Path(repo), "0123456789abcdef0123456789abcdef01234567", FOLDER)
    ).rejects.toThrow();
  });
});
