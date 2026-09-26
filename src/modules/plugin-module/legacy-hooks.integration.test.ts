// @vitest-environment node
/**
 * Turning a worktree's old `.codehydra/hooks` files into a plugin that runs
 * them, keeping the old per-platform file-name rules.
 */

import { describe, it, expect } from "vitest";
import { migrateLegacyHooks } from "./legacy-hooks";
import { documentsFor, parseManifest } from "./manifest";

function hooksOn(manifest: string, platform: NodeJS.Platform): Record<string, string> {
  const docs = documentsFor(parseManifest(manifest), platform);
  return Object.assign({}, ...docs.map((doc) => doc.hooks)) as Record<string, string>;
}

describe("migrateLegacyHooks", () => {
  it("runs each file from its entry, in one bash document for every platform", () => {
    const { manifest } = migrateLegacyHooks(["after-worktree-created", "on-workspace-opened.py"]);

    const [doc, ...rest] = parseManifest(manifest);
    expect(rest).toEqual([]);
    expect(doc).toMatchObject({ shell: "bash", platforms: ["linux", "windows", "macos"] });
    expect(doc?.hooks).toEqual({
      "after-worktree-created": '"$CH_WORKSPACE_DIR/.codehydra/hooks/after-worktree-created"',
      "on-workspace-opened": '"$CH_WORKSPACE_DIR/.codehydra/hooks/on-workspace-opened.py"',
    });
  });

  it("keeps a platform-pinned file on its platform, beating the unsuffixed one there", () => {
    const { manifest } = migrateLegacyHooks([
      "before-workspace-opened",
      "before-workspace-opened.win.cmd",
    ]);

    expect(hooksOn(manifest, "linux")).toEqual({
      "before-workspace-opened": '"$CH_WORKSPACE_DIR/.codehydra/hooks/before-workspace-opened"',
    });
    expect(hooksOn(manifest, "win32")).toEqual({
      "before-workspace-opened":
        'call "%CH_WORKSPACE_DIR%\\.codehydra\\hooks\\before-workspace-opened.win.cmd"',
    });
    const windows = documentsFor(parseManifest(manifest), "win32");
    expect(windows.map((doc) => doc.shell)).toEqual(["cmd"]);
  });

  it("leaves out an entry several files claimed, and says so", () => {
    const migrated = migrateLegacyHooks(["on-workspace-opened.sh", "on-workspace-opened.bak"]);

    expect(hooksOn(migrated.manifest, "linux")).toEqual({});
    expect(migrated.ambiguous[0]).toEqual({
      entry: "on-workspace-opened",
      platform: "linux",
      files: ["on-workspace-opened.bak", "on-workspace-opened.sh"],
    });
  });
});
