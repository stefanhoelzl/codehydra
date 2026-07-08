// @vitest-environment node
/**
 * Tests for the watcher forward-slash shim.
 *
 * - Behavioral-mock tests cover discovery, application, idempotency, and the
 *   layouts of both supported distributions (reh-web `@parcel/watcher` at the
 *   bundle root; code-server `@vscode/watcher` under `lib/vscode`).
 * - A real-filesystem test loads the generated shim and proves it rewrites
 *   backslash `ignore` globs to forward slashes (the actual crash fix).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import {
  createFileSystemMock,
  file,
  type MockFileSystemBoundary,
} from "../../boundaries/platform/filesystem.state-mock";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { applyWatcherShim } from "./watcher-shim";

const ORIGINAL = "module.exports = { __original: true };\n";

function deps(fsLayer: MockFileSystemBoundary) {
  return { fileSystemLayer: fsLayer, logger: SILENT_LOGGER };
}

/**
 * Create a mock bundle with a watcher package. The `entries` factory option does
 * not build the directory tree, so seed via `setEntry`, which auto-creates the
 * parent directories the discovery walk relies on.
 */
function bundleWithWatcher(
  nodeModulesDir: string,
  scope: "@parcel" | "@vscode",
  main = "index.js"
): MockFileSystemBoundary {
  const fsLayer = createFileSystemMock();
  const pkgDir = `${nodeModulesDir}/${scope}/watcher`;
  fsLayer.$.setEntry(`${pkgDir}/package.json`, file(JSON.stringify({ name: "watcher", main })));
  fsLayer.$.setEntry(`${pkgDir}/${main}`, file(ORIGINAL));
  return fsLayer;
}

describe("applyWatcherShim (behavioral)", () => {
  it("shims the reh-web @parcel/watcher at the bundle root", async () => {
    const fsLayer = bundleWithWatcher("/bundle/node_modules", "@parcel");

    const applied = await applyWatcherShim(deps(fsLayer), "/bundle");

    expect(applied).toBe(1);
    const pkg = "/bundle/node_modules/@parcel/watcher";
    expect(fsLayer).toHaveFile(`${pkg}/index.orig.js`, ORIGINAL);
    expect(fsLayer).toHaveFileContaining(`${pkg}/index.js`, 'require("./index.orig.js")');
    expect(fsLayer).toHaveFileContaining(`${pkg}/index.js`, "fixIgnore");
  });

  it("shims the code-server @vscode/watcher nested under lib/vscode", async () => {
    const fsLayer = bundleWithWatcher("/bundle/lib/vscode/node_modules", "@vscode");

    const applied = await applyWatcherShim(deps(fsLayer), "/bundle");

    expect(applied).toBe(1);
    const pkg = "/bundle/lib/vscode/node_modules/@vscode/watcher";
    expect(fsLayer).toHaveFile(`${pkg}/index.orig.js`, ORIGINAL);
    expect(fsLayer).toHaveFileContaining(`${pkg}/index.js`, "fixIgnore");
  });

  it("honors a non-default package.json main entry", async () => {
    const fsLayer = bundleWithWatcher("/bundle/node_modules", "@parcel", "lib/watcher.js");

    const applied = await applyWatcherShim(deps(fsLayer), "/bundle");

    expect(applied).toBe(1);
    const pkg = "/bundle/node_modules/@parcel/watcher";
    expect(fsLayer).toHaveFile(`${pkg}/lib/watcher.orig.js`, ORIGINAL);
    expect(fsLayer).toHaveFileContaining(`${pkg}/lib/watcher.js`, 'require("./watcher.orig.js")');
  });

  it("is idempotent: a second pass applies nothing and preserves the original", async () => {
    const fsLayer = bundleWithWatcher("/bundle/node_modules", "@parcel");

    expect(await applyWatcherShim(deps(fsLayer), "/bundle")).toBe(1);
    const pkg = "/bundle/node_modules/@parcel/watcher";
    const shimmed = await fsLayer.readFile(`${pkg}/index.js`);

    expect(await applyWatcherShim(deps(fsLayer), "/bundle")).toBe(0);
    // Original untouched (not double-wrapped) and shim unchanged.
    expect(fsLayer).toHaveFile(`${pkg}/index.orig.js`, ORIGINAL);
    expect(await fsLayer.readFile(`${pkg}/index.js`)).toBe(shimmed);
  });

  it("returns 0 and does not throw when no watcher is present", async () => {
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry("/bundle/bin/code-server", file("#!/bin/sh\n"));

    expect(await applyWatcherShim(deps(fsLayer), "/bundle")).toBe(0);
  });

  it("ignores an @parcel scope that has no watcher package", async () => {
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry("/bundle/node_modules/@parcel/core/index.js", file("x"));

    expect(await applyWatcherShim(deps(fsLayer), "/bundle")).toBe(0);
  });
});

describe("applyWatcherShim (real filesystem)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "watcher-shim-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("rewrites backslash ignore globs to forward slashes at runtime", async () => {
    // A fake watcher whose subscribe echoes back the opts it received, so we can
    // observe what the shim passed through.
    const pkgDir = nodePath.join(tmp, "node_modules", "@parcel", "watcher");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(nodePath.join(pkgDir, "package.json"), JSON.stringify({ main: "index.js" }));
    await fs.writeFile(
      nodePath.join(pkgDir, "index.js"),
      "module.exports = { subscribe: (dir, fn, opts) => opts, unsubscribe: () => {}," +
        " writeSnapshot: () => {}, getEventsSince: () => {} };\n"
    );

    const fsLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
    const applied = await applyWatcherShim(
      { fileSystemLayer: fsLayer, logger: SILENT_LOGGER },
      tmp
    );
    expect(applied).toBe(1);

    const require = createRequire(import.meta.url);
    const watcher = require(pkgDir) as {
      subscribe: (
        dir: string,
        fn: () => void,
        opts: { ignore: unknown[] }
      ) => { ignore: unknown[] };
    };

    const result = watcher.subscribe("C:/ws", () => {}, {
      ignore: ["c:\\users\\stefan\\worktrees\\git-reload\\**", "**\\node_modules\\**", 42],
    });

    // Backslashes normalized to forward slashes; non-string entries untouched.
    expect(result.ignore).toEqual([
      "c:/users/stefan/worktrees/git-reload/**",
      "**/node_modules/**",
      42,
    ]);
  });
});
