// @vitest-environment node
/**
 * Tests for the bundle patches: the generic text-patch engine, the OSC 52
 * clipboard entry it carries, and the registry that runs them.
 *
 * The OSC 52 fixture is the real minified expression from the VSCodium reh-web
 * workbench (1.126.04524) — the patch has to survive the shape it actually ships
 * in, not a tidied-up stand-in.
 */

import { describe, it, expect } from "vitest";

import {
  createFileSystemMock,
  file,
  type MockFileSystemBoundary,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockLogger, type MockLogger } from "../../boundaries/platform/logging";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
import { applyBundlePatches, applyTextPatch, type TextPatch } from "./bundle-patches";

const WRAPPER = "/bundle/node_modules/@parcel/watcher/wrapper.js";
const WORKBENCH = "/bundle/out/vs/code/browser/workbench/workbench.js";

/** The clipboard-addon wiring exactly as the shipped bundle minifies it. */
const REAL_WIRING =
  'this._xtermAddonLoader.importAddon("clipboard").then(b=>{this._store.isDisposed||(this._clipboardAddon=this._instantiationService.createInstance(b,void 0,' +
  '{async readText(y){return g.readText(y==="p"?"selection":"clipboard")},' +
  'async writeText(y,w){return g.writeText(w,y==="p"?"selection":"clipboard")}}),' +
  "this.raw.loadAddon(this._clipboardAddon))});";

/** The normalizeOptions loop the watcher patch anchors on, as shipped. */
const REAL_WRAPPER_LOOP =
  "  if (Array.isArray(ignore)) {\n" +
  "    opts = { ...rest };\n" +
  "\n" +
  "    for (const value of ignore) {\n" +
  "      if (isGlob(value)) {\n";

/** A bundle carrying both patch targets. */
function bundle(workbench: string = REAL_WIRING): MockFileSystemBoundary {
  const fsLayer = createFileSystemMock();
  fsLayer.$.setEntry(WRAPPER, file(REAL_WRAPPER_LOOP));
  fsLayer.$.setEntry(WORKBENCH, file(workbench));
  return fsLayer;
}

/**
 * Deps for a packaged run — a failing patch is logged, never thrown. Tests of the
 * dev-mode escalation pass `isPackaged: false` explicitly.
 */
function deps(
  fsLayer: MockFileSystemBoundary,
  platform: SupportedPlatform = "linux",
  logger: MockLogger = createMockLogger()
) {
  return { fileSystemLayer: fsLayer, logger, platform, isPackaged: true };
}

// =============================================================================
// The OSC 52 clipboard patch, through the registry
// =============================================================================

describe("OSC 52 clipboard patch", () => {
  it("drops the clipboard type from the write path so it reaches navigator.clipboard", async () => {
    const fsLayer = bundle();

    await applyBundlePatches(deps(fsLayer), "/bundle");

    expect(fsLayer).toHaveFileContaining(
      WORKBENCH,
      'async writeText(y,w){return g.writeText(w,y==="p"?"selection":void 0)}'
    );
  });

  it("leaves the read path alone (OSC 52 reads must not reach the real clipboard)", async () => {
    const fsLayer = bundle();

    await applyBundlePatches(deps(fsLayer), "/bundle");

    expect(fsLayer).toHaveFileContaining(
      WORKBENCH,
      'async readText(y){return g.readText(y==="p"?"selection":"clipboard")}'
    );
  });

  it("preserves the primary-selection branch", async () => {
    const fsLayer = bundle();

    await applyBundlePatches(deps(fsLayer), "/bundle");

    expect(fsLayer).toHaveFileContaining(WORKBENCH, '?"selection":void 0');
  });

  it("matches regardless of the minifier's identifiers", async () => {
    const fsLayer = bundle(
      'async writeText($a,$b){return Z.writeText($b,$a==="p"?"selection":"clipboard")}'
    );

    await applyBundlePatches(deps(fsLayer), "/bundle");

    expect(fsLayer).toHaveFile(
      WORKBENCH,
      'async writeText($a,$b){return Z.writeText($b,$a==="p"?"selection":void 0)}'
    );
  });

  it("applies on every platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const fsLayer = bundle();

      await applyBundlePatches(deps(fsLayer, platform), "/bundle");

      expect(fsLayer).toHaveFileContaining(WORKBENCH, '?"selection":void 0');
    }
  });
});

