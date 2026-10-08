/**
 * Reading and editing `plugins.config`.
 */

import { describe, it, expect } from "vitest";
import { Path } from "../../utils/path/path";
import {
  SourcesConfigError,
  addSourceEntry,
  localSourcePath,
  parseSourcesConfig,
  removeSourceEntry,
} from "./sources";

const FULL = [
  "default:",
  "  config:",
  "    github: {token: ghp_xxx}",
  "work:",
  "  path: ~/work/ch-plugins",
  "acme:",
  "  type: remote",
  "  url: git@github.com:acme/ch-plugins.git",
  "  ref: main",
  "  path: plugins",
  "  config:",
  "    deploy: {region: us, retries: 3, dry-run: false}",
  "codehydra:",
  "  type: project",
  "  config:",
  "    setup: {db-url: postgres://127.0.0.1/dev}",
].join("\n");

describe("parseSourcesConfig", () => {
  it("reads every kind of entry, the default first", () => {
    expect(parseSourcesConfig(FULL)).toEqual([
      { key: "default", type: "local", path: null, values: { github: { token: "ghp_xxx" } } },
      { key: "work", type: "local", path: "~/work/ch-plugins", values: {} },
      {
        key: "acme",
        type: "remote",
        url: "git@github.com:acme/ch-plugins.git",
        ref: "main",
        path: "plugins",
        values: { deploy: { region: "us", retries: 3, "dry-run": false } },
      },
      {
        key: "codehydra",
        type: "project",
        project: "codehydra",
        values: { setup: { "db-url": "postgres://127.0.0.1/dev" } },
      },
    ]);
  });

  it("is just the default folder when empty", () => {
    const only = [{ key: "default", type: "local", path: null, values: {} }];
    expect(parseSourcesConfig("")).toEqual(only);
    expect(parseSourcesConfig("# nothing yet\n")).toEqual(only);
  });

  it("puts the default first wherever it is written", () => {
    const entries = parseSourcesConfig("work:\n  path: /w\ndefault: {}\n");
    expect(entries.map((entry) => entry.key)).toEqual(["default", "work"]);
  });

  it("takes a project entry's project from its key unless it names one", () => {
    const [, entry] = parseSourcesConfig("app:\n  type: project\n  project: /src/app\n");
    expect(entry).toMatchObject({ type: "project", project: "/src/app" });
  });

  it.each([
    ["not a mapping", "- a\n- b\n", /mapping/],
    ["invalid YAML", "a: [\n", /.+/],
    ["a duplicate key", "a: {path: /a}\na: {path: /b}\n", /.+/],
    ["an unusable entry name", "'my plugins': {path: /a}\n", /not a usable entry name/],
    ["an unknown key", "a:\n  path: /a\n  pth: /b\n", /a: unknown key pth/],
    ["an unknown type", "a:\n  type: svn\n", /a\.type/],
    ["a local entry without a folder", "a: {}\n", /a\.path: a local entry needs/],
    ["a relative folder", "a: {path: plugins}\n", /must be absolute or start with ~/],
    ["a folder for the default", "default: {path: /x}\n", /always ~\/\.codehydra\/plugins/],
    ["a default of another type", "default: {type: remote, url: x}\n", /default entry is a local/],
    ["a remote without a URL", "a: {type: remote}\n", /a\.url/],
    [
      "a remote folder leaving it",
      "a: {type: remote, url: x, path: ../up}\n",
      /inside the repository/,
    ],
    [
      "an absolute remote folder",
      "a: {type: remote, url: x, path: /etc}\n",
      /inside the repository/,
    ],
    ["a value that is a list", "a:\n  path: /a\n  config:\n    p: {k: [1]}\n", /a\.config\.p\.k/],
    ["an unusable setting name", "a:\n  path: /a\n  config:\n    p: {'1x': y}\n", /setting names/],
  ])("refuses %s", (_what, text, message) => {
    expect(() => parseSourcesConfig(text)).toThrow(SourcesConfigError);
    expect(() => parseSourcesConfig(text)).toThrow(message);
  });
});

describe("localSourcePath", () => {
  it("expands ~ to the home directory", () => {
    expect(localSourcePath("~/work", "/home/me").equals(new Path("/home/me/work"))).toBe(true);
    expect(localSourcePath("~", "/home/me").equals(new Path("/home/me"))).toBe(true);
    expect(localSourcePath("/opt/p", "/home/me").equals(new Path("/opt/p"))).toBe(true);
  });
});

describe("addSourceEntry / removeSourceEntry", () => {
  const TEXT = "# my plugins\nwork:\n  path: /w # the team's\n";

  it("adds an entry, keeping comments", () => {
    const next = addSourceEntry(TEXT, "acme", { type: "remote", url: "org/repo", ref: "main" });

    expect(next).toContain("# my plugins");
    expect(next).toContain("# the team's");
    expect(parseSourcesConfig(next).map((entry) => entry.key)).toEqual(["default", "work", "acme"]);
  });

  it("adds to empty text, or text that is only comments", () => {
    expect(parseSourcesConfig(addSourceEntry("", "w", { path: "/w" }))).toHaveLength(2);
    const commented = addSourceEntry("# later\n", "w", { path: "/w" });
    expect(commented).toContain("# later");
    expect(parseSourcesConfig(commented)).toHaveLength(2);
  });

  it("refuses a name already taken, and an entry that does not parse", () => {
    expect(() => addSourceEntry(TEXT, "work", { path: "/x" })).toThrow(/already an entry/);
    expect(() => addSourceEntry(TEXT, "x", { path: "relative" })).toThrow(SourcesConfigError);
  });

  it("removes an entry, keeping the rest as written", () => {
    const both = addSourceEntry(TEXT, "acme", { type: "remote", url: "org/repo" });

    const next = removeSourceEntry(both, "acme");

    expect(next).toContain("# the team's");
    expect(parseSourcesConfig(next!).map((entry) => entry.key)).toEqual(["default", "work"]);
    // A comment right above an entry is the entry's, and goes with it…
    expect(removeSourceEntry(TEXT, "work")).toBe("");
    // …one set apart by a blank line is the file's, and stays.
    expect(removeSourceEntry("# header\n\nwork: {path: /w}\n", "work")).toBe("# header\n");
    expect(removeSourceEntry(TEXT, "nope")).toBeUndefined();
  });
});
