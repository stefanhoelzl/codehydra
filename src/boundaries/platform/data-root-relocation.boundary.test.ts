/**
 * relocateDataRoot against a real filesystem: what moves, what stays, and the
 * rollback when an entry cannot be moved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../utils/testing/test-utils";
import { CURRENT_ROOT_STATE_KEY } from "../../modules/workspaces-root/module";
import {
  relocateDataRoot,
  WORKSPACES_CURRENT_STATE_KEY,
  type RelocationFs,
} from "./data-root-relocation";

let temp: { path: string; cleanup: () => Promise<void> };
let from: string;
let to: string;

beforeEach(async () => {
  temp = await createTempDir();
  from = join(temp.path, "Roaming", "Codehydra");
  to = join(temp.path, "Local", "Codehydra");
});

afterEach(async () => {
  await temp.cleanup();
});

/** Write files (relative path → content) under a root. */
function seed(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    nodeFs.mkdirSync(join(path, ".."), { recursive: true });
    nodeFs.writeFileSync(path, content);
  }
}

function read(path: string): string {
  return nodeFs.readFileSync(path, "utf-8");
}

function state(root: string): Record<string, unknown> {
  return JSON.parse(read(join(root, "state.json"))) as Record<string, unknown>;
}

const INSTALL = {
  "config.json": '{"agent":"claude"}',
  "state.json": '{"sidebar.hide-hibernated":true}',
  "logs/app.log": "log",
  "electron/userData/Preferences": "{}",
  "vscodium/1.0/bin": "exe",
  "projects/app-1234/config.json": '{"path":"C:/code/app"}',
  "projects/app-1234/workspaces/feat/file.txt": "source",
  "projects/lib-5678/config.json": '{"remoteUrl":"https://x/lib.git"}',
  "remotes/lib-5678/lib/.git/HEAD": "ref: refs/heads/main",
};