// =============================================================================
// The text-patch engine
// =============================================================================

describe("applyTextPatch", () => {
  /** A patch with the same shape as a real one, over a file we fully control. */
  const GREETING: TextPatch = {
    id: "greeting",
    file: "out/app.js",
    find: /const (\w+)="hello"/g,
    replace: (name) => `const ${name}="goodbye"`,
    applied: /const (\w+)="goodbye"/,
    whenMissing: "the greeting stays wrong",
  };

  function seed(content: string): MockFileSystemBoundary {
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry("/bundle/out/app.js", file(content));
    return fsLayer;
  }

  function patchDeps(fsLayer: MockFileSystemBoundary, logger: MockLogger = createMockLogger()) {
    return { fileSystemLayer: fsLayer, logger };
  }

  it("rewrites every occurrence and reports applied", async () => {
    const fsLayer = seed('const a="hello";const b="hello";');

    expect(await applyTextPatch(patchDeps(fsLayer), "/bundle", GREETING)).toBe("applied");

    expect(fsLayer).toHaveFile("/bundle/out/app.js", 'const a="goodbye";const b="goodbye";');
  });

  it("is idempotent: a second pass detects the patched form and rewrites nothing", async () => {
    const fsLayer = seed('const a="hello";');

    expect(await applyTextPatch(patchDeps(fsLayer), "/bundle", GREETING)).toBe("applied");
    const patched = await fsLayer.readFile("/bundle/out/app.js");

    expect(await applyTextPatch(patchDeps(fsLayer), "/bundle", GREETING)).toBe("already-applied");
    expect(await fsLayer.readFile("/bundle/out/app.js")).toBe(patched);
  });

  it("errors with the consequence and leaves the file untouched when neither shape is found", async () => {
    // Neither the original nor the patched shape: our anchor has drifted from
    // upstream, which is a bug in the patch — an error, not a warning.
    const source = 'const a="bonjour";';
    const fsLayer = seed(source);
    const logger = createMockLogger();

    expect(await applyTextPatch(patchDeps(fsLayer, logger), "/bundle", GREETING)).toBe("not-found");

    expect(fsLayer).toHaveFile("/bundle/out/app.js", source);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("the greeting stays wrong"),
      expect.anything()
    );
  });

  it("does not error when the patch is merely already applied", async () => {
    const fsLayer = seed('const a="goodbye";');
    const logger = createMockLogger();

    expect(await applyTextPatch(patchDeps(fsLayer, logger), "/bundle", GREETING)).toBe(
      "already-applied"
    );

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("errors and reports not-found when the target file is unreadable", async () => {
    const fsLayer = createFileSystemMock();
    const logger = createMockLogger();

    expect(await applyTextPatch(patchDeps(fsLayer, logger), "/bundle", GREETING)).toBe("not-found");

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("unreadable"),
      expect.anything()
    );
  });

  it("stages the rewrite in a temp file and renames it into place", async () => {
    const fsLayer = seed('const a="hello";');

    await applyTextPatch(patchDeps(fsLayer), "/bundle", GREETING);

    // The rename consumed the staging file — a crash mid-write can never leave a
    // truncated bundle file behind.
    await expect(fsLayer.readFile("/bundle/out/app.js.ch-tmp")).rejects.toThrow();
    expect(fsLayer).toHaveFile("/bundle/out/app.js", 'const a="goodbye";');
  });
});

// =============================================================================
// The registry
// =============================================================================

describe("applyBundlePatches", () => {
  it("normalizes the watcher's ignore separators on Windows only", async () => {
    const windows = bundle();
    await applyBundlePatches(deps(windows, "win32"), "/bundle");
    // The loop now normalizes each entry before picomatch/path.resolve sees it.
    expect(windows).toHaveFileContaining(WRAPPER, "const chRawValue of ignore");
    expect(windows).toHaveFileContaining(WRAPPER, 'chRawValue.replace(/\\\\/g, "/")');

    // On POSIX a backslash is a legal filename character and picomatch's escape
    // character, so rewriting it there could change what a glob means.
    const linux = bundle();
    await applyBundlePatches(deps(linux, "linux"), "/bundle");
    expect(linux).toHaveFile(WRAPPER, REAL_WRAPPER_LOOP);
  });

  it("is idempotent across startups: a second pass changes nothing", async () => {
    const fsLayer = bundle();

    await applyBundlePatches(deps(fsLayer, "win32"), "/bundle");
    const workbench = await fsLayer.readFile(WORKBENCH);
    const wrapper = await fsLayer.readFile(WRAPPER);

    await applyBundlePatches(deps(fsLayer, "win32"), "/bundle");

    expect(await fsLayer.readFile(WORKBENCH)).toBe(workbench);
    expect(await fsLayer.readFile(WRAPPER)).toBe(wrapper);
  });

  it("applies the remaining patches when one target is missing", async () => {
    // No wrapper.js — the workbench patch must still land.
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry(WORKBENCH, file(REAL_WIRING));

    await applyBundlePatches(deps(fsLayer, "win32"), "/bundle");

    expect(fsLayer).toHaveFileContaining(WORKBENCH, '?"selection":void 0');
  });

  it("never throws when the bundle is missing entirely", async () => {
    const fsLayer = createFileSystemMock();

    await expect(applyBundlePatches(deps(fsLayer, "win32"), "/bundle")).resolves.toBeUndefined();
  });
});

// =============================================================================
// Failure policy: loud in dev, survivable for users
// =============================================================================

describe("when a patch no longer matches the bundle", () => {
  /** A bundle whose workbench upstream has reshaped past our anchor. */
  function driftedBundle(): MockFileSystemBoundary {
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry(WRAPPER, file(REAL_WRAPPER_LOOP));
    fsLayer.$.setEntry(WORKBENCH, file("async writeText(y,w){return g.setClipboard(w,y)}"));
    return fsLayer;
  }

  it("throws in dev, so whoever bumped VSCODIUM_VERSION cannot miss it", async () => {
    const fsLayer = driftedBundle();

    await expect(
      applyBundlePatches(
        {
          fileSystemLayer: fsLayer,
          logger: createMockLogger(),
          platform: "linux",
          isPackaged: false,
        },
        "/bundle"
      )
    ).rejects.toThrow(/osc52-clipboard/);
  });

  it("names every failing patch, not just the first", async () => {
    // Both targets drifted, on a platform where both patches run.
    const fsLayer = createFileSystemMock();
    fsLayer.$.setEntry(WRAPPER, file("for (const v of ignore) {"));
    fsLayer.$.setEntry(WORKBENCH, file("async writeText(y,w){return g.setClipboard(w,y)}"));

    await expect(
      applyBundlePatches(
        {
          fileSystemLayer: fsLayer,
          logger: createMockLogger(),
          platform: "win32",
          isPackaged: false,
        },
        "/bundle"
      )
    ).rejects.toThrow(/osc52-clipboard, watcher-ignore-separators/);
  });

  it("logs and starts anyway when packaged: a stale anchor must not brick the app", async () => {
    const fsLayer = driftedBundle();
    const logger = createMockLogger();

    await expect(
      applyBundlePatches(
        { fileSystemLayer: fsLayer, logger, platform: "linux", isPackaged: true },
        "/bundle"
      )
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("neither the original nor the patched shape found"),
      expect.anything()
    );
  });

  it("does not throw in dev when every patch applied or was already applied", async () => {
    const fsLayer = bundle();
    const devDeps = {
      fileSystemLayer: fsLayer,
      logger: createMockLogger(),
      platform: "win32" as const,
      isPackaged: false,
    };

    await expect(applyBundlePatches(devDeps, "/bundle")).resolves.toBeUndefined();
    // Second startup: everything is already applied, still no throw.
    await expect(applyBundlePatches(devDeps, "/bundle")).resolves.toBeUndefined();
  });
});