describe("relocateDataRoot", () => {
  it("uses the workspaces-root module's state key", () => {
    expect(WORKSPACES_CURRENT_STATE_KEY).toBe(CURRENT_ROOT_STATE_KEY);
  });

  it("moves everything but the source code, and records where that stayed", () => {
    seed(from, INSTALL);

    const result = relocateDataRoot(from, to);

    expect(result).toEqual({ status: "moved", from, to, sourceCodeKept: true, warnings: [] });
    expect(read(join(to, "config.json"))).toBe('{"agent":"claude"}');
    expect(read(join(to, "logs/app.log"))).toBe("log");
    expect(read(join(to, "electron/userData/Preferences"))).toBe("{}");
    expect(read(join(to, "vscodium/1.0/bin"))).toBe("exe");
    expect(read(join(to, "projects/app-1234/config.json"))).toContain("C:/code/app");
    expect(read(join(to, "projects/lib-5678/config.json"))).toContain("remoteUrl");
    expect(state(to)).toEqual({
      "sidebar.hide-hibernated": true,
      [WORKSPACES_CURRENT_STATE_KEY]: from,
    });

    // Source code stays; the project that had none leaves no directory behind.
    expect(read(join(from, "projects/app-1234/workspaces/feat/file.txt"))).toBe("source");
    expect(nodeFs.existsSync(join(from, "remotes/lib-5678/lib/.git/HEAD"))).toBe(true);
    expect(nodeFs.existsSync(join(to, "remotes"))).toBe(false);
    expect(nodeFs.existsSync(join(to, "projects/app-1234/workspaces"))).toBe(false);
    expect(nodeFs.readdirSync(from).sort()).toEqual(["projects", "remotes"]);
    expect(nodeFs.readdirSync(join(from, "projects"))).toEqual(["app-1234"]);
  });

  it("removes the old folder when no source code stayed", () => {
    seed(from, { "config.json": "{}", "state.json": "{}", "projects/app-1234/config.json": "{}" });

    const result = relocateDataRoot(from, to);

    expect(result).toMatchObject({ status: "moved", sourceCodeKept: false });
    expect(nodeFs.existsSync(from)).toBe(false);
    expect(state(to)).toEqual({});
  });

  it("keeps a workspaces folder the user had chosen", () => {
    seed(from, {
      ...INSTALL,
      "state.json": JSON.stringify({ [WORKSPACES_CURRENT_STATE_KEY]: "D:/devdrive" }),
    });

    relocateDataRoot(from, to);

    expect(state(to)[WORKSPACES_CURRENT_STATE_KEY]).toBe("D:/devdrive");
  });

  it("writes a state file when there was none", () => {
    seed(from, INSTALL);
    nodeFs.rmSync(join(from, "state.json"));

    relocateDataRoot(from, to);

    expect(state(to)).toEqual({ [WORKSPACES_CURRENT_STATE_KEY]: from });
  });

  it("does nothing once the new folder holds state", () => {
    seed(from, INSTALL);
    seed(to, { "state.json": "{}" });

    expect(relocateDataRoot(from, to)).toEqual({ status: "nothing" });
    expect(read(join(from, "config.json"))).toBe('{"agent":"claude"}');
  });

  it("does nothing without an old folder", () => {
    expect(relocateDataRoot(from, to)).toEqual({ status: "nothing" });
    expect(nodeFs.existsSync(to)).toBe(false);
  });

  it("leaves an entry the new folder already has (the launchers' releases)", () => {
    seed(from, { "config.json": "{}", "releases/1.0/app": "old" });
    seed(to, { "releases/1.0/app": "new" });

    const result = relocateDataRoot(from, to);

    expect(result).toMatchObject({ status: "moved" });
    expect(result.status === "moved" && result.warnings).toEqual([
      `Kept ${join(from, "releases")}: ${join(to, "releases")} already exists`,
    ]);
    expect(read(join(to, "releases/1.0/app"))).toBe("new");
    expect(read(join(to, "config.json"))).toBe("{}");
  });

  it("puts everything back when an entry cannot be moved", () => {
    seed(from, INSTALL);
    const fs: RelocationFs = {
      ...nodeFs,
      renameSync: (source, target) => {
        if (String(source).endsWith("logs")) throw new Error("EBUSY: resource busy");
        nodeFs.renameSync(source, target);
      },
    };

    const result = relocateDataRoot(from, to, fs);

    expect(result).toEqual({ status: "failed", from, to, error: "EBUSY: resource busy" });
    expect(read(join(from, "config.json"))).toBe('{"agent":"claude"}');
    expect(read(join(from, "electron/userData/Preferences"))).toBe("{}");
    expect(read(join(from, "state.json"))).toBe('{"sidebar.hide-hibernated":true}');
    expect(nodeFs.existsSync(join(to, "config.json"))).toBe(false);
    expect(nodeFs.existsSync(join(to, "electron"))).toBe(false);
  });

  it("tries the old instance's files first, so a running one blocks before anything moved", () => {
    seed(from, INSTALL);
    const attempted: string[] = [];
    const fs: RelocationFs = {
      ...nodeFs,
      renameSync: (source) => {
        attempted.push(String(source));
        throw new Error("EPERM: operation not permitted");
      },
    };

    expect(relocateDataRoot(from, to, fs)).toMatchObject({ status: "failed" });
    expect(attempted).toEqual([join(from, "electron")]);
  });

  it("copies across volumes and deletes the originals afterwards", () => {
    seed(from, INSTALL);
    const fs: RelocationFs = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
          code: "EXDEV",
        });
      },
    };

    const result = relocateDataRoot(from, to, fs);

    expect(result).toMatchObject({ status: "moved", sourceCodeKept: true, warnings: [] });
    expect(read(join(to, "vscodium/1.0/bin"))).toBe("exe");
    expect(state(to)[WORKSPACES_CURRENT_STATE_KEY]).toBe(from);
    expect(nodeFs.readdirSync(from).sort()).toEqual(["projects", "remotes"]);
  });
});
